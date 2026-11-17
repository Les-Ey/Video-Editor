const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, protocol } = require('electron');

protocol.registerSchemesAsPrivileged([{ scheme: 'media', privileges: { standard: true, secure: true } }]);
app.on('window-all-closed', () => {});

async function runTests() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'splicewright-preview-test-'));
  const project = {
    schemaVersion: '1.0', appName: 'SpliceWright', projectMode: 'standalone', title: 'Preview test',
    format: { width: 640, height: 360, fps: 30, aspectRatio: '16:9' },
    autoDuckMusicUnderDialogue: false, duckingVolumeRatio: 0.25,
    assets: [{ id: 'still', kind: 'image', label: 'Portrait test', relativePath: 'still.svg', durationSeconds: 10 }],
    timeline: { tracks: [{
      id: 'video', type: 'video', name: 'Video', muted: false, volume: 1,
      clips: [{ id: 'still-clip', assetId: 'still', trackId: 'video', label: 'Portrait test',
        timelineStart: 0, sourceIn: 0, sourceOut: 10, volume: 1, imageBackground: 'mottled',
        kenBurns: 'none', fitMode: 'contain' }],
    }], markers: [] },
    sequence: [],
  };
  const preload = path.join(root, 'preload.cjs');
  fs.writeFileSync(preload, `
    const project = ${JSON.stringify(project)};
    const unsubscribe = () => () => {};
    window.spliceWright = {
      getHardwareProfile: async () => ({ tier: 'normal', preferredEncoder: 'libx264', cpuCores: 8 }),
      getLaunchProjectFolder: async () => 'fixture',
      openProjectFolder: async () => ({ projectRoot: 'fixture', project, aiMovieStatus: { exists: false } }),
      onAiMovieUpdated: unsubscribe, onExportProgress: unsubscribe,
      onProjectManifestExternalUpdate: unsubscribe, onDualMonitorStateChanged: unsubscribe,
      saveProject: async (_root, value) => { window.savedFixture = value; return { savedPath: 'fixture' }; },
    };
  `);
  protocol.handle('media', () => new Response(
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="240"><rect width="120" height="240" fill="red"/></svg>',
    { headers: { 'content-type': 'image/svg+xml' } }
  ));
  const window = new BrowserWindow({
    width: 1108, height: 665, show: false,
    webPreferences: { preload, contextIsolation: false, sandbox: false, backgroundThrottling: false },
  });
  const execute = (script) => window.webContents.executeJavaScript(script);
  const waitFor = async (condition) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await execute(condition)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for preview: ${condition}`);
  };
  try {
    await window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
    await waitFor(`(() => {
      const image = document.querySelector('img[alt="Portrait test"]');
      return image && image.naturalWidth === 120 && image.style.width !== '100%';
    })()`);
    for (const [width, height] of [[1108, 665], [800, 1000], [1600, 600]]) {
      window.setContentSize(width, height);
      for (const [format, ratio] of [['16:9', 16 / 9], ['9:16', 9 / 16], ['1:1', 1], ['21:9', 2560 / 1080]]) {
        await execute(`(() => {
          const select = document.querySelector('select[title="Project Aspect Ratio & Output Resolution"]');
          select.value = ${JSON.stringify(format)};
          select.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        await waitFor(`document.querySelector('select[title="Project Aspect Ratio & Output Resolution"]').value === ${JSON.stringify(format)}`);
        const sizes = await execute(`(() => {
          const frame = document.querySelector('[title="Double-click or press F to toggle Full Screen"] > div').getBoundingClientRect();
          const image = document.querySelector('img[alt="Portrait test"]').getBoundingClientRect();
          return { frame: frame.width / frame.height, image: image.width / image.height };
        })()`);
        assert.ok(Math.abs(sizes.frame / ratio - 1) < 0.01, `${width}x${height} / ${format}: frame ratio ${sizes.frame}`);
        assert.ok(Math.abs(sizes.image / 0.5 - 1) < 0.03, `${width}x${height} / ${format}: image ratio ${sizes.image}`);
      }
    }
    await execute(`Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Add Text').click()`);
    await waitFor(`!!document.querySelector('[aria-label="Enable text background"]')`);
    assert.equal(await execute(`document.querySelector('[aria-label="Enable text background"]').checked`), false);
    await execute(`document.querySelector('[aria-label="Enable text background"]').click()`);
    await waitFor(`!!document.querySelector('[aria-label="Text background transparency"]')`);
    await execute(`(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      for (const [label, value] of [['Text background colour', '#cc4488'], ['Text background transparency', '25']]) {
        const input = document.querySelector('[aria-label="' + label + '"]');
        setValue.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()`);
    await execute(`Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Save').click()`);
    await waitFor(`!!window.savedFixture`);
    const background = await execute(`window.savedFixture.timeline.tracks.find(track => track.type === 'text').clips[0].textOverlay.background`);
    assert.deepEqual(background, { color: '#cc4488', opacity: 0.75 });
    await execute(`document.querySelector('[aria-label="Enable text background"]').click()`);
    await execute(`Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Save').click()`);
    assert.equal(await execute(`window.savedFixture.timeline.tracks.find(track => track.type === 'text').clips[0].textOverlay.background`), undefined);
    console.log('PASS: monitor and still aspect ratios across window/project sizes; text background controls and save');
  } finally {
    window.destroy();
    protocol.unhandle('media');
    fs.rmSync(root, { recursive: true, force: true });
  }
}

app.whenReady().then(runTests).then(() => app.exit(0), (error) => {
  console.error(error);
  app.exit(1);
});
