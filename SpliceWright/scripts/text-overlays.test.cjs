const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { app } = require('electron');
const { addTextClip, getTextClips, getTextPosition } = require('../dist-electron/shared/textOverlay');
const { renderTextOverlayBitmaps } = require('../dist-electron/electron/textOverlayRenderer');
const { computeAudioTimelineSignature, generateSrtContent, renderProjectWithFfmpeg } =
  require('../dist-electron/electron/ffmpegEngine');
const { saveVideoProjectManifest, loadProjectFromFolder } = require('../dist-electron/electron/projectManager');
const { getFfmpegPath } = require('../dist-electron/electron/hardware');

app.on('window-all-closed', () => {});

function ffmpeg(args) {
  const result = spawnSync(getFfmpegPath(), ['-v', 'error', ...args], { maxBuffer: 32 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
}

function legacyProject() {
  return {
    schemaVersion: '1.0', appName: 'SpliceWright', projectMode: 'standalone',
    title: 'Text overlay regression', updatedAt: new Date().toISOString(),
    format: { width: 320, height: 180, fps: 10, aspectRatio: '16:9' },
    autoDuckMusicUnderDialogue: false, duckingVolumeRatio: 0.25, lookPreset: 'monochrome',
    assets: [
      { id: 'still', kind: 'image', label: 'Still', relativePath: 'still.bmp', durationSeconds: 1.5, source: 'user-imported' },
      { id: 'video', kind: 'video', label: 'Video', relativePath: 'video.mp4', durationSeconds: 1.5, source: 'user-imported' },
      { id: 'dialogue', kind: 'dialogue', label: 'Dialogue', relativePath: 'missing.mp3',
        dialogueText: 'Dialogue captions stay separate.', durationSeconds: 1, source: 'user-imported' },
    ],
    timeline: {
      tracks: [
        { id: 'track_video_main', type: 'video', name: 'Video', muted: false, volume: 1, clips: [
          { id: 'still-clip', assetId: 'still', trackId: 'track_video_main', label: 'Still', timelineStart: 0,
            sourceIn: 0, sourceOut: 1.5, volume: 1, kenBurns: 'zoom-in' },
          { id: 'video-clip', assetId: 'video', trackId: 'track_video_main', label: 'Video', timelineStart: 1.5,
            sourceIn: 0, sourceOut: 1.5, volume: 1 },
        ] },
        { id: 'dialogue-track', type: 'dialogue', name: 'Dialogue', muted: false, volume: 1, clips: [
          { id: 'dialogue-clip', assetId: 'dialogue', trackId: 'dialogue-track', label: 'Dialogue',
            timelineStart: 0, sourceIn: 0, sourceOut: 1, volume: 1 },
        ] },
      ],
      markers: [],
    },
    sequence: [],
  };
}

async function runTests() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'splicewright-text-test-'));
  try {
    const original = legacyProject();
    const originalSnapshot = structuredClone(original);
    let project = addTextClip(original, 0.5, 'title');
    let title = getTextClips(project)[0];
    title.sourceOut = 2;
    title.textOverlay = {
      ...title.textOverlay, text: "Title: 50% ' \\ \nUnicode \u00e9 \u65e5\u672c", fontSize: 22,
      color: '#20ee80', x: 0.123, y: 0.083,
    };
    project.timeline.tracks.find((track) => track.type === 'text').clips[0] = title;
    assert.deepEqual(original, originalSnapshot, 'adding text must not mutate old projects');
    assert.deepEqual(project.assets, original.assets, 'text must not add or modify media assets');
    assert.equal(computeAudioTimelineSignature(project), computeAudioTimelineSignature(original),
      'text edits do not invalidate the audio mix');
    assert.equal(generateSrtContent(project), generateSrtContent(original), 'text is never exported as SRT');
    assert.ok(!generateSrtContent(project).includes('Title:'), 'SRT contains dialogue only');
    const second = addTextClip(project, 2.8, 'second');
    assert.equal(second.timeline.tracks.filter((track) => track.type === 'text').length, 1);
    assert.equal(getTextClips(second)[1].sourceOut, 0.25, 'new text respects a short remaining visual');
    console.log('PASS: non-destructive text creation, timing, legacy projects, and subtitle/audio separation');

    ffmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x180,drawbox=x=160:y=100:w=60:h=60:color=red:t=fill',
      '-frames:v', '1', path.join(root, 'still.bmp')]);
    ffmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=0x202020:s=320x180:r=10:d=1.5,drawbox=x=220:y=110:w=40:h=40:color=blue:t=fill',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(root, 'video.mp4')]);
    const sourceBefore = fs.readFileSync(path.join(root, 'still.bmp'));
    saveVideoProjectManifest(root, project);
    const loaded = await loadProjectFromFolder(root);
    assert.deepEqual(getTextClips(loaded.project), getTextClips(project),
      'text, style, position, and timing survive save/load and media reconciliation');
    assert.ok(!getTextClips(loaded.project)[0].missingMedia, 'generated text is not missing media');
    const bitmaps = await renderTextOverlayBitmaps([title.textOverlay], 320, 180);
    assert.ok(bitmaps[0].width > 10 && bitmaps[0].height > 10);
    const { x, y } = getTextPosition(title.textOverlay, bitmaps[0], 320, 180);
    assert.deepEqual(getTextPosition({ ...title.textOverlay, x: -1, y: 2 }, bitmaps[0], 320, 180),
      { x: 0, y: 180 - bitmaps[0].height }, 'visual positions are clamped inside the frame');
    await assert.rejects(() => renderTextOverlayBitmaps([{ ...title.textOverlay, color: 'invalid' }], 320, 180),
      /Invalid text overlay/);
    console.log('PASS: overlay save/load, generated-media handling, multiline Unicode rasterization, and bounds');

    const { outputPath } = await renderProjectWithFfmpeg(root, project, {
      outputFileName: 'text-over-still-and-video.mp4', preset: 'fast-draft', encoder: 'libx264',
      burnSubtitles: false, exportSrtFile: true,
    }, () => {});
    const raw = ffmpeg(['-i', outputPath, '-an', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
    const pngPath = path.join(root, 'expected-overlay.png');
    fs.writeFileSync(pngPath, Buffer.from(bitmaps[0].dataUrl.split(',')[1], 'base64'));
    const expected = ffmpeg(['-i', pngPath, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1']);
    const green = (buffer, offset) => buffer[offset] < 100 && buffer[offset + 1] > 150 && buffer[offset + 2] < 190;
    const frameSize = 320 * 180 * 3;
    assert.equal(raw.length, frameSize * 30, 'overlays preserve timeline duration and FPS');
    const greenCount = (frame) => {
      let count = 0;
      for (let i = 0; i < frame.length; i += 3) if (green(frame, i)) count++;
      return count;
    };
    for (const index of [0, 4, 25, 29]) {
      assert.equal(greenCount(raw.subarray(index * frameSize, (index + 1) * frameSize)), 0,
        `overlay is absent outside [start, end), frame ${index}`);
    }
    for (const index of [5, 9, 14, 16, 24]) {
      const frame = raw.subarray(index * frameSize, (index + 1) * frameSize);
      let intersection = 0;
      let union = 0;
      for (let py = 0; py < 180; py++) {
        for (let px = 0; px < 320; px++) {
          const bx = px - x;
          const by = py - y;
          const offset = (by * bitmaps[0].width + bx) * 4;
          const wanted = bx >= 0 && by >= 0 && bx < bitmaps[0].width && by < bitmaps[0].height &&
            expected[offset + 3] > 180 && green(expected, offset);
          const actual = green(frame, (py * 320 + px) * 3);
          if (wanted && actual) intersection++;
          if (wanted || actual) union++;
        }
      }
      assert.ok(intersection / union > 0.88,
        `frame ${index}: exported glyphs, colour, and screen position match the preview bitmap (${intersection / union})`);
    }
    assert.deepEqual(fs.readFileSync(path.join(root, 'still.bmp')), sourceBefore, 'source still remains unchanged');
    assert.equal(fs.readFileSync(outputPath.replace(/\.mp4$/, '.srt'), 'utf8'), generateSrtContent(project));

    const withBackground = structuredClone(project);
    const backgroundTitle = withBackground.timeline.tracks.find((track) => track.type === 'text').clips[0];
    backgroundTitle.textOverlay.background = { color: '#2040c0', opacity: 0.5 };
    saveVideoProjectManifest(root, withBackground);
    assert.deepEqual(getTextClips((await loadProjectFromFolder(root)).project)[0].textOverlay.background,
      backgroundTitle.textOverlay.background, 'background colour and opacity survive save/load');
    const variants = await renderTextOverlayBitmaps([
      title.textOverlay,
      backgroundTitle.textOverlay,
      { ...backgroundTitle.textOverlay, background: { color: '#2040c0', opacity: 0 } },
      { ...backgroundTitle.textOverlay, background: { color: '#2040c0', opacity: 1 } },
    ], 320, 180);
    const corner = (bitmap, index) => {
      const file = path.join(root, `background-${index}.png`);
      fs.writeFileSync(file, Buffer.from(bitmap.dataUrl.split(',')[1], 'base64'));
      return [...ffmpeg(['-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1']).subarray(0, 4)];
    };
    assert.equal(corner(variants[0], 0)[3], 0, 'old text has no background');
    const half = corner(variants[1], 1);
    assert.ok(half.every((value, i) => Math.abs(value - [32, 64, 192, 128][i]) <= 1),
      'half-opaque coloured box is rendered behind text');
    assert.equal(corner(variants[2], 2)[3], 0, '100% transparency removes the box');
    assert.deepEqual(corner(variants[3], 3), [32, 64, 192, 255], '0% transparency makes the box opaque');
    await assert.rejects(() => renderTextOverlayBitmaps([
      { ...title.textOverlay, background: { color: '#000000', opacity: 2 } },
    ], 320, 180), /Invalid text overlay/);
    const backgroundExport = await renderProjectWithFfmpeg(root, withBackground, {
      outputFileName: 'text-background.mp4', preset: 'fast-draft', encoder: 'libx264',
      burnSubtitles: false, exportSrtFile: false,
    }, () => {});
    const backgroundRaw = ffmpeg(['-i', backgroundExport.outputPath, '-an', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
    const cornerOffset = ((y + 2) * 320 + x + 2) * 3;
    for (const index of [5, 14, 16, 24]) {
      const offset = index * frameSize + cornerOffset;
      assert.ok(backgroundRaw[offset + 2] > backgroundRaw[offset] + 45,
        `frame ${index}: the coloured background is visible over stills and video ` +
        `(${[...backgroundRaw.subarray(offset, offset + 3)]})`);
      for (let channel = 0; channel < 3; channel++) {
        const expectedChannel = (raw[offset + channel] + [32, 64, 192][channel]) / 2;
        assert.ok(Math.abs(backgroundRaw[offset + channel] - expectedChannel) < 25,
          `frame ${index}: exported background transparency matches the preview`);
      }
    }
    for (const index of [0, 4, 25, 29]) {
      const offset = index * frameSize + cornerOffset;
      assert.ok(Math.abs(backgroundRaw[offset + 2] - backgroundRaw[offset]) < 12,
        `frame ${index}: the background is absent outside the overlay duration`);
    }
    console.log('PASS: optional text background transparency, persistence, and MP4 timing');
    const textTrack = project.timeline.tracks.find((track) => track.type === 'text');
    textTrack.muted = true;
    assert.deepEqual(getTextClips(project), [], 'hidden text tracks are excluded from preview and export');
    console.log('PASS: actual MP4 timing and stationary text over animated stills/video, matching glyphs/colour, and independent SRT');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

app.whenReady().then(runTests).then(() => app.exit(0), (error) => {
  console.error(error);
  app.exit(1);
});
