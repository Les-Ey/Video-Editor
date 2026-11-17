const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { renderProjectWithFfmpeg } = require('../dist-electron/electron/ffmpegEngine');
const { getFfmpegPath } = require('../dist-electron/electron/hardware');
const { createMottledBackgroundBmp } = require('../dist-electron/shared/imageBackground');

function ffmpeg(args) {
  const result = spawnSync(getFfmpegPath(), ['-v', 'error', ...args], { maxBuffer: 16 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
}

function makeProject(width, height, imageBackground, kenBurns, fitMode = 'contain') {
  return {
    schemaVersion: '1.0', appName: 'SpliceWright', projectMode: 'standalone',
    title: 'Image background regression', updatedAt: new Date().toISOString(),
    format: { width, height, fps: 10, aspectRatio: `${width}:${height}` },
    autoDuckMusicUnderDialogue: false, duckingVolumeRatio: 0.25,
    assets: [{
      id: 'image', kind: 'image', label: 'Still', relativePath: 'still.bmp',
      durationSeconds: 1, source: 'user-imported',
    }],
    timeline: {
      tracks: [{
        id: 'video', type: 'video', name: 'Video', muted: false, volume: 1,
        clips: [{
          id: 'clip', assetId: 'image', trackId: 'video', label: 'Still',
          timelineStart: 0, sourceIn: 0, sourceOut: 1, volume: 1,
          imageBackground, kenBurns, fitMode,
        }],
      }],
      markers: [],
    },
    sequence: [],
  };
}

function pixel(frame, width, x, y) {
  const offset = (y * width + x) * 3;
  return [...frame.subarray(offset, offset + 3)];
}

test('image backgrounds export behind still-only motion without making real black transparent', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'splicewright-background-test-'));
  try {
    const writeStill = (width, height) => {
      const source = new Uint8Array(54 + width * height * 3);
      source.set(createMottledBackgroundBmp().subarray(0, 54));
      const header = new DataView(source.buffer);
      header.setUint32(2, source.length, true);
      header.setInt32(18, width, true);
      header.setInt32(22, -height, true);
      header.setUint32(34, width * height * 3, true);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const offset = 54 + (y * width + x) * 3;
          const black = x > width * 0.34 && x < width * 0.66 &&
            y > height * 0.34 && y < height * 0.66;
          source[offset] = black ? 0 : 25;
          source[offset + 1] = black ? 0 : 35;
          source[offset + 2] = black ? 0 : 150 + Math.round(y / height * 60);
        }
      }
      fs.writeFileSync(path.join(root, 'still.bmp'), source);
    };
    const cases = [
      { background: 'mottled', motion: 'zoom-in', width: 320, height: 180 },
      { background: 'softened', motion: 'zoom-out', width: 180, height: 320 },
      { background: 'mottled', motion: 'pan-left-to-right', width: 320, height: 180 },
      { background: 'softened', motion: 'pan-top-to-bottom', width: 180, height: 320 },
      { background: 'black', motion: 'none', width: 320, height: 180 },
      { background: undefined, motion: 'zoom-in', width: 320, height: 180 },
    ];
    for (const [index, item] of cases.entries()) {
      await t.test(`${item.background || 'legacy black'} / ${item.motion} / ${item.width}x${item.height}`, async () => {
        writeStill(item.width > item.height ? 120 : 240, item.width > item.height ? 240 : 120);
        const project = makeProject(item.width, item.height, item.background, item.motion);
        const { outputPath } = await renderProjectWithFfmpeg(root, project, {
          outputFileName: `case-${index}.mp4`, preset: 'fast-draft', encoder: 'libx264',
          burnSubtitles: false, exportSrtFile: false,
        }, () => {});
        const raw = ffmpeg(['-i', outputPath, '-an', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
        const frameSize = item.width * item.height * 3;
        assert.equal(raw.length, frameSize * 10, 'exports the full clip at the requested frame rate');
        const first = raw.subarray(0, frameSize);
        const last = raw.subarray(raw.length - frameSize);
        const backdropStart = pixel(first, item.width, 4, 4);
        const backdropEnd = pixel(last, item.width, 4, 4);
        for (let c = 0; c < 3; c++) {
          assert.ok(Math.abs(backdropStart[c] - backdropEnd[c]) <= 6, 'backdrop stays stationary');
        }
        if (item.background === 'mottled') {
          assert.ok(backdropStart.every((v) => v > 10 && v < 65), 'visible subtle mottled background');
        } else if (item.background === 'softened') {
          assert.ok(backdropStart[0] > backdropStart[1] + 20, 'soft background uses this still, not black');
        } else {
          assert.ok(backdropStart.every((v) => v < 8), 'existing black framing is preserved');
        }
        const centerX = item.motion === 'pan-left-to-right' ? 0.61 : 0.5;
        const centerY = item.motion === 'pan-top-to-bottom' ? 0.62 : 0.5;
        const center = pixel(first, item.width,
          Math.round(item.width * centerX), Math.round(item.height * centerY));
        assert.ok(center.every((v) => v < 12), 'real black pixels in the original remain opaque');
        if (item.motion !== 'none') {
          let changed = 0;
          for (let i = 0; i < first.length; i += 3) {
            if (Math.abs(first[i] - last[i]) > 25) changed++;
          }
          assert.ok(changed > item.width * item.height * 0.01, 'foreground really moves');
        }
      });
    }
    await t.test('background choices preserve the foreground aspect ratio unless stretch is selected', async () => {
      for (const [width, height, imageWidth, imageHeight] of [
        [320, 180, 120, 240],
        [180, 320, 240, 120],
      ]) {
        writeStill(imageWidth, imageHeight);
        for (const [background, fit] of [
          ['black', 'contain'],
          ['mottled', 'contain'],
          ['softened', 'contain'],
          ['mottled', 'stretch-fill'],
        ]) {
          const project = makeProject(width, height, background, 'none', fit);
          const { outputPath } = await renderProjectWithFfmpeg(root, project, {
            outputFileName: `aspect-${width}-${background}-${fit}.mp4`,
            preset: 'fast-draft', encoder: 'libx264', burnSubtitles: false, exportSrtFile: false,
          }, () => {});
          const frame = ffmpeg(['-i', outputPath, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
          let minX = width, minY = height, maxX = -1, maxY = -1;
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              const [r, g, b] = pixel(frame, width, x, y);
              if (r > 130 && r > g * 1.8 && r > b * 1.8) {
                minX = Math.min(minX, x);
                maxX = Math.max(maxX, x);
                minY = Math.min(minY, y);
                maxY = Math.max(maxY, y);
              }
            }
          }
          assert.ok(maxX >= minX && maxY >= minY, 'foreground remains visible');
          const actualRatio = (maxX - minX + 1) / (maxY - minY + 1);
          const expectedRatio = fit === 'stretch-fill' ? width / height : imageWidth / imageHeight;
          assert.ok(Math.abs(actualRatio / expectedRatio - 1) < 0.05,
            `${background} / ${fit} foreground ratio ${actualRatio} should be ${expectedRatio}`);
        }
      }
    });
    await t.test('background export supports document framing and perspective crawl', async () => {
      writeStill(120, 240);
      const combinations = [
        ['fill-width', 'pan-top-to-bottom'],
        ['fill-height', 'pan-right-to-left'],
        ['cover-crop', 'zoom-in-top-left'],
        ['stretch-fill', 'zoom-in-bottom'],
        ['contain', 'star-wars-crawl'],
      ];
      for (const [fit, motion] of combinations) {
        const project = makeProject(180, 320, 'mottled', motion, fit);
        const { outputPath } = await renderProjectWithFfmpeg(root, project, {
          outputFileName: `${fit}-${motion}.mp4`, preset: 'fast-draft', encoder: 'libx264',
          burnSubtitles: false, exportSrtFile: false,
        }, () => {});
        assert.ok(fs.statSync(outputPath).size > 1000, `${fit} / ${motion} renders successfully`);
      }
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
