const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  buildProjectFromAiMovie, mergeNewAssetsFromAiMovie, rebuildProjectFromAiMovie,
  saveVideoProjectManifest, loadProjectFromFolder, computeAiMovieSyncSummary,
} = require('../dist-electron/electron/projectManager');
const { addTextClip, getTextClips } = require('../dist-electron/shared/textOverlay');
const { getClipTimelineDuration } = require('../dist-electron/shared/types');

async function fixture(scenes, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'splicewright-studio-text-test-'));
  const movie = { title: 'Studio default text', options: { aspectRatio: '16:9' }, scenes };
  const writeMovie = () => fs.writeFileSync(path.join(root, 'ai-movie.json'), JSON.stringify(movie));
  try {
    writeMovie();
    await run({ root, movie, writeMovie, project: await buildProjectFromAiMovie(root, movie) });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assertSpansScene(project, clip) {
  const visuals = project.timeline.tracks.find((track) => track.type === 'video').clips
    .filter((visual) => visual.sceneId === clip.sceneId);
  const start = Math.min(...visuals.map((visual) => visual.timelineStart));
  const end = Math.max(...visuals.map((visual) => visual.timelineStart + getClipTimelineDuration(visual)));
  assert.equal(clip.timelineStart, start);
  assert.equal(getClipTimelineDuration(clip), Math.round((end - start) * 100) / 100);
}

test('imports multiline scene defaults once for the complete scene; skips missing and blank defaults', async () => {
  await fixture([
    { id: 'one', title: 'No default', durationSeconds: 2 },
    { id: 'two', title: 'Multiline', durationSeconds: 7.25, defaultTextOverlay: 'First line\nSecond line' },
    { id: 'three', title: 'Blank', durationSeconds: 3, defaultTextOverlay: ' \r\n\t ' },
  ], async ({ root, movie, project }) => {
    project = (await loadProjectFromFolder(root)).project;
    assert.equal(getTextClips(project).length, 1);
    const clip = getTextClips(project)[0];
    assert.equal(clip.textOverlay.text, movie.scenes[1].defaultTextOverlay);
    assertSpansScene(project, clip);
    assert.deepEqual(project.studioTextOverlayDefaultsApplied, ['two']);
    const source = fs.readFileSync(path.join(root, 'ai-movie.json'), 'utf8');
    project = await mergeNewAssetsFromAiMovie(root, project);
    project = await mergeNewAssetsFromAiMovie(root, project);
    assert.equal(getTextClips(project).length, 1, 'repeated sync never duplicates text');
    assert.equal(fs.readFileSync(path.join(root, 'ai-movie.json'), 'utf8'), source, 'Studio manifest is read-only');
  });
});

test('sync imports newly provided defaults but preserves editor text, style, position, timing, and manual overlays', async () => {
  await fixture([{ id: 'one', title: 'Scene', durationSeconds: 8 }], async ({ root, movie, writeMovie, project }) => {
    assert.equal(project.studioTextOverlayDefaultsApplied, undefined);
    project = addTextClip(project, 0, 'manual-title');
    movie.scenes[0].defaultTextOverlay = 'New Studio default\nLine two';
    writeMovie();
    const summary = await computeAiMovieSyncSummary(root, project);
    assert.equal(summary.hasChanges, true);
    assert.equal(summary.newTextOverlaysCount, 1, 'new text alone must enable the sync notification');
    project = await mergeNewAssetsFromAiMovie(root, project);
    const textTrack = project.timeline.tracks.find((track) => track.type === 'text');
    const seeded = textTrack.clips.find((clip) => clip.sceneId === 'one');
    assertSpansScene(project, seeded);
    seeded.textOverlay = { ...seeded.textOverlay, text: 'Editor owns this', color: '#123456',
      fontFamily: 'serif', fontSize: 45, x: 0.3, y: 0.4 };
    seeded.timelineStart = 0.75;
    seeded.sourceOut = 2.5;
    const editedTrack = structuredClone(textTrack);
    movie.scenes[0].defaultTextOverlay = 'Changed Studio default';
    writeMovie();
    project = await mergeNewAssetsFromAiMovie(root, project);
    assert.deepEqual(project.timeline.tracks.find((track) => track.type === 'text'), editedTrack);
    assert.equal((await computeAiMovieSyncSummary(root, project)).newTextOverlaysCount, undefined);
    saveVideoProjectManifest(root, project);
    const reloaded = await loadProjectFromFolder(root);
    assert.deepEqual(reloaded.project.timeline.tracks.find((track) => track.type === 'text'), editedTrack);
    const rebuilt = await rebuildProjectFromAiMovie(root, reloaded.project);
    assert.deepEqual(rebuilt.timeline.tracks.filter((track) => track.type === 'text'), [editedTrack],
      'explicit Studio rebuild preserves editor-owned overlays without duplicating defaults');
  });
});

test('deleted defaults stay deleted after changed defaults, sync, save/reopen, and rebuild', async () => {
  await fixture([{ id: 'one', title: 'Scene', durationSeconds: 6, defaultTextOverlay: 'Delete me' }],
    async ({ root, movie, writeMovie, project }) => {
      project.timeline.tracks.find((track) => track.type === 'text').clips = [];
      movie.scenes[0].defaultTextOverlay = 'Do not resurrect this';
      writeMovie();
      project = await mergeNewAssetsFromAiMovie(root, project);
      assert.deepEqual(getTextClips(project), []);
      saveVideoProjectManifest(root, project);
      project = (await loadProjectFromFolder(root)).project;
      assert.deepEqual(getTextClips(project), []);
      project = await rebuildProjectFromAiMovie(root, project);
      assert.deepEqual(getTextClips(project), []);
      assert.deepEqual(project.studioTextOverlayDefaultsApplied, ['one']);
    });
});

test('older movies and editor projects remain unchanged without defaults; old editor state can seed a later default once', async () => {
  await fixture([{ id: 'one', title: 'Old scene', durationSeconds: 4 }], async ({ root, movie, writeMovie, project }) => {
    saveVideoProjectManifest(root, project);
    const oldTracks = JSON.parse(JSON.stringify(project.timeline.tracks));
    project = (await loadProjectFromFolder(root)).project;
    assert.deepEqual(project.timeline.tracks, oldTracks, 'old timelines without a text track load unchanged');
    assert.deepEqual(getTextClips(project), []);
    assert.equal('studioTextOverlayDefaultsApplied' in project, false);
    project = addTextClip(project, 0, 'existing-editor-text');
    saveVideoProjectManifest(root, project);
    const originalTracks = JSON.parse(JSON.stringify(project.timeline.tracks));
    project = (await loadProjectFromFolder(root)).project;
    assert.deepEqual(project.timeline.tracks, originalTracks);
    assert.equal('studioTextOverlayDefaultsApplied' in project, false, 'no migration/state is added when defaults are absent');
    assert.equal((await computeAiMovieSyncSummary(root, project)).newTextOverlaysCount, undefined);
    movie.scenes[0].defaultTextOverlay = '\r\n  ';
    writeMovie();
    project = await mergeNewAssetsFromAiMovie(root, project);
    assert.equal('studioTextOverlayDefaultsApplied' in project, false, 'blank defaults are not consumed');
    movie.scenes[0].defaultTextOverlay = 'Now available';
    writeMovie();
    project = (await loadProjectFromFolder(root)).project;
    assert.equal(getTextClips(project).length, 2, 'load seeds a new default without changing existing text');
    project = (await loadProjectFromFolder(root)).project;
    assert.equal(getTextClips(project).length, 2, 'the seeded state is persisted immediately');
    delete movie.scenes[0].defaultTextOverlay;
    writeMovie();
    const before = structuredClone(getTextClips(project));
    project = await mergeNewAssetsFromAiMovie(root, project);
    assert.deepEqual(getTextClips(project), before, 'removing the Studio default does not remove editor-owned text');
  });
});
