import fs from 'fs';
import path from 'path';
import {
  AiMovieAudioAsset,
  AiMovieManifest,
  AiMovieScene,
  AiMovieSyncSummary,
  AiMovieVideoTake,
  getClipTimelineDuration,
  KenBurnsPreset,
  LoadedProjectBundle,
  MediaAssetKind,
  ProjectMediaAsset,
  StitchCatalogue,
  StitchVideoItem,
  StudioUpdateAddedAssetEntry,
  StudioUpdatesManifest,
  StudioUpdateSceneTimelineEntry,
  TimelineClip,
  TimelineMarker,
  TimelineTrack,
  VideoProjectFormat,
  VideoProjectManifest,
  VideoProjectSequenceItem,
  VisualLookPreset,
} from '../shared/types';
import { extractVideoFrameToPng, probeMediaDuration } from './hardware';
import { createDefaultTextOverlay } from '../shared/textOverlay';

const DIALOGUE_PAUSE_SECONDS = 0.25;

function applyStudioTextOverlayDefaults(project: VideoProjectManifest, aiMovie: AiMovieManifest): boolean {
  const applied = new Set(project.studioTextOverlayDefaultsApplied || []);
  const videoTrack = project.timeline.tracks.find((track) => track.type === 'video');
  let textTrack = project.timeline.tracks.find((track) => track.type === 'text');
  let modified = false;
  for (const scene of aiMovie.scenes) {
    const text = scene.defaultTextOverlay;
    if (typeof text !== 'string' || !text.trim() || applied.has(scene.id)) continue;
    const visuals = videoTrack?.clips.filter((clip) => clip.sceneId === scene.id) || [];
    if (visuals.length === 0) continue;
    const start = Math.min(...visuals.map((clip) => clip.timelineStart));
    const end = Math.max(...visuals.map((clip) => clip.timelineStart + getClipTimelineDuration(clip)));
    if (!textTrack) {
      textTrack = { id: 'track_text', type: 'text', name: 'Text Overlays', volume: 1, muted: false, clips: [] };
      project.timeline.tracks.push(textTrack);
    }
    textTrack.clips.push({
      id: `text_studio_${scene.id}`, assetId: '', trackId: textTrack.id, sceneId: scene.id,
      label: text.split(/\r\n|\r|\n/)[0].slice(0, 60) || 'Text',
      timelineStart: start, sourceIn: 0, sourceOut: Math.round((end - start) * 100) / 100, volume: 1,
      textOverlay: createDefaultTextOverlay(text, project.format.height),
    });
    applied.add(scene.id);
    modified = true;
  }
  if (modified) project.studioTextOverlayDefaultsApplied = Array.from(applied);
  return modified;
}

export function inferLookPresetFromColorGrade(colorGrade?: string): VisualLookPreset {
  if (!colorGrade) return 'none';
  const lower = colorGrade.toLowerCase();
  if (lower.includes('crackle') || lower.includes('projector')) return 'vintage-film-crackle';
  if (lower.includes('vintage') || lower.includes('sepia') || lower.includes('old film') || lower.includes('1920')) {
    return 'vintage-film';
  }
  if (lower.includes('mono') || lower.includes('noir') || lower.includes('black and white') || lower.includes('b&w')) {
    return 'monochrome';
  }
  if (lower.includes('muted') || lower.includes('bleach') || lower.includes('desat')) {
    return 'muted';
  }
  if (lower.includes('cinema') || lower.includes('teal') || lower.includes('film')) {
    return 'cinematic';
  }
  return 'none';
}

function isArchiveOrIgnoredFolderName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === 'archive' ||
    lower === '_archive' ||
    lower === '.archive' ||
    lower.startsWith('archive-') ||
    lower.endsWith('-archive') ||
    lower === 'trash' ||
    lower === 'deleted' ||
    lower === 'normalized'
  );
}

export function resolveSceneOrder(
  scene: { order?: number; sceneOrder?: number; properties?: { order?: number; sceneOrder?: number } },
  fallbackIndex: number
): number {
  const explicit =
    scene.order ??
    scene.sceneOrder ??
    scene.properties?.order ??
    scene.properties?.sceneOrder;
  return typeof explicit === 'number' && Number.isFinite(explicit) ? explicit : fallbackIndex + 1;
}

/**
 * Infers a Ken Burns camera motion preset from SpliceWright Studio's `cameraDirection`
 * (or scene summary/title) when a scene uses a still image / poster frame.
 */
export function inferKenBurnsFromCameraDirection(
  cameraDirection?: string,
  fallbackPreset: KenBurnsPreset = 'zoom-in'
): KenBurnsPreset {
  if (!cameraDirection) return fallbackPreset;
  const text = cameraDirection.toLowerCase();

  if (text.includes('static') || text.includes('locked') || text.includes('still')) {
    return 'none';
  }
  if (text.includes('star wars') || text.includes('starwars') || text.includes('crawl')) {
    return 'star-wars-crawl';
  }
  if (text.includes('zoom out') || text.includes('pull back') || text.includes('pull-back') || text.includes('reveal')) {
    return 'zoom-out';
  }
  if (text.includes('top to bottom') || text.includes('top-to-bottom') || text.includes('tilt down') || text.includes('pan down') || text.includes('scroll')) {
    return 'pan-top-to-bottom';
  }
  if (text.includes('bottom to top') || text.includes('bottom-to-top') || text.includes('tilt up') || text.includes('pan up')) {
    return 'pan-bottom-to-top';
  }
  if (text.includes('right to left') || text.includes('right-to-left') || text.includes('pan left')) {
    return 'pan-right-to-left';
  }
  if (text.includes('left to right') || text.includes('left-to-right') || text.includes('pan right') || text.includes('tracking') || text.includes('pan')) {
    return 'pan-left-to-right';
  }
  if (text.includes('top-left') || text.includes('top left') || text.includes('upper left')) {
    return 'zoom-in-top-left';
  }
  if (text.includes('top-right') || text.includes('top right') || text.includes('upper right')) {
    return 'zoom-in-top-right';
  }
  if (text.includes('bottom') || text.includes('lower') || text.includes('low-angle')) {
    return 'zoom-in-bottom';
  }
  if (text.includes('push-in') || text.includes('push in') || text.includes('zoom in') || text.includes('close-up')) {
    return 'zoom-in';
  }
  return fallbackPreset;
}

export function normalizeRelPath(inputPath: string): string {
  return inputPath.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Studio moves deleted media under `archive/<relative-path>`; the editor must never use those files. */
export function isArchivedRelPath(relPath: string): boolean {
  return /^archive(\/|$)/i.test(normalizeRelPath(relPath));
}

/** True when the file exists on disk and is not inside the project's `archive/` folder. */
export function isUsableMediaFile(projectRoot: string, relPath: string): boolean {
  if (!relPath || relPath.startsWith('__slate__/') || isArchivedRelPath(relPath)) return false;
  try {
    return fs.statSync(path.join(projectRoot, relPath)).isFile();
  } catch {
    return false;
  }
}

/**
 * Checks the file signature so a poster that is really an MP4 (or other non-image) is rejected.
 * Accepts PNG (`89 50 4E 47`), JPEG (`FF D8 FF`) and WebP (`RIFF....WEBP`).
 */
export function hasImageSignature(fullPath: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(fullPath, 'r');
    const buf = Buffer.alloc(12);
    const read = fs.readSync(fd, buf, 0, 12, 0);
    if (read < 4) return false;
    const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    const isWebp =
      read >= 12 &&
      buf.toString('ascii', 0, 4) === 'RIFF' &&
      buf.toString('ascii', 8, 12) === 'WEBP';
    return isPng || isJpeg || isWebp;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

/** Usable poster = existing, non-archived file whose content is genuinely an image. */
export function isUsablePosterFile(projectRoot: string, relPath: string): boolean {
  return isUsableMediaFile(projectRoot, relPath) && hasImageSignature(path.join(projectRoot, relPath));
}

export function resolveAspectRatioFormat(aspectRatio?: string): VideoProjectFormat {
  const ratio = aspectRatio || '16:9';
  switch (ratio) {
    case '9:16':
      return { aspectRatio: '9:16', width: 1080, height: 1920, fps: 30 };
    case '1:1':
      return { aspectRatio: '1:1', width: 1080, height: 1080, fps: 30 };
    case '21:9':
      return { aspectRatio: '21:9', width: 2560, height: 1080, fps: 30 };
    case '4:3':
      return { aspectRatio: '4:3', width: 1440, height: 1080, fps: 30 };
    case '16:9':
    default:
      return { aspectRatio: ratio, width: 1920, height: 1080, fps: 30 };
  }
}

/**
 * Reads `ai-movie.json` strictly as Read-Only (`R/O`).
 * Never writes to `ai-movie.json`.
 */
export function readAiMovieReadOnly(projectRoot: string): AiMovieManifest | null {
  const aiMoviePath = path.join(projectRoot, 'ai-movie.json');
  if (!fs.existsSync(aiMoviePath)) {
    return null;
  }
  const raw = fs.readFileSync(aiMoviePath, 'utf-8');
  return JSON.parse(raw) as AiMovieManifest;
}

export function getVideoProjectPath(projectRoot: string): string {
  return path.join(projectRoot, 'exports', 'video-project.json');
}

export function findExistingVideoProjectPath(projectRoot: string): string | null {
  const candidates = [
    path.join(projectRoot, 'exports', 'video-project.json'),
    path.join(projectRoot, 'exports', 'splicewright-project.json'),
    path.join(projectRoot, 'exports', 'splicewrite-project.json'),
    path.join(projectRoot, 'video-project.json'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Builds a complete `VideoProjectManifest` from `ai-movie.json` (Read-Only),
 * normalizing all 4 path conventions documented in `what-editor-app-needs-to-know.md`:
 *  1. `scene.videos[].fileName` -> `"scenes/<scene-id>/videos/video-<timestamp>.mp4"`
 *  2. `scene.audioAssets[].fileName` -> `"audio/<scene-id>/audio-<timestamp>-<index>.mp3"`
 *  3. `scene.properties.firstFrameFileName` -> `"first-frame.<ext>"` -> resolved under `"scenes/<scene-id>/"`
 *  4. `storyboard.videos[].fileName` -> `"videos/video-<timestamp>.mp4"` -> resolved under `"storyboards/<storyboard-id>/"`
 */
export async function buildProjectFromAiMovie(
  projectRoot: string,
  aiMovie: AiMovieManifest
): Promise<VideoProjectManifest> {
  const format = resolveAspectRatioFormat(aiMovie.options?.aspectRatio);
  const assets: ProjectMediaAsset[] = [];

  const videoTrack: TimelineTrack = {
    id: 'track_video_main',
    name: 'Scene Video / Visuals',
    type: 'video',
    volume: 1.0,
    muted: false,
    clips: [],
  };

  const dialogueTrack: TimelineTrack = {
    id: 'track_audio_dialogue',
    name: 'Dialogue & Voiceover',
    type: 'dialogue',
    volume: 1.0,
    muted: false,
    clips: [],
  };

  const sfxTrack: TimelineTrack = {
    id: 'track_audio_sfx',
    name: 'Sound Effects (SFX)',
    type: 'sfx',
    volume: 0.9,
    muted: false,
    clips: [],
  };

  const musicTrack: TimelineTrack = {
    id: 'track_audio_music',
    name: 'Backing Music (BGM)',
    type: 'music',
    volume: 0.35,
    muted: false,
    clips: [],
  };

  const markers: TimelineMarker[] = [];
  const sequence: VideoProjectSequenceItem[] = [];

  const characterMap = new Map<string, string>();
  for (const ch of aiMovie.characters || []) {
    characterMap.set(ch.id, ch.name);
  }

  // Index storyboard videos & panel cues by sceneId
  const storyboardsByScene = new Map<
    string,
    Array<{ storyboardId: string; storyboardTitle: string; videoRelPath: string; videoId: string; duration: number }>
  >();
  const panelsByScene = new Map<
    string,
    Array<{
      panelId: string;
      title?: string;
      cameraDirection?: string;
      soundEffects?: string;
      dialogueTags?: string[];
    }>
  >();

  for (const sb of aiMovie.storyboards || []) {
    for (const vid of sb.videos || []) {
      const normalizedSbVideo = vid.fileName.startsWith('storyboards/')
        ? normalizeRelPath(vid.fileName)
        : normalizeRelPath(`storyboards/${sb.id}/${vid.fileName}`);

      for (const sId of sb.sceneIds || []) {
        const list = storyboardsByScene.get(sId) || [];
        list.push({
          storyboardId: sb.id,
          storyboardTitle: sb.title,
          videoRelPath: normalizedSbVideo,
          videoId: `${sb.id}_${vid.id}`,
          duration: vid.durationSeconds || 6,
        });
        storyboardsByScene.set(sId, list);
      }
    }

    for (const panel of sb.panels || []) {
      const targetSceneId = panel.sceneId || sb.sceneIds?.[0];
      if (targetSceneId) {
        const list = panelsByScene.get(targetSceneId) || [];
        list.push({
          panelId: panel.id,
          title: panel.title,
          cameraDirection: panel.cameraDirection,
          soundEffects: panel.soundEffects,
          dialogueTags: panel.dialogueTags,
        });
        panelsByScene.set(targetSceneId, list);
      }
    }
  }

  let timelineCursor = 0;

  // Sort scenes by explicit `order` / `sceneOrder` if present in `ai-movie.json`,
  // falling back to array index (never parsing numbers from `scene.id` so gaps like scene-1, scene-3 work).
  const orderedScenes = (aiMovie.scenes || [])
    .map((scene, idx) => ({ scene, origIdx: idx, order: resolveSceneOrder(scene, idx) }))
    .sort((a, b) => (a.order !== b.order ? a.order - b.order : a.origIdx - b.origIdx));

  const activeSceneIds = new Set<string>(orderedScenes.map((s) => s.scene.id));

  for (let idx = 0; idx < orderedScenes.length; idx++) {
    const { scene, order: explicitOrder } = orderedScenes[idx];
    const sceneOrder = explicitOrder || idx + 1;
    const sceneStart = timelineCursor;

    markers.push({
      id: `marker_scene_${scene.id}`,
      time: sceneStart,
      label: `Scene ${sceneOrder}: ${scene.title}`,
      kind: 'scene',
      sceneId: scene.id,
      sceneOrder,
      details: scene.summary,
    });

    // 1. Resolve Poster / First Frame (`scenes/<scene-id>/first-frame.<ext>` or `assets/images/...` in notes)
    let posterRelPath: string | null = null;
    if (scene.properties?.firstFrameFileName) {
      const rawPoster = scene.properties.firstFrameFileName;
      posterRelPath = rawPoster.startsWith('scenes/')
        ? normalizeRelPath(rawPoster)
        : normalizeRelPath(`scenes/${scene.id}/${rawPoster}`);
    } else {
      for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
        const candidate = `scenes/${scene.id}/first-frame.${ext}`;
        if (isUsablePosterFile(projectRoot, candidate)) {
          posterRelPath = candidate;
          break;
        }
      }
    }

    // A poster must be a real image on disk (e.g. a `first-frame.png` that is really an MP4 is treated as missing)
    if (posterRelPath && !isUsablePosterFile(projectRoot, posterRelPath)) {
      posterRelPath = null;
    }

    // Fallback: check if scene.notes references an image in `assets/images/...`
    if (!posterRelPath && typeof scene.notes === 'string') {
      const imgMatch = scene.notes.match(/(assets\/images\/[^\s,;)]+\.(?:png|jpg|jpeg|webp))/i);
      if (imgMatch && isUsablePosterFile(projectRoot, imgMatch[1])) {
        posterRelPath = normalizeRelPath(imgMatch[1]);
      }
    }

    let posterAssetId: string | null = null;
    if (posterRelPath) {
      posterAssetId = `asset_${scene.id}_poster`;
      assets.push({
        id: posterAssetId,
        kind: 'image',
        label: `[${scene.title}] First Frame Poster`,
        relativePath: posterRelPath,
        durationSeconds: scene.durationSeconds || 5,
        sceneId: scene.id,
        source: 'ai-movie',
        isPosterFallback: true,
      });
    }

    // 2. Resolve Scene Video Takes (`scenes/<scene-id>/videos/video-<timestamp>.mp4` or shared `assets/video/<file>`)
    const sceneTakeAssetIds: string[] = [];
    const sceneTakesByAssetId = new Map<string, AiMovieVideoTake>();
    const alternateVideos: VideoProjectSequenceItem['alternateVideos'] = [];
    const registeredSceneVideoPaths = new Set<string>();

    for (let tIdx = 0; tIdx < (scene.videos || []).length; tIdx++) {
      const take = scene.videos![tIdx];
      const relPath =
        take.fileName.startsWith('scenes/') ||
        take.fileName.startsWith('assets/') ||
        take.fileName.startsWith('videos/')
          ? normalizeRelPath(take.fileName)
          : normalizeRelPath(`scenes/${scene.id}/videos/${path.basename(take.fileName)}`);

      const fullVideoPath = path.join(projectRoot, relPath);
      // Register only media that exists (takes moved to `archive/` or deleted must not become assets)
      if (!isUsableMediaFile(projectRoot, relPath)) continue;
      const probedDur =
        (!take.durationSeconds || take.durationSeconds <= 0)
          ? await probeMediaDuration(fullVideoPath)
          : take.durationSeconds;

      const assetId = `asset_${scene.id}_${take.id}`;
      const duration = Math.round((probedDur || scene.durationSeconds || 5) * 100) / 100;
      assets.push({
        id: assetId,
        kind: 'video',
        label: `[${scene.title}] Take ${tIdx + 1} (${take.label || take.id})`,
        relativePath: relPath,
        durationSeconds: duration,
        sceneId: scene.id,
        aspectRatio: take.aspectRatio || scene.aspectRatio,
        resolution: take.resolution || scene.resolution,
        source: 'ai-movie',
      });
      sceneTakeAssetIds.push(assetId);
      sceneTakesByAssetId.set(assetId, take);
      registeredSceneVideoPaths.add(relPath);
    }

    // Also scan `scenes/<scene-id>/videos/` on disk for any video takes not yet listed in `scene.videos[]`
    const sceneVideosDir = path.join(projectRoot, 'scenes', scene.id, 'videos');
    if (fs.existsSync(sceneVideosDir)) {
      const diskVidFiles = fs.readdirSync(sceneVideosDir).sort();
      for (const file of diskVidFiles) {
        const ext = path.extname(file).toLowerCase();
        if (!['.mp4', '.webm', '.mov', '.mkv'].includes(ext)) continue;
        const relPath = normalizeRelPath(`scenes/${scene.id}/videos/${file}`);
        if (registeredSceneVideoPaths.has(relPath)) continue;
        const fullPath = path.join(projectRoot, relPath);
        const duration = Math.round((await probeMediaDuration(fullPath)) * 100) / 100;
        const baseId = path.basename(file, ext);
        const assetId = `asset_${scene.id}_${baseId}`;
        assets.push({
          id: assetId,
          kind: 'video',
          label: `[${scene.title}] Take (${baseId})`,
          relativePath: relPath,
          durationSeconds: duration,
          sceneId: scene.id,
          aspectRatio: scene.aspectRatio,
          resolution: scene.resolution,
          source: 'ai-movie',
        });
        sceneTakeAssetIds.push(assetId);
        registeredSceneVideoPaths.add(relPath);
      }
    }

    // Include storyboard takes linked to this scene
    const sbTakes = storyboardsByScene.get(scene.id) || [];
    for (const sbTake of sbTakes) {
      if (!isUsableMediaFile(projectRoot, sbTake.videoRelPath)) continue;
      const assetId = `asset_${scene.id}_sb_${sbTake.videoId}`;
      assets.push({
        id: assetId,
        kind: 'video',
        label: `[${scene.title}] Storyboard (${sbTake.storyboardTitle})`,
        relativePath: sbTake.videoRelPath,
        durationSeconds: sbTake.duration,
        sceneId: scene.id,
        storyboardId: sbTake.storyboardId,
        source: 'ai-movie',
      });
      sceneTakeAssetIds.push(assetId);
    }

    // Also include poster fallback in take switcher if available
    if (posterAssetId) {
      sceneTakeAssetIds.push(posterAssetId);
    }

    // Hero take resolution priority (per what-editor-app-needs-to-know.md Section 7.2):
    // 1. `scene.properties.selectedVideoId` if set and matches a take in `scene.videos[]`
    // 2. Latest scene video take (`videoOnlyTakes.at(-1)`), else storyboard take, else poster
    const videoOnlyTakes = sceneTakeAssetIds.filter((id) => id !== posterAssetId);
    let heroAssetId: string | null = null;
    const preferredVideoId =
      typeof scene.properties?.selectedVideoId === 'string'
        ? scene.properties.selectedVideoId
        : null;
    const preferredAssetId = preferredVideoId ? `asset_${scene.id}_${preferredVideoId}` : null;

    if (preferredAssetId && videoOnlyTakes.includes(preferredAssetId)) {
      heroAssetId = preferredAssetId;
    } else if (videoOnlyTakes.length > 0) {
      heroAssetId = videoOnlyTakes[videoOnlyTakes.length - 1];
    } else if (posterAssetId) {
      heroAssetId = posterAssetId;
    }

    // 3. Resolve Audio Assets from `scene.audioAssets[]` only (loose files in `audio/<scene-id>/` are never timeline audio)
    // Per Section 7.3, 7.5 & Section 8.3: exclude `rejected`, drop clips whose file is missing or archived, and for
    // multi-character exchanges or multiple takes of the same dialogue line
    // (`(characterId || '') + ':' + dialogueLine.toLowerCase()`), keep only the single latest `status === 'approved'`
    // take (or the latest non-rejected take) per distinct line.
    const resolveSceneAudioRelPath = (aud: AiMovieAudioAsset): string => {
      let relPath =
        aud.fileName.startsWith('audio/') || aud.fileName.startsWith('assets/')
          ? normalizeRelPath(aud.fileName)
          : normalizeRelPath(`audio/${scene.id}/${path.basename(aud.fileName)}`);
      // If `audio/<scene-id>/<file>` is missing, check `assets/audio/<file>` fallback
      if (!isUsableMediaFile(projectRoot, relPath)) {
        const fallbackInAssets = normalizeRelPath(`assets/audio/${path.basename(aud.fileName)}`);
        if (isUsableMediaFile(projectRoot, fallbackInAssets)) {
          relPath = fallbackInAssets;
        }
      }
      return relPath;
    };
    const nonRejectedAudio = (scene.audioAssets || []).filter(
      (a) => a.status !== 'rejected' && isUsableMediaFile(projectRoot, resolveSceneAudioRelPath(a))
    );
    const chosenDlgTakeByLineKey = new Map<string, string>();
    for (const a of nonRejectedAudio) {
      if ((a.kind === 'dialogue' || a.kind === 'voiceover') && a.dialogueLine) {
        const key = `${a.characterId || ''}:${a.dialogueLine.trim().toLowerCase()}`;
        const prevId = chosenDlgTakeByLineKey.get(key);
        const prevAsset = prevId ? nonRejectedAudio.find((x) => x.id === prevId) : undefined;
        // Prefer 'approved' over 'generated', and if both have the same status, prefer the latest take (`a`)
        if (!prevAsset || a.status === 'approved' || prevAsset.status !== 'approved') {
          chosenDlgTakeByLineKey.set(key, a.id);
        }
      }
    }
    const validAudio = nonRejectedAudio.filter((a) => {
      if ((a.kind === 'dialogue' || a.kind === 'voiceover') && a.dialogueLine) {
        const key = `${a.characterId || ''}:${a.dialogueLine.trim().toLowerCase()}`;
        return chosenDlgTakeByLineKey.get(key) === a.id;
      }
      return true;
    });

    let dialogueOffsetInScene = 0;
    const sequenceDialogue: VideoProjectSequenceItem['dialogue'] = [];
    const sequenceSfx: VideoProjectSequenceItem['soundEffects'] = [];
    const sequenceMusic: VideoProjectSequenceItem['music'] = [];

    let dialogueIndex = 0;
    for (const aud of validAudio) {
      const relPath = resolveSceneAudioRelPath(aud);

      const fullAudioPath = path.join(projectRoot, relPath);
      let duration = aud.durationSeconds || 0;
      if (!duration || duration <= 0) {
        duration = await probeMediaDuration(fullAudioPath);
      }
      duration = Math.round((duration || 2.5) * 100) / 100;

      const assetId = `asset_${scene.id}_${aud.id}`;

      if (aud.kind === 'dialogue' || aud.kind === 'voiceover') {
        dialogueIndex++;
        let speaker = aud.characterId ? characterMap.get(aud.characterId) || 'Narrator' : 'Narrator';
        let text = (aud.dialogueLine || scene.dialogue || '').trim();
        if (text.includes(':')) {
          const colonIdx = text.indexOf(':');
          const candidateSpeaker = text.slice(0, colonIdx).trim();
          // Only treat prefix before ':' as a speaker label if it is short and has no sentence punctuation
          if (candidateSpeaker.length > 0 && candidateSpeaker.length <= 28 && !/[.,?!—]/.test(candidateSpeaker)) {
            speaker = candidateSpeaker;
            text = text.slice(colonIdx + 1).trim();
          }
        }

        assets.push({
          id: assetId,
          kind: 'dialogue',
          label: `${speaker}: "${text.slice(0, 36)}${text.length > 36 ? '...' : ''}"`,
          relativePath: relPath,
          durationSeconds: duration,
          sceneId: scene.id,
          speaker,
          characterId: aud.characterId,
          dialogueText: text || aud.dialogueLine,
          source: 'ai-movie',
        });

        const clipStart = sceneStart + dialogueOffsetInScene;
        dialogueTrack.clips.push({
          id: `clip_dlg_${scene.id}_${aud.id}`,
          assetId,
          trackId: dialogueTrack.id,
          sceneId: scene.id,
          label: `${speaker}: ${text || aud.id}`,
          timelineStart: Math.round(clipStart * 100) / 100,
          sourceIn: 0,
          sourceOut: duration,
          volume: 1.0,
        });

        sequenceDialogue.push({
          id: aud.id,
          order: dialogueIndex,
          speaker,
          characterId: aud.characterId,
          text: text || aud.dialogueLine || '',
          path: relPath,
          durationSeconds: duration,
        });

        dialogueOffsetInScene += duration + DIALOGUE_PAUSE_SECONDS;
      } else if (aud.kind === 'sound-effect') {
        assets.push({
          id: assetId,
          kind: 'sfx',
          label: `[${scene.title}] SFX ${aud.id}`,
          relativePath: relPath,
          durationSeconds: duration,
          sceneId: scene.id,
          source: 'ai-movie',
        });
        const sfxStart = sceneStart + (aud.startTimeSeconds || 0);
        sfxTrack.clips.push({
          id: `clip_sfx_${scene.id}_${aud.id}`,
          assetId,
          trackId: sfxTrack.id,
          sceneId: scene.id,
          label: `SFX: ${path.basename(relPath)}`,
          timelineStart: sfxStart,
          sourceIn: 0,
          sourceOut: duration,
          volume: 0.9,
        });
        sequenceSfx.push({
          id: aud.id,
          label: path.basename(relPath),
          path: relPath,
          durationSeconds: duration,
          startTimeSeconds: aud.startTimeSeconds || 0,
        });
      } else if (aud.kind === 'music') {
        assets.push({
          id: assetId,
          kind: 'music',
          label: `[${scene.title}] Music ${aud.id}`,
          relativePath: relPath,
          durationSeconds: duration,
          sceneId: scene.id,
          source: 'ai-movie',
        });
        musicTrack.clips.push({
          id: `clip_mus_${scene.id}_${aud.id}`,
          assetId,
          trackId: musicTrack.id,
          sceneId: scene.id,
          label: `Music: ${path.basename(relPath)}`,
          timelineStart: sceneStart,
          sourceIn: 0,
          sourceOut: duration,
          volume: 0.35,
          fadeIn: 0.5,
          fadeOut: 1.0,
        });
        sequenceMusic.push({
          id: aud.id,
          label: path.basename(relPath),
          path: relPath,
          durationSeconds: duration,
        });
      }
    }

    // 4. Determine Scene Timeline Span & Place Hero Video Clip (or Scene Slate if no graphic yet)
    // Scenario 1 (Section 8): Non-destructive sub-clips (`sourceInSeconds`, `sourceOutSeconds`, `playbackRate`, `muteSourceAudio`, `segments[]`)
    // Scenario 2 (Section 8): Automatic Multi-Scene Audio Spanning — if Scene N has dialogue > sceneN.durationSeconds
    // and subsequent scenes N+1..N+k have no dialogue of their own, Scene N's visual clip stays at `sceneN.durationSeconds`
    // so Scenes N+1..N+k cut visually over Scene N's continuing narration!
    const scenePanels = panelsByScene.get(scene.id) || [];
    const primaryCameraDir = scenePanels.find((p) => p.cameraDirection)?.cameraDirection || scene.summary;

    const totalDialogueSpan =
      dialogueOffsetInScene > 0 ? Math.max(0, dialogueOffsetInScene - DIALOGUE_PAUSE_SECONDS) : 0;
    const targetDuration = scene.durationSeconds || 5;

    // Check whether the next scene in sequence is a silent continuation scene (no dialogue of its own)
    const sceneHasNonRejectedDialogue = (sc: AiMovieScene): boolean =>
      (sc.audioAssets || []).some((a) => {
        if (a.status === 'rejected' || (a.kind !== 'dialogue' && a.kind !== 'voiceover')) return false;
        const rel =
          a.fileName.startsWith('audio/') || a.fileName.startsWith('assets/')
            ? normalizeRelPath(a.fileName)
            : normalizeRelPath(`audio/${sc.id}/${path.basename(a.fileName)}`);
        return (
          isUsableMediaFile(projectRoot, rel) ||
          isUsableMediaFile(projectRoot, `assets/audio/${path.basename(a.fileName)}`)
        );
      });

    const nextSceneEntry = orderedScenes[idx + 1];
    const nextSceneIsSilentContinuation = Boolean(
      nextSceneEntry && !sceneHasNonRejectedDialogue(nextSceneEntry.scene)
    );

    if (!heroAssetId) {
      const slateAssetId = `asset_${scene.id}_slate`;
      assets.push({
        id: slateAssetId,
        kind: 'image',
        label: `[${scene.title}] Scene Slate (No Graphic Yet)`,
        relativePath: `__slate__/${scene.id}`,
        durationSeconds: targetDuration,
        sceneId: scene.id,
        dialogueText: scene.summary || scene.title,
        source: 'ai-movie',
        isPosterFallback: true,
        isPlaceholderSlate: true,
      });
      sceneTakeAssetIds.push(slateAssetId);
      heroAssetId = slateAssetId;
    }

    const heroAsset = assets.find((a) => a.id === heroAssetId) || null;
    const heroTakeSpec = heroAssetId ? sceneTakesByAssetId.get(heroAssetId) : undefined;
    const defaultMuteSource =
      heroTakeSpec?.muteSourceAudio !== undefined
        ? heroTakeSpec.muteSourceAudio
        : sequenceDialogue.length > 0;

    // Compute how much earlier spanning audio from an Anchor Scene is still playing when this scene starts
    const dialogueTrackEndSoFar = dialogueTrack.clips.reduce(
      (maxEnd, c) => Math.max(maxEnd, c.timelineStart + getClipTimelineDuration(c)),
      0
    );
    const remainingSpanningAudioAtSceneStart = Math.max(0, dialogueTrackEndSoFar - sceneStart);

    // Under Scenario 2:
    // - If `nextSceneIsSilentContinuation` is true, do NOT stretch this scene's still poster to cover all of `remainingSpanningAudioAtSceneStart`;
    //   let this scene play for `targetDuration` so the next silent scene cuts in on time over the continuing audio!
    // - Only if this is the LAST scene in the audio span (`!nextSceneIsSilentContinuation`) and the audio still exceeds `sceneStart + targetDuration`
    //   should this final scene extend its still hold so the audio finishes before the next voiced scene starts.
    const requiredStillDuration = nextSceneIsSilentContinuation
      ? targetDuration
      : Math.max(targetDuration, Math.ceil(remainingSpanningAudioAtSceneStart));

    if (heroAsset && heroAsset.isPosterFallback) {
      heroAsset.durationSeconds = requiredStillDuration;
    }

    let clipDuration = requiredStillDuration;

    if (heroAsset) {
      const isStillHero =
        (heroAsset.kind === 'image' || Boolean(heroAsset.isPosterFallback)) &&
        !heroAsset.isPlaceholderSlate;
      const suffix = heroAsset.isPlaceholderSlate
        ? 'Scene Slate — No Graphic Yet'
        : heroAsset.isPosterFallback
        ? 'Poster Frame'
        : 'Video';
      const explicitFitMode = heroTakeSpec?.fitMode || scene.properties?.fitMode;
      const explicitKenBurns = heroTakeSpec?.kenBurns || scene.properties?.kenBurns;

      if (
        !heroAsset.isPosterFallback &&
        heroTakeSpec?.segments &&
        heroTakeSpec.segments.length > 0
      ) {
        // Scenario 1: Multi-segment sub-clips (e.g. normal speed -> 3x speed ramp within the same sceneId)
        let segCursor = sceneStart;
        heroTakeSpec.segments.forEach((seg, sIdx) => {
          const segIn = Math.max(0, seg.sourceInSeconds ?? 0);
          const segOut = Math.max(
            segIn + 0.2,
            seg.sourceOutSeconds ?? heroAsset.durationSeconds
          );
          const segRate = seg.playbackRate && seg.playbackRate > 0 ? seg.playbackRate : 1.0;
          const segEffectiveDur = Math.max(0.1, Math.round(((segOut - segIn) / segRate) * 100) / 100);
          videoTrack.clips.push({
            id: sIdx === 0 ? `clip_vid_${scene.id}` : `clip_vid_${scene.id}_seg_${sIdx + 1}`,
            assetId: heroAsset.id,
            trackId: videoTrack.id,
            sceneId: scene.id,
            sceneOrder,
            label:
              heroTakeSpec.segments!.length > 1
                ? `${scene.title} (${suffix} • Part ${sIdx + 1})`
                : `${scene.title} (${suffix})`,
            timelineStart: Math.round(segCursor * 100) / 100,
            sourceIn: segIn,
            sourceOut: segOut,
            playbackRate: segRate,
            muteSourceAudio: defaultMuteSource,
            volume: 1.0,
            fitMode: explicitFitMode,
            kenBurns: explicitKenBurns || 'none',
            availableTakeAssetIds: sceneTakeAssetIds,
          });
          segCursor = Math.round((segCursor + segEffectiveDur) * 100) / 100;
        });
        clipDuration = Math.max(0.2, Math.round((segCursor - sceneStart) * 100) / 100);
      } else {
        const srcIn =
          !heroAsset.isPosterFallback && typeof heroTakeSpec?.sourceInSeconds === 'number'
            ? Math.max(0, heroTakeSpec.sourceInSeconds)
            : 0;
        const srcOut = heroAsset.isPosterFallback
          ? requiredStillDuration
          : typeof heroTakeSpec?.sourceOutSeconds === 'number' &&
            heroTakeSpec.sourceOutSeconds > srcIn
          ? heroTakeSpec.sourceOutSeconds
          : heroAsset.durationSeconds;
        const rate =
          !heroAsset.isPosterFallback &&
          heroTakeSpec?.playbackRate &&
          heroTakeSpec.playbackRate > 0
            ? heroTakeSpec.playbackRate
            : 1.0;
        clipDuration = Math.max(0.1, Math.round(((srcOut - srcIn) / rate) * 100) / 100);

        videoTrack.clips.push({
          id: `clip_vid_${scene.id}`,
          assetId: heroAsset.id,
          trackId: videoTrack.id,
          sceneId: scene.id,
          sceneOrder,
          label: `${scene.title} (${suffix})`,
          timelineStart: Math.round(sceneStart * 100) / 100,
          sourceIn: srcIn,
          sourceOut: srcOut,
          playbackRate: rate,
          muteSourceAudio: defaultMuteSource,
          volume: 1.0,
          fitMode: explicitFitMode,
          kenBurns:
            explicitKenBurns ||
            (isStillHero
              ? inferKenBurnsFromCameraDirection(primaryCameraDir, 'zoom-in')
              : 'none'),
          availableTakeAssetIds: sceneTakeAssetIds,
        });
      }
    }

    // 5. Add Storyboard SFX & Camera Cue Markers along this scene
    scenePanels.forEach((panel, pIdx) => {
      const panelOffset =
        scenePanels.length > 1
          ? Math.round(((clipDuration / scenePanels.length) * pIdx) * 10) / 10
          : 0.5;
      if (panel.soundEffects) {
        markers.push({
          id: `marker_sfx_${scene.id}_${panel.panelId}`,
          time: Math.round((sceneStart + Math.min(panelOffset, Math.max(0, clipDuration - 0.5))) * 100) / 100,
          label: `SFX Cue: ${panel.soundEffects}`,
          kind: 'sfx-cue',
          sceneId: scene.id,
          panelId: panel.panelId,
          details: `Panel "${panel.title || panel.panelId}" — Drop SFX here: ${panel.soundEffects}`,
        });
      }
      if (panel.cameraDirection) {
        markers.push({
          id: `marker_cam_${scene.id}_${panel.panelId}`,
          time: Math.round((sceneStart + Math.min(panelOffset, Math.max(0, clipDuration - 0.5))) * 100) / 100,
          label: `Cam: ${panel.cameraDirection}`,
          kind: 'camera-cue',
          sceneId: scene.id,
          panelId: panel.panelId,
          details: panel.dialogueTags?.length
            ? `Tags: ${panel.dialogueTags.join(', ')}`
            : undefined,
        });
      }
    });

    for (const takeAssetId of sceneTakeAssetIds) {
      if (takeAssetId !== heroAssetId) {
        const alt = assets.find((a) => a.id === takeAssetId);
        if (alt && alt.kind === 'video') {
          alternateVideos.push({
            id: alt.id,
            label: alt.label,
            path: alt.relativePath,
            durationSeconds: alt.durationSeconds,
          });
        }
      }
    }

    sequence.push({
      id: scene.id,
      order: sceneOrder,
      title: scene.title,
      targetDurationSeconds: targetDuration,
      aspectRatio: scene.aspectRatio || format.aspectRatio,
      resolution: scene.resolution || `${format.width}x${format.height}`,
      posterFrame: posterRelPath,
      selectedVideo: heroAsset && heroAsset.kind === 'video' ? heroAsset.relativePath : null,
      alternateVideos,
      dialogue: sequenceDialogue,
      soundEffects: sequenceSfx,
      music: sequenceMusic,
    });

    // Scenario 2 (Section 8): If the next scene is a silent continuation scene (`nextSceneIsSilentContinuation`),
    // advance `timelineCursor` by `clipDuration` (not `totalDialogueSpan`) so the next scene's visual cuts in over Scene N's audio!
    const nextSceneAdvance = nextSceneIsSilentContinuation
      ? clipDuration
      : Math.max(clipDuration, remainingSpanningAudioAtSceneStart, totalDialogueSpan);
    timelineCursor = Math.round((sceneStart + nextSceneAdvance) * 100) / 100;
  }

  // 6. Scan `assets/audio/` and `assets/video/` for any shared BGM, SFX, or video clips
  await scanSharedAssetsFolder(projectRoot, assets, activeSceneIds);

  const project: VideoProjectManifest = {
    schemaVersion: '1.0',
    appName: 'SpliceWright',
    projectMode: 'ai-movie',
    title: aiMovie.title || path.basename(projectRoot),
    updatedAt: new Date().toISOString(),
    format,
    autoDuckMusicUnderDialogue: true,
    duckingVolumeRatio: 0.25,
    normalizeDialogueAudio: true,
    lookPreset: inferLookPresetFromColorGrade(aiMovie.options?.colorGrade),
    assets,
    timeline: {
      tracks: [videoTrack, dialogueTrack, sfxTrack, musicTrack],
      markers,
    },
    sequence,
  };
  applyStudioTextOverlayDefaults(project, aiMovie);
  return project;
}

export async function scanSharedAssetsFolder(
  projectRoot: string,
  assets: ProjectMediaAsset[],
  activeSceneIds?: Set<string>
): Promise<void> {
  const existingPaths = new Set<string>();
  for (const a of assets) {
    existingPaths.add(a.relativePath);
    if (a.originalRelativePath) {
      existingPaths.add(a.originalRelativePath);
    }
  }
  const existingDialogueBaseNames = new Set(
    assets
      .filter((a) => a.kind === 'dialogue')
      .flatMap((a) => [
        path.basename(a.relativePath).toLowerCase(),
        ...(a.originalRelativePath ? [path.basename(a.originalRelativePath).toLowerCase()] : []),
      ])
  );

  // 1. Scan `assets/audio/` (excluding `normalized` and archive subdirectories)
  const audioDir = path.join(projectRoot, 'assets', 'audio');
  if (fs.existsSync(audioDir)) {
    const entries = fs.readdirSync(audioDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (isArchiveOrIgnoredFolderName(entry.name)) continue;
      const file = entry.name;
      const ext = path.extname(file).toLowerCase();
      if (['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'].includes(ext)) {
        // Skip duplicate copies of scene dialogue files (`audio-<timestamp>-<idx>.mp3`)
        if (existingDialogueBaseNames.has(file.toLowerCase())) {
          continue;
        }
        const relPath = normalizeRelPath(path.join('assets', 'audio', file));
        if (!existingPaths.has(relPath)) {
          const fullPath = path.join(projectRoot, relPath);
          const duration = Math.round((await probeMediaDuration(fullPath)) * 100) / 100;
          const lower = file.toLowerCase();
          const kind: MediaAssetKind = lower.startsWith('audio-')
            ? 'dialogue'
            : lower.includes('sfx') || lower.includes('effect') || duration <= 8
            ? 'sfx'
            : 'music';
          assets.push({
            id: `asset_shared_${file.replace(/[^a-zA-Z0-9]/g, '_')}`,
            kind,
            label: `[Shared ${kind.toUpperCase()}] ${file}`,
            relativePath: relPath,
            durationSeconds: duration,
            source: 'user-imported',
          });
          existingPaths.add(relPath);
        }
      }
    }
  }

  // 2. Scan `audio/` and `audio/<subfolder>/` for any unindexed scene or voiceover audio files
  const rootAudioDir = path.join(projectRoot, 'audio');
  if (fs.existsSync(rootAudioDir)) {
    const entries = fs.readdirSync(rootAudioDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (isArchiveOrIgnoredFolderName(entry.name)) continue;
        // Scene audio comes only from `scene.audioAssets[]` when `ai-movie.json` is active, so loose files
        // in `audio/<scene-id>/` (original download names, duplicate copies) are never registered here.
        if (
          activeSceneIds &&
          activeSceneIds.size > 0 &&
          (activeSceneIds.has(entry.name) || entry.name.toLowerCase().startsWith('scene-'))
        ) {
          continue;
        }
        const subDir = path.join(rootAudioDir, entry.name);
        const subFiles = fs.readdirSync(subDir);
        for (const file of subFiles) {
          if (isArchiveOrIgnoredFolderName(file)) continue;
          const ext = path.extname(file).toLowerCase();
          if (!['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'].includes(ext)) continue;
          const relPath = normalizeRelPath(`audio/${entry.name}/${file}`);
          if (existingPaths.has(relPath)) continue;
          const fullPath = path.join(projectRoot, relPath);
          const duration = Math.round((await probeMediaDuration(fullPath)) * 100) / 100;
          assets.push({
            id: `asset_${entry.name}_${path.basename(file, ext)}`,
            kind: 'dialogue',
            label: `[${entry.name}] ${file}`,
            relativePath: relPath,
            durationSeconds: duration,
            sceneId: entry.name,
            source: 'ai-movie',
          });
          existingPaths.add(relPath);
        }
      } else if (entry.isFile()) {
        if (isArchiveOrIgnoredFolderName(entry.name)) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'].includes(ext)) continue;
        const relPath = normalizeRelPath(`audio/${entry.name}`);
        if (existingPaths.has(relPath)) continue;
        const fullPath = path.join(projectRoot, relPath);
        const duration = Math.round((await probeMediaDuration(fullPath)) * 100) / 100;
        assets.push({
          id: `asset_audio_${path.basename(entry.name, ext).replace(/[^a-zA-Z0-9]/g, '_')}`,
          kind: 'dialogue',
          label: `[Audio] ${entry.name}`,
          relativePath: relPath,
          durationSeconds: duration,
          source: 'ai-movie',
        });
        existingPaths.add(relPath);
      }
    }
  }

  // 3. Scan `assets/video/`
  const videoDir = path.join(projectRoot, 'assets', 'video');
  if (fs.existsSync(videoDir)) {
    const files = fs.readdirSync(videoDir);
    for (const file of files) {
      if (isArchiveOrIgnoredFolderName(file)) continue;
      const ext = path.extname(file).toLowerCase();
      if (['.mp4', '.webm', '.mov', '.mkv', '.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
        const relPath = normalizeRelPath(path.join('assets', 'video', file));
        if (!existingPaths.has(relPath)) {
          const fullPath = path.join(projectRoot, relPath);
          const isImg = ['.png', '.jpg', '.jpeg', '.webp'].includes(ext);
          const duration = isImg ? 5.0 : Math.round((await probeMediaDuration(fullPath)) * 100) / 100;
          assets.push({
            id: `asset_shared_vid_${file.replace(/[^a-zA-Z0-9]/g, '_')}`,
            kind: isImg ? 'image' : 'video',
            label: `[Shared] ${file}`,
            relativePath: relPath,
            durationSeconds: duration,
            source: 'user-imported',
          });
          existingPaths.add(relPath);
        }
      }
    }
  }

  // 4. Scan `assets/images/` (used by SpliceWright Studio for imported screenshots & graphics)
  const imagesDir = path.join(projectRoot, 'assets', 'images');
  if (fs.existsSync(imagesDir)) {
    const files = fs.readdirSync(imagesDir);
    for (const file of files) {
      if (isArchiveOrIgnoredFolderName(file)) continue;
      const ext = path.extname(file).toLowerCase();
      if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
        const relPath = normalizeRelPath(path.join('assets', 'images', file));
        if (!existingPaths.has(relPath)) {
          assets.push({
            id: `asset_shared_img_${file.replace(/[^a-zA-Z0-9]/g, '_')}`,
            kind: 'image',
            label: `[Image] ${file}`,
            relativePath: relPath,
            durationSeconds: 6.0,
            source: 'user-imported',
          });
          existingPaths.add(relPath);
        }
      }
    }
  }
}

/**
 * Creates or opens a Standalone Folder project (Workflow B).
 */
export async function createOrLoadStandaloneProject(
  projectRoot: string,
  title?: string,
  aspectRatio?: string
): Promise<VideoProjectManifest> {
  fs.mkdirSync(path.join(projectRoot, 'assets', 'video'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'assets', 'audio'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'exports'), { recursive: true });

  const format = resolveAspectRatioFormat(aspectRatio || '16:9');
  const assets: ProjectMediaAsset[] = [];

  // Also scan any top-level media files in the selected folder and copy or register them
  const topFiles = fs.readdirSync(projectRoot, { withFileTypes: true });
  for (const entry of topFiles) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    const srcFull = path.join(projectRoot, entry.name);
    if (['.mp4', '.webm', '.mov', '.mkv', '.png', '.jpg', '.webp'].includes(ext)) {
      const destFull = path.join(projectRoot, 'assets', 'video', entry.name);
      if (!fs.existsSync(destFull)) {
        fs.copyFileSync(srcFull, destFull);
      }
    } else if (['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'].includes(ext)) {
      const destFull = path.join(projectRoot, 'assets', 'audio', entry.name);
      if (!fs.existsSync(destFull)) {
        fs.copyFileSync(srcFull, destFull);
      }
    }
  }

  await scanSharedAssetsFolder(projectRoot, assets);

  const videoTrack: TimelineTrack = {
    id: 'track_video_main',
    name: 'Video / Visuals',
    type: 'video',
    volume: 1.0,
    muted: false,
    clips: [],
  };
  const dialogueTrack: TimelineTrack = {
    id: 'track_audio_dialogue',
    name: 'Voiceover / Dialogue',
    type: 'dialogue',
    volume: 1.0,
    muted: false,
    clips: [],
  };
  const sfxTrack: TimelineTrack = {
    id: 'track_audio_sfx',
    name: 'Sound Effects (SFX)',
    type: 'sfx',
    volume: 0.9,
    muted: false,
    clips: [],
  };
  const musicTrack: TimelineTrack = {
    id: 'track_audio_music',
    name: 'Backing Music (BGM)',
    type: 'music',
    volume: 0.35,
    muted: false,
    clips: [],
  };

  // Auto-populate initial clips if assets were found
  let vCursor = 0;
  for (const asset of assets.filter((a) => a.kind === 'video' || a.kind === 'image')) {
    videoTrack.clips.push({
      id: `clip_${asset.id}`,
      assetId: asset.id,
      trackId: videoTrack.id,
      label: asset.label,
      timelineStart: vCursor,
      sourceIn: 0,
      sourceOut: asset.durationSeconds,
      volume: 1.0,
    });
    vCursor += asset.durationSeconds;
  }

  const project: VideoProjectManifest = {
    schemaVersion: '1.0',
    appName: 'SpliceWright',
    projectMode: 'standalone',
    title: title || path.basename(projectRoot),
    updatedAt: new Date().toISOString(),
    format,
    autoDuckMusicUnderDialogue: true,
    duckingVolumeRatio: 0.25,
    normalizeDialogueAudio: true,
    assets,
    timeline: {
      tracks: [videoTrack, dialogueTrack, sfxTrack, musicTrack],
      markers: [],
    },
    sequence: [],
  };

  saveVideoProjectManifest(projectRoot, project);
  return project;
}

export function saveVideoProjectManifest(
  projectRoot: string,
  project: VideoProjectManifest
): string {
  const exportsDir = path.join(projectRoot, 'exports');
  fs.mkdirSync(exportsDir, { recursive: true });
  const targetPath = getVideoProjectPath(projectRoot);
  project.updatedAt = new Date().toISOString();
  fs.writeFileSync(targetPath, JSON.stringify(project, null, 2), 'utf-8');
  writeStudioUpdatesManifest(projectRoot, project);
  return targetPath;
}

/**
 * Writes `exports/studio-updates.json` (Editor -> Studio Outbox) whenever a Studio project is saved,
 * recording all user-imported assets (with their assigned `sceneId`, `sceneOrder`, and placement)
 * and per-scene timeline arrangements (`visualDurationSeconds`, `selectedRelativePath`, `fitMode`,
 * `kenBurns`, `playbackRate`, and sub-clip `segments[]`) so SpliceWright Studio can sync editor changes.
 */
export function writeStudioUpdatesManifest(
  projectRoot: string,
  project: VideoProjectManifest
): void {
  if (!fs.existsSync(path.join(projectRoot, 'ai-movie.json'))) {
    return;
  }
  const exportsDir = path.join(projectRoot, 'exports');
  fs.mkdirSync(exportsDir, { recursive: true });
  const updatesPath = path.join(exportsDir, 'studio-updates.json');

  let existingAddedMap = new Map<string, StudioUpdateAddedAssetEntry>();
  if (fs.existsSync(updatesPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(updatesPath, 'utf-8')) as StudioUpdatesManifest;
      for (const item of prev.addedAssets || []) {
        existingAddedMap.set(item.id, item);
      }
    } catch {}
  }

  const assetMap = new Map<string, ProjectMediaAsset>(project.assets.map((a) => [a.id, a]));
  const allClips: TimelineClip[] = project.timeline.tracks.flatMap((t) => t.clips);

  const addedAssets: StudioUpdateAddedAssetEntry[] = [];
  for (const asset of project.assets) {
    if (asset.source !== 'user-imported') continue;
    const matchingClip = allClips.find((c) => c.assetId === asset.id);
    const existingEntry = existingAddedMap.get(asset.id);
    const effectiveSceneId = asset.sceneId || matchingClip?.sceneId || existingEntry?.sceneId;
    const effectiveSceneOrder = matchingClip?.sceneOrder || existingEntry?.sceneOrder;

    addedAssets.push({
      id: asset.id,
      kind: asset.kind,
      label: asset.label,
      relativePath: asset.originalRelativePath || asset.relativePath,
      durationSeconds: asset.durationSeconds,
      sceneId: effectiveSceneId,
      sceneOrder: effectiveSceneOrder,
      assignment:
        existingEntry?.assignment ||
        (effectiveSceneId ? 'assigned-scene' : 'shared-project'),
      placedAtTimelineSeconds: matchingClip?.timelineStart ?? existingEntry?.placedAtTimelineSeconds,
      sourceInSeconds: matchingClip?.sourceIn ?? existingEntry?.sourceInSeconds,
      sourceOutSeconds: matchingClip?.sourceOut ?? existingEntry?.sourceOutSeconds,
      playbackRate: matchingClip?.playbackRate ?? existingEntry?.playbackRate ?? 1.0,
      muteSourceAudio: matchingClip?.muteSourceAudio ?? existingEntry?.muteSourceAudio,
      fitMode: matchingClip?.fitMode ?? existingEntry?.fitMode,
      kenBurns: matchingClip?.kenBurns ?? existingEntry?.kenBurns,
      addedAt: existingEntry?.addedAt || new Date().toISOString(),
    });
  }

  const sceneTimelineUpdates: StudioUpdateSceneTimelineEntry[] = [];
  const vidTrack = project.timeline.tracks.find((t) => t.type === 'video');
  if (vidTrack) {
    const clipsByScene = new Map<string, TimelineClip[]>();
    for (const c of vidTrack.clips) {
      if (!c.sceneId) continue;
      const arr = clipsByScene.get(c.sceneId) || [];
      arr.push(c);
      clipsByScene.set(c.sceneId, arr);
    }

    const sortedSceneEntries = Array.from(clipsByScene.entries()).sort(
      (a, b) =>
        (a[1][0]?.sceneOrder ?? 999) - (b[1][0]?.sceneOrder ?? 999) ||
        (a[1][0]?.timelineStart ?? 0) - (b[1][0]?.timelineStart ?? 0)
    );

    sortedSceneEntries.forEach(([sceneId, clips], idx) => {
      const sortedClips = [...clips].sort((a, b) => a.timelineStart - b.timelineStart);
      const firstClip = sortedClips[0];
      const primaryAsset = firstClip ? assetMap.get(firstClip.assetId) : undefined;
      const seqItem = project.sequence.find((s) => s.id === sceneId);
      const visualDurationSeconds =
        Math.round(
          sortedClips.reduce((sum, c) => sum + getClipTimelineDuration(c), 0) * 100
        ) / 100;

      sceneTimelineUpdates.push({
        sceneId,
        sceneOrder: firstClip?.sceneOrder ?? seqItem?.order ?? idx + 1,
        title: seqItem?.title || firstClip?.label || sceneId,
        timelineStartSeconds: firstClip?.timelineStart ?? 0,
        visualDurationSeconds,
        selectedAssetId: firstClip?.assetId,
        selectedRelativePath: primaryAsset
          ? primaryAsset.originalRelativePath || primaryAsset.relativePath
          : null,
        isCustomEditorSelection: primaryAsset?.source === 'user-imported',
        fitMode: firstClip?.fitMode,
        kenBurns: firstClip?.kenBurns,
        playbackRate: firstClip?.playbackRate,
        muteSourceAudio: firstClip?.muteSourceAudio,
        segments: sortedClips.map((c) => ({
          sourceInSeconds: c.sourceIn,
          sourceOutSeconds: c.sourceOut,
          playbackRate: c.playbackRate || 1.0,
        })),
      });
    });
  }

  const manifest: StudioUpdatesManifest = {
    schemaVersion: '1.0',
    projectTitle: project.title,
    updatedAt: new Date().toISOString(),
    addedAssets,
    sceneTimelineUpdates,
  };

  fs.writeFileSync(updatesPath, JSON.stringify(manifest, null, 2), 'utf-8');
}

/**
 * Sanitizes an existing or merged `VideoProjectManifest`:
 * 1. Prunes any `ai-movie`-sourced scenes that were deleted in `ai-movie.json` (e.g. `scene-2` deleted & archived).
 * 2. Prunes any `ai-movie` assets whose underlying file was moved to an archive and no longer exists on disk.
 * 3. Cleans up orphaned Scene Heading markers (`project.timeline.markers` with a `sceneId` that has no remaining clips on the video or dialogue tracks, such as blank scenes deleted by the user) and records them in `dismissedSceneIds`.
 * 4. Ensures deterministic `sceneOrder` (`1..N`) on remaining scene clips, markers, and `sequence`.
 */
export function sanitizeProjectManifest(
  projectRoot: string,
  project: VideoProjectManifest,
  aiMovie: AiMovieManifest | null
): boolean {
  let modified = false;
  const dismissedSet = new Set<string>(project.dismissedSceneIds || []);

  // 1. If `ai-movie.json` is present, remove any `sceneId` that was deleted in Studio
  const activeAiSceneIds = aiMovie
    ? new Set<string>((aiMovie.scenes || []).map((s) => s.id))
    : null;

  if (activeAiSceneIds) {
    for (const track of project.timeline.tracks) {
      const before = track.clips.length;
      track.clips = track.clips.filter((c) => !c.sceneId || activeAiSceneIds.has(c.sceneId));
      if (track.clips.length !== before) modified = true;
    }
    const beforeMarkers = project.timeline.markers.length;
    project.timeline.markers = project.timeline.markers.filter(
      (m) => !m.sceneId || activeAiSceneIds.has(m.sceneId)
    );
    if (project.timeline.markers.length !== beforeMarkers) modified = true;

    const beforeAssets = project.assets.length;
    project.assets = project.assets.filter((a) => {
      if (a.sceneId && !activeAiSceneIds.has(a.sceneId)) return false;
      if (
        a.source === 'ai-movie' &&
        !a.isPlaceholderSlate &&
        !a.relativePath.startsWith('__slate__/') &&
        !fs.existsSync(path.join(projectRoot, a.relativePath))
      ) {
        return false;
      }
      return true;
    });
    if (project.assets.length !== beforeAssets) modified = true;
  }

  // 2. Find all `sceneId`s that actually have at least one clip on any track
  const scenesWithClips = new Set<string>();
  for (const track of project.timeline.tracks) {
    for (const clip of track.clips) {
      if (clip.sceneId) {
        scenesWithClips.add(clip.sceneId);
      }
    }
  }

  // 3. Prune orphaned scene markers (e.g. blank scenes whose clip was deleted, leaving floating orange headings)
  const beforeOrphanMarkers = project.timeline.markers.length;
  project.timeline.markers = project.timeline.markers.filter((m) => {
    if (m.sceneId && !scenesWithClips.has(m.sceneId)) {
      dismissedSet.add(m.sceneId);
      return false;
    }
    return true;
  });
  if (project.timeline.markers.length !== beforeOrphanMarkers) {
    modified = true;
  }

  // Also prune sequence entries for scenes that have no clips left on the timeline
  const beforeSeq = project.sequence.length;
  project.sequence = project.sequence.filter((s) => {
    if (!scenesWithClips.has(s.id)) {
      dismissedSet.add(s.id);
      return false;
    }
    return true;
  });
  if (project.sequence.length !== beforeSeq) {
    modified = true;
  }

  // If a scene currently has clips on the timeline, make sure it's not marked dismissed
  for (const sId of scenesWithClips) {
    dismissedSet.delete(sId);
  }
  project.dismissedSceneIds = Array.from(dismissedSet);

  // 4. Ensure deterministic `sceneOrder` (1..N) across video track scene clips, markers, and sequence
  const videoTrack = project.timeline.tracks.find((t) => t.type === 'video');
  if (videoTrack) {
    const sortedSceneClips = [...videoTrack.clips]
      .filter((c) => Boolean(c.sceneId))
      .sort((a, b) => a.timelineStart - b.timelineStart);

    const sceneOrderMap = new Map<string, number>();
    sortedSceneClips.forEach((clip, idx) => {
      if (clip.sceneId && !sceneOrderMap.has(clip.sceneId)) {
        sceneOrderMap.set(clip.sceneId, idx + 1);
      }
    });

    for (const clip of videoTrack.clips) {
      if (clip.sceneId && sceneOrderMap.has(clip.sceneId)) {
        const ord = sceneOrderMap.get(clip.sceneId)!;
        if (clip.sceneOrder !== ord) {
          clip.sceneOrder = ord;
          modified = true;
        }
      }
    }

    for (const marker of project.timeline.markers) {
      if (marker.sceneId && sceneOrderMap.has(marker.sceneId)) {
        const ord = sceneOrderMap.get(marker.sceneId)!;
        if (marker.sceneOrder !== ord) {
          marker.sceneOrder = ord;
          modified = true;
        }
      }
    }

    for (const seq of project.sequence) {
      if (sceneOrderMap.has(seq.id)) {
        const ord = sceneOrderMap.get(seq.id)!;
        if (seq.order !== ord) {
          seq.order = ord;
          modified = true;
        }
      }
    }
    project.sequence.sort((a, b) => a.order - b.order);
  }

  return modified;
}

/** Whether an asset's file exists, is outside `archive/`, and (for Studio posters) is a real image. */
function isAssetFileUsable(projectRoot: string, asset: ProjectMediaAsset): boolean {
  if (asset.isPlaceholderSlate || asset.relativePath.startsWith('__slate__/')) return true;
  if (asset.kind === 'image' && asset.isPosterFallback && asset.source === 'ai-movie') {
    return isUsablePosterFile(projectRoot, asset.relativePath);
  }
  return isUsableMediaFile(projectRoot, asset.relativePath);
}

/**
 * Reconciles a saved timeline against the media actually on disk (Section 7.5 of
 * `what-editor-app-needs-to-know.md`). Runs on every load and on every Studio sync:
 *  - Scene clips pointing at missing / archived / undefined assets are re-resolved from `ai-movie.json`
 *    (preferred take, else latest take, else poster, else slate) with `sourceIn`/`sourceOut` reset.
 *  - Dialogue clips for missing media or for files not listed in `scene.audioAssets[]` are removed, and a repaired
 *    scene with an empty dialogue track gets its eligible dialogue back.
 *  - Clips that cannot be repaired are flagged `missingMedia` instead of rendering blank.
 *  - Stale `availableTakeAssetIds`, `sequence[]` paths and posters are dropped.
 * A still-valid saved selection is never overridden.
 */
export async function reconcileProjectMedia(
  projectRoot: string,
  project: VideoProjectManifest,
  aiMovie: AiMovieManifest | null,
  prebuiltFresh?: VideoProjectManifest
): Promise<boolean> {
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const before = JSON.stringify({
    assets: project.assets,
    tracks: project.timeline.tracks,
    markers: project.timeline.markers,
    sequence: project.sequence,
  });

  const fresh = aiMovie ? prebuiltFresh ?? (await buildProjectFromAiMovie(projectRoot, aiMovie)) : null;
  const activeSceneIds = aiMovie ? new Set<string>((aiMovie.scenes || []).map((s) => s.id)) : null;
  const freshAssetIds = new Set<string>((fresh?.assets || []).map((a) => a.id));
  const assetById = new Map<string, ProjectMediaAsset>(project.assets.map((a) => [a.id, a]));

  // Loose files in `audio/<scene-id>/` that are not in `scene.audioAssets[]` are never timeline audio
  const isUnlinkedSceneDialogue = (a: ProjectMediaAsset): boolean =>
    Boolean(
      fresh &&
        activeSceneIds &&
        a.source === 'ai-movie' &&
        a.kind === 'dialogue' &&
        a.sceneId &&
        activeSceneIds.has(a.sceneId) &&
        !freshAssetIds.has(a.id)
    );
  const isAssetValid = (assetId: string): boolean => {
    const a = assetById.get(assetId);
    return Boolean(a) && !isUnlinkedSceneDialogue(a!) && isAssetFileUsable(projectRoot, a!);
  };

  const videoTrack = project.timeline.tracks.find((t) => t.type === 'video');
  const dialogueTrack = project.timeline.tracks.find((t) => t.type === 'dialogue');
  const repairedSceneIds = new Set<string>();
  const restoredDialogueSceneIds = new Set<string>();

  // 1. Re-resolve scene video clips whose media is gone (rules 1-3)
  if (videoTrack && fresh) {
    const freshVideoTrack = fresh.timeline.tracks.find((t) => t.type === 'video');
    const freshClipsByScene = new Map<string, TimelineClip[]>();
    for (const c of freshVideoTrack?.clips || []) {
      if (!c.sceneId) continue;
      const list = freshClipsByScene.get(c.sceneId) || [];
      list.push(c);
      freshClipsByScene.set(c.sceneId, list);
    }

    const sceneStartOf = (sceneId: string): number =>
      Math.min(
        ...videoTrack.clips.filter((c) => c.sceneId === sceneId).map((c) => c.timelineStart)
      );
    const brokenSceneIds = Array.from(
      new Set(
        videoTrack.clips
          .filter((c) => c.sceneId && !isAssetValid(c.assetId) && freshClipsByScene.has(c.sceneId))
          .map((c) => c.sceneId as string)
      )
    ).sort((a, b) => sceneStartOf(a) - sceneStartOf(b));

    for (const sceneId of brokenSceneIds) {
      const oldClips = videoTrack.clips.filter((c) => c.sceneId === sceneId);
      const oldStart = Math.min(...oldClips.map((c) => c.timelineStart));
      const oldEnd = Math.max(...oldClips.map((c) => c.timelineStart + getClipTimelineDuration(c)));
      const freshClips = [...(freshClipsByScene.get(sceneId) || [])].sort(
        (a, b) => a.timelineStart - b.timelineStart
      );

      for (const fa of fresh.assets) {
        if (
          fa.sceneId === sceneId &&
          (fa.kind === 'video' || fa.kind === 'image') &&
          !assetById.has(fa.id)
        ) {
          project.assets.push(fa);
          assetById.set(fa.id, fa);
        }
      }

      const firstFreshStart = freshClips[0].timelineStart;
      const replacement: TimelineClip[] = freshClips.map((fc) => ({
        ...fc,
        timelineStart: round2(oldStart + fc.timelineStart - firstFreshStart),
        availableTakeAssetIds: (fc.availableTakeAssetIds || []).filter((id) => assetById.has(id)),
      }));
      const newEnd = Math.max(
        ...replacement.map((c) => c.timelineStart + getClipTimelineDuration(c))
      );

      videoTrack.clips = videoTrack.clips.filter((c) => c.sceneId !== sceneId).concat(replacement);

      // Ripple later scene content so a different take length leaves no overlap or gap
      const delta = round2(newEnd - oldEnd);
      if (Math.abs(delta) >= 0.01) {
        for (const track of project.timeline.tracks) {
          for (const c of track.clips) {
            if (c.sceneId !== sceneId && c.timelineStart >= oldEnd - 0.01) {
              c.timelineStart = round2(c.timelineStart + delta);
            }
          }
        }
        for (const m of project.timeline.markers) {
          if (m.sceneId !== sceneId && m.time >= oldEnd - 0.01) {
            m.time = round2(m.time + delta);
          }
        }
      }
      repairedSceneIds.add(sceneId);
    }
    videoTrack.clips.sort((a, b) => a.timelineStart - b.timelineStart);
  }

  // 2. Dialogue: drop clips with missing media / unlinked files, and restore eligible dialogue for repaired scenes (rules 5-6)
  if (dialogueTrack) {
    dialogueTrack.clips = dialogueTrack.clips.filter((c) => {
      if (isAssetValid(c.assetId)) return true;
      const a = assetById.get(c.assetId);
      return Boolean(a) && a!.source === 'user-imported' && !isUnlinkedSceneDialogue(a!);
    });

    if (fresh && videoTrack) {
      const freshDialogueTrack = fresh.timeline.tracks.find((t) => t.type === 'dialogue');
      const freshVideoTrack = fresh.timeline.tracks.find((t) => t.type === 'video');
      for (const sceneId of repairedSceneIds) {
        if (dialogueTrack.clips.some((c) => c.sceneId === sceneId)) continue;
        const freshDlgClips = (freshDialogueTrack?.clips || []).filter((c) => c.sceneId === sceneId);
        if (freshDlgClips.length === 0) continue;
        const freshSceneStart = Math.min(
          ...(freshVideoTrack?.clips || [])
            .filter((c) => c.sceneId === sceneId)
            .map((c) => c.timelineStart)
        );
        const projSceneStart = Math.min(
          ...videoTrack.clips.filter((c) => c.sceneId === sceneId).map((c) => c.timelineStart)
        );
        for (const fc of freshDlgClips) {
          const fa = fresh.assets.find((a) => a.id === fc.assetId);
          if (!fa) continue;
          if (!assetById.has(fa.id)) {
            project.assets.push(fa);
            assetById.set(fa.id, fa);
          }
          dialogueTrack.clips.push({
            ...fc,
            timelineStart: round2(Math.max(0, projSceneStart + fc.timelineStart - freshSceneStart)),
          });
        }
        restoredDialogueSceneIds.add(sceneId);
      }
    }
    dialogueTrack.clips.sort((a, b) => a.timelineStart - b.timelineStart);
  }

  // 3. Drop stale take ids and flag clips whose media cannot be recovered
  for (const track of project.timeline.tracks) {
    if (track.type === 'text') continue;
    for (const clip of track.clips) {
      if (clip.availableTakeAssetIds) {
        clip.availableTakeAssetIds = clip.availableTakeAssetIds.filter(
          (id) => id === clip.assetId || isAssetValid(id)
        );
      }
      if (isAssetValid(clip.assetId)) {
        delete clip.missingMedia;
      } else {
        clip.missingMedia = true;
      }
    }
  }

  // 4. Register only media that exists
  const referencedAssetIds = new Set<string>();
  for (const track of project.timeline.tracks) {
    for (const clip of track.clips) {
      if (clip.missingMedia) referencedAssetIds.add(clip.assetId);
    }
  }
  project.assets = project.assets.filter(
    (a) =>
      referencedAssetIds.has(a.id) ||
      (!isUnlinkedSceneDialogue(a) && (a.source !== 'ai-movie' || isAssetFileUsable(projectRoot, a)))
  );

  // 5. Keep `sequence[]` consistent with the repaired timeline
  const freshSeqById = new Map((fresh?.sequence || []).map((s) => [s.id, s]));
  for (const seq of project.sequence) {
    const fseq = freshSeqById.get(seq.id);
    if (fseq && repairedSceneIds.has(seq.id)) {
      seq.selectedVideo = fseq.selectedVideo;
      seq.alternateVideos = fseq.alternateVideos;
      seq.posterFrame = fseq.posterFrame;
      if (restoredDialogueSceneIds.has(seq.id)) {
        seq.dialogue = fseq.dialogue;
      }
    }
    if (seq.selectedVideo && !isUsableMediaFile(projectRoot, seq.selectedVideo)) {
      seq.selectedVideo = null;
    }
    seq.alternateVideos = (seq.alternateVideos || []).filter((v) =>
      isUsableMediaFile(projectRoot, v.path)
    );
    if (seq.posterFrame && !isUsablePosterFile(projectRoot, seq.posterFrame)) {
      seq.posterFrame = null;
    }
    seq.dialogue = (seq.dialogue || []).filter((d) => isUsableMediaFile(projectRoot, d.path));
  }

  return (
    before !==
    JSON.stringify({
      assets: project.assets,
      tracks: project.timeline.tracks,
      markers: project.timeline.markers,
      sequence: project.sequence,
    })
  );
}

/**
 * Check whether a scene in a freshly built `VideoProjectManifest` has any real media
 * (video take, poster image on disk, or audio clip) as opposed to only a blank placeholder slate.
 */
function sceneHasRealMedia(freshProject: VideoProjectManifest, sceneId: string): boolean {
  for (const asset of freshProject.assets) {
    if (asset.sceneId === sceneId && !asset.isPlaceholderSlate) {
      return true;
    }
  }
  return false;
}

/**
 * Compares `ai-movie.json` (R/O) with the currently loaded `VideoProjectManifest`
 * so the user can merge newly generated takes/dialogue without losing manual edits.
 */
export async function computeAiMovieSyncSummary(
  projectRoot: string,
  currentProject: VideoProjectManifest
): Promise<AiMovieSyncSummary> {
  const aiMovie = readAiMovieReadOnly(projectRoot);
  if (!aiMovie) {
    return {
      hasChanges: false,
      aiMovieBusy: false,
      newTakesCount: 0,
      newDialogueCount: 0,
      newScenesCount: 0,
    };
  }

  const hasUnsaved = Boolean(aiMovie.editorState?.hasUnsavedChanges);
  const pendingCount = aiMovie.editorState?.pendingOperations?.length || 0;
  if (hasUnsaved || pendingCount > 0) {
    return {
      hasChanges: false,
      aiMovieBusy: true,
      busyReason: hasUnsaved
        ? 'SpliceWright Studio extension has unsaved changes in progress.'
        : `SpliceWright Studio has ${pendingCount} pending generation operation(s).`,
      newTakesCount: 0,
      newDialogueCount: 0,
      newScenesCount: 0,
    };
  }

  const freshFromAiMovie = await buildProjectFromAiMovie(projectRoot, aiMovie);
  const existingAssetMap = new Map(currentProject.assets.map((a) => [a.id, a]));
  const existingSceneMap = new Map(currentProject.sequence.map((s) => [s.id, s]));
  const dismissedSet = new Set<string>(currentProject.dismissedSceneIds || []);
  const appliedTextDefaults = new Set(currentProject.studioTextOverlayDefaultsApplied || []);
  const newTextOverlaysCount = (freshFromAiMovie.studioTextOverlayDefaultsApplied || []).filter(
    (sceneId) => !appliedTextDefaults.has(sceneId) &&
      (!dismissedSet.has(sceneId) || sceneHasRealMedia(freshFromAiMovie, sceneId))
  ).length;
  const manifestUpdatedMs = currentProject.updatedAt
    ? new Date(currentProject.updatedAt).getTime()
    : 0;

  let newTakesCount = 0;
  let newDialogueCount = 0;
  let modifiedMediaCount = 0;

  for (const asset of freshFromAiMovie.assets) {
    if (asset.isPlaceholderSlate) continue;
    const existing = existingAssetMap.get(asset.id);
    if (!existing) {
      if (asset.kind === 'video' || asset.isPosterFallback) newTakesCount++;
      if (asset.kind === 'dialogue') newDialogueCount++;
    } else {
      const sourceRelPath = asset.originalRelativePath || asset.relativePath;
      const fullPath = path.join(projectRoot, sourceRelPath);
      let fileModifiedRecently = false;

      if (existing.isNormalized && existing.originalRelativePath) {
        // For normalized narration/SFX/music (`[Norm]`), compare raw file's mtime against the normalized `.mp3`'s mtime!
        const normFullPath = path.join(projectRoot, existing.relativePath);
        if (fs.existsSync(fullPath) && fs.existsSync(normFullPath)) {
          try {
            const rawStat = fs.statSync(fullPath);
            const normStat = fs.statSync(normFullPath);
            if (rawStat.mtimeMs > normStat.mtimeMs + 1000) {
              fileModifiedRecently = true;
            }
          } catch {}
        }
      } else if (fs.existsSync(fullPath)) {
        try {
          const stat = fs.statSync(fullPath);
          const baselineMs = Math.max(manifestUpdatedMs, existing.cacheVersion || 0);
          if (baselineMs > 0 && stat.mtimeMs > baselineMs + 1000) {
            fileModifiedRecently = true;
          }
        } catch {}
      }

      const durationChanged =
        !asset.isPosterFallback &&
        !existing.isNormalized &&
        Math.abs((existing.durationSeconds || 0) - (asset.durationSeconds || 0)) >= 0.15;
      const pathOrTextChanged =
        (existing.originalRelativePath || existing.relativePath) !==
          (asset.originalRelativePath || asset.relativePath) ||
        (asset.kind === 'dialogue' &&
          Boolean(asset.dialogueText) &&
          Boolean(existing.dialogueText) &&
          existing.dialogueText !== asset.dialogueText);

      if (fileModifiedRecently || durationChanged || pathOrTextChanged) {
        modifiedMediaCount++;
      }
    }
  }

  let newScenesCount = 0;
  let durationChangesCount = 0;

  const currentVidTrack = currentProject.timeline.tracks.find((t) => t.type === 'video');
  const freshVidTrack = freshFromAiMovie.timeline.tracks.find((t) => t.type === 'video');
  const freshSceneIds = new Set(freshFromAiMovie.sequence.map((s) => s.id));

  // Detect if a scene currently on the timeline was deleted in Studio
  for (const existingSeq of currentProject.sequence) {
    if (!freshSceneIds.has(existingSeq.id)) {
      durationChangesCount++;
    }
  }

  for (const seq of freshFromAiMovie.sequence) {
    const hasRealAssets = sceneHasRealMedia(freshFromAiMovie, seq.id);
    // If user explicitly deleted/dismissed this blank scene and it still has no real assets in Studio, ignore it!
    if (dismissedSet.has(seq.id) && !hasRealAssets) {
      continue;
    }

    const existingSeq = existingSceneMap.get(seq.id);
    const currClip = currentVidTrack?.clips.find((c) => c.sceneId === seq.id);

    if (!existingSeq || !currClip) {
      // Only flag as a new scene if it wasn't dismissed, or if it gained real media assets
      if (!dismissedSet.has(seq.id) || hasRealAssets) {
        newScenesCount++;
      }
      continue;
    }

    const freshClip = freshVidTrack?.clips.find((c) => c.sceneId === seq.id);
    const currDur = currClip ? Math.round((currClip.sourceOut - currClip.sourceIn) * 10) / 10 : 0;
    const freshDur = freshClip ? Math.round((freshClip.sourceOut - freshClip.sourceIn) * 10) / 10 : 0;

    // Only flag timing change if targetDurationSeconds changed in Studio, or if a poster/slate span changed
    const currAsset = existingAssetMap.get(currClip.assetId);
    if (
      seq.targetDurationSeconds !== existingSeq.targetDurationSeconds ||
      (currAsset?.isPosterFallback && Math.abs(currDur - freshDur) >= 0.2)
    ) {
      durationChangesCount++;
    }
  }

  return {
    hasChanges:
      newTakesCount > 0 ||
      newDialogueCount > 0 ||
      newScenesCount > 0 ||
      durationChangesCount > 0 ||
      modifiedMediaCount > 0 ||
      newTextOverlaysCount > 0,
    aiMovieBusy: false,
    newTakesCount,
    newDialogueCount,
    newScenesCount,
    durationChangesCount,
    modifiedMediaCount,
    ...(newTextOverlaysCount > 0 ? { newTextOverlaysCount } : {}),
  };
}

/**
 * Smart Sync & Ripple (`merge-new-assets`):
 * Pulls in new takes, dialogue, posters, and scene duration changes from `ai-movie.json`,
 * prunes deleted/archived scenes, respects dismissed empty slates, and ripple-shifts
 * scene clips, dialogue clips, and scene headings in sequential order.
 */
export async function mergeNewAssetsFromAiMovie(
  projectRoot: string,
  currentProject: VideoProjectManifest
): Promise<VideoProjectManifest> {
  const aiMovie = readAiMovieReadOnly(projectRoot);
  if (!aiMovie) return currentProject;

  const fresh = await buildProjectFromAiMovie(projectRoot, aiMovie);
  const merged: VideoProjectManifest = JSON.parse(JSON.stringify(currentProject));
  const dismissedSet = new Set<string>(merged.dismissedSceneIds || []);

  // Un-dismiss any scene that now has real media assets generated in Studio
  for (const seq of fresh.sequence) {
    if (dismissedSet.has(seq.id) && sceneHasRealMedia(fresh, seq.id)) {
      dismissedSet.delete(seq.id);
    }
  }
  merged.dismissedSceneIds = Array.from(dismissedSet);

  // Prune any scenes that were deleted in Studio (`ai-movie.json`)
  sanitizeProjectManifest(projectRoot, merged, aiMovie);

  // Re-resolve dead/archived takes, drop unlinked audio and fix stale selections before merging new media
  await reconcileProjectMedia(projectRoot, merged, aiMovie, fresh);

  const existingAssetsById = new Map(merged.assets.map((a) => [a.id, a]));
  const nowVersion = Date.now();
  for (const asset of fresh.assets) {
    if (asset.sceneId && dismissedSet.has(asset.sceneId)) continue;
    const existing = existingAssetsById.get(asset.id);
    if (!existing) {
      asset.cacheVersion = nowVersion;
      merged.assets.push(asset);
      existingAssetsById.set(asset.id, asset);
    } else {
      const sourceRel = asset.originalRelativePath || asset.relativePath;
      const fullPath = path.join(projectRoot, sourceRel);
      let diskMtime = nowVersion;
      if (fs.existsSync(fullPath)) {
        try {
          diskMtime = Math.round(fs.statSync(fullPath).mtimeMs);
        } catch {}
      }
      let normMtime = existing.cacheVersion || 0;
      if (existing.isNormalized && fs.existsSync(path.join(projectRoot, existing.relativePath))) {
        try {
          normMtime = Math.round(
            fs.statSync(path.join(projectRoot, existing.relativePath)).mtimeMs
          );
        } catch {}
      }
      // If underlying raw file was regenerated/updated AFTER the normalized copy was created, revert to raw updated file until re-normalized
      if (
        existing.isNormalized &&
        existing.originalRelativePath &&
        normMtime > 0 &&
        diskMtime > normMtime + 1000
      ) {
        existing.relativePath = asset.relativePath;
        existing.originalRelativePath = undefined;
        existing.isNormalized = false;
      } else if (!existing.isNormalized) {
        existing.relativePath = asset.relativePath;
      }
      existing.durationSeconds = asset.durationSeconds;
      existing.label = asset.label;
      existing.dialogueText = asset.dialogueText ?? existing.dialogueText;
      existing.speaker = asset.speaker ?? existing.speaker;
      existing.isPlaceholderSlate = asset.isPlaceholderSlate;
      existing.isPosterFallback = asset.isPosterFallback;
      existing.cacheVersion = diskMtime;
    }
  }

  // Remove any stale duplicate `[Shared SFX] audio-<timestamp>-<idx>.mp3` that is already a scene dialogue asset
  const sceneDialogueFileNames = new Set(
    merged.assets
      .filter((a) => a.kind === 'dialogue' && a.sceneId)
      .map((a) => path.basename(a.relativePath).toLowerCase())
  );
  merged.assets = merged.assets.filter(
    (a) =>
      !(
        a.source === 'user-imported' &&
        sceneDialogueFileNames.has(path.basename(a.relativePath).toLowerCase())
      )
  );

  const freshVideoTrack = fresh.timeline.tracks.find((t) => t.type === 'video');
  const mergedVideoTrack = merged.timeline.tracks.find((t) => t.type === 'video');
  const freshDlgTrack = fresh.timeline.tracks.find((t) => t.type === 'dialogue');
  const mergedDlgTrack = merged.timeline.tracks.find((t) => t.type === 'dialogue');

  if (freshVideoTrack && mergedVideoTrack) {
    for (const freshClip of freshVideoTrack.clips) {
      if (freshClip.sceneId && dismissedSet.has(freshClip.sceneId)) continue;
      const existingClip = mergedVideoTrack.clips.find(
        (c) => c.sceneId && c.sceneId === freshClip.sceneId
      );
      if (existingClip) {
        const mergedTakes = new Set<string>(freshClip.availableTakeAssetIds || []);
        for (const oldTakeId of existingClip.availableTakeAssetIds || []) {
          if (existingAssetsById.has(oldTakeId)) mergedTakes.add(oldTakeId);
        }
        mergedTakes.add(existingClip.assetId);
        existingClip.availableTakeAssetIds = Array.from(mergedTakes);

        const currentAsset = existingAssetsById.get(existingClip.assetId);
        const freshAsset = existingAssetsById.get(freshClip.assetId);

        // Protect user-imported custom selections: only auto-upgrade if currentAsset is an ai-movie placeholder slate or poster fallback
        if (currentAsset?.source !== 'user-imported') {
          if (
            currentAsset?.isPlaceholderSlate &&
            freshAsset &&
            !freshAsset.isPlaceholderSlate
          ) {
            existingClip.assetId = freshAsset.id;
            existingClip.label = freshClip.label;
            existingClip.sourceIn = 0;
            existingClip.sourceOut = freshClip.sourceOut;
            existingClip.kenBurns = freshClip.kenBurns;
          } else if (
            currentAsset?.isPosterFallback &&
            freshAsset &&
            !freshAsset.isPosterFallback
          ) {
            existingClip.assetId = freshAsset.id;
            existingClip.label = freshClip.label;
            existingClip.sourceIn = 0;
            existingClip.sourceOut = freshAsset.durationSeconds;
            existingClip.kenBurns = 'none';
          } else if (currentAsset?.isPosterFallback) {
            // Update poster/slate duration to match updated Studio scene duration / dialogue span
            existingClip.sourceIn = 0;
            existingClip.sourceOut = freshClip.sourceOut;
          }
        }
      } else {
        mergedVideoTrack.clips.push({ ...freshClip });
      }
    }
  }

  if (freshDlgTrack && mergedDlgTrack) {
    const existingDlgAssetIds = new Set(mergedDlgTrack.clips.map((c) => c.assetId));
    for (const freshDlg of freshDlgTrack.clips) {
      if (freshDlg.sceneId && dismissedSet.has(freshDlg.sceneId)) continue;
      if (!existingDlgAssetIds.has(freshDlg.assetId)) {
        mergedDlgTrack.clips.push({ ...freshDlg });
      } else {
        const existingDlg = mergedDlgTrack.clips.find((c) => c.assetId === freshDlg.assetId);
        const asset = existingAssetsById.get(freshDlg.assetId);
        if (existingDlg && asset && asset.durationSeconds > 0) {
          existingDlg.sourceOut = asset.durationSeconds;
        }
      }
    }
  }

  // Determine active sequence order: preserve existing user sceneOrder on timeline when available,
  // unless Studio specifies explicit `scene.order` / `scene.sceneOrder`.
  const existingOrderBySceneId = new Map<string, number>();
  if (mergedVideoTrack) {
    const sortedExisting = [...mergedVideoTrack.clips]
      .filter((c) => Boolean(c.sceneId))
      .sort((a, b) => (a.sceneOrder ?? 9999) - (b.sceneOrder ?? 9999) || a.timelineStart - b.timelineStart);
    sortedExisting.forEach((c, idx) => {
      if (c.sceneId && !existingOrderBySceneId.has(c.sceneId)) {
        existingOrderBySceneId.set(c.sceneId, c.sceneOrder ?? idx + 1);
      }
    });
  }

  const studioHasExplicitOrders = (aiMovie.scenes || []).some(
    (s) =>
      typeof s.order === 'number' ||
      typeof s.sceneOrder === 'number' ||
      typeof s.properties?.order === 'number' ||
      typeof s.properties?.sceneOrder === 'number'
  );

  const activeSequence = fresh.sequence
    .filter((seq) => !dismissedSet.has(seq.id))
    .sort((a, b) => {
      if (studioHasExplicitOrders) {
        return a.order - b.order;
      }
      const ordA = existingOrderBySceneId.get(a.id) ?? a.order + 1000;
      const ordB = existingOrderBySceneId.get(b.id) ?? b.order + 1000;
      return ordA - ordB;
    })
    .map((seq, idx) => ({ ...seq, order: idx + 1 }));

  // Ripple-reflow all active scenes in sequential order so scene durations,
  // dialogue spans, and Scene Heading markers stay 100% aligned!
  let rippleCursor = 0;
  const freshMarkers = fresh.timeline.markers;
  const updatedMarkers: TimelineMarker[] = [
    ...merged.timeline.markers.filter((m) => m.kind === 'user'),
  ];

  for (let sIdx = 0; sIdx < activeSequence.length; sIdx++) {
    const seq = activeSequence[sIdx];
    const sceneId = seq.id;
    const sceneOrder = seq.order;
    const sceneStart = Math.round(rippleCursor * 100) / 100;

    // Check whether the next scene in `activeSequence` is a silent continuation scene (no dialogue of its own)
    const nextSeq = activeSequence[sIdx + 1];
    const nextSceneHasDialogue = Boolean(
      nextSeq &&
        ((nextSeq.dialogue && nextSeq.dialogue.length > 0) ||
          mergedDlgTrack?.clips.some((c) => c.sceneId === nextSeq.id))
    );
    const nextSceneIsSilentContinuation = Boolean(nextSeq && !nextSceneHasDialogue);

    // 1. Position all of this scene's video/poster/slate sub-clips sequentially starting at sceneStart
    let videoSpan = seq.targetDurationSeconds || 5;
    if (mergedVideoTrack) {
      const sceneVidClips = mergedVideoTrack.clips
        .filter((c) => c.sceneId === sceneId)
        .sort((a, b) => a.timelineStart - b.timelineStart);
      if (sceneVidClips.length > 0) {
        let subCursor = sceneStart;
        for (const vClip of sceneVidClips) {
          vClip.timelineStart = Math.round(subCursor * 100) / 100;
          vClip.sceneOrder = sceneOrder;
          const vDur = getClipTimelineDuration(vClip);
          subCursor = Math.round((subCursor + vDur) * 100) / 100;
        }
        videoSpan = Math.max(0.2, Math.round((subCursor - sceneStart) * 100) / 100);
      }
    }

    // 2. Position scene's dialogue clips sequentially starting at sceneStart
    let dlgOffset = 0;
    if (mergedDlgTrack) {
      const sceneDlgClips = mergedDlgTrack.clips.filter((c) => c.sceneId === sceneId);
      for (const dClip of sceneDlgClips) {
        dClip.timelineStart = Math.round((sceneStart + dlgOffset) * 100) / 100;
        const dDur = getClipTimelineDuration(dClip);
        dlgOffset += dDur + DIALOGUE_PAUSE_SECONDS;
      }
    }
    const totalDlgSpan =
      dlgOffset > 0 ? Math.max(0, dlgOffset - DIALOGUE_PAUSE_SECONDS) : 0;

    // Compute how much earlier spanning audio from an Anchor Scene is still playing when this scene starts
    const dialogueTrackEndSoFar = (mergedDlgTrack?.clips || []).reduce(
      (maxEnd, c) =>
        c.timelineStart <= sceneStart + totalDlgSpan + 0.05
          ? Math.max(maxEnd, c.timelineStart + getClipTimelineDuration(c))
          : maxEnd,
      0
    );
    const remainingSpanningAudio = Math.max(totalDlgSpan, dialogueTrackEndSoFar - sceneStart);

    // Under Scenario 2: only extend the poster/slate if this is the LAST scene in the audio span (`!nextSceneIsSilentContinuation`)
    if (!nextSceneIsSilentContinuation && mergedVideoTrack) {
      const sceneVidClips = mergedVideoTrack.clips.filter((c) => c.sceneId === sceneId);
      const lastVidClip = sceneVidClips[sceneVidClips.length - 1];
      const vidAsset = lastVidClip ? existingAssetsById.get(lastVidClip.assetId) : undefined;
      if (lastVidClip && vidAsset?.isPosterFallback && remainingSpanningAudio > videoSpan) {
        const extraNeeded = Math.ceil(remainingSpanningAudio - videoSpan);
        lastVidClip.sourceOut = Math.round((lastVidClip.sourceOut + extraNeeded) * 100) / 100;
        videoSpan = Math.round((videoSpan + extraNeeded) * 100) / 100;
      }
    }

    // 3. Place Scene Heading marker & camera/SFX markers at sceneStart
    const freshSceneMarkers = freshMarkers.filter((m) => m.sceneId === sceneId);
    const freshSceneRootMarker = freshSceneMarkers.find((m) => m.kind === 'scene');
    const freshOrigin = freshSceneRootMarker ? freshSceneRootMarker.time : 0;

    for (const fm of freshSceneMarkers) {
      const relOffset = Math.max(0, fm.time - freshOrigin);
      updatedMarkers.push({
        ...fm,
        sceneOrder,
        time: Math.round((sceneStart + relOffset) * 100) / 100,
      });
    }

    const nextAdvance = nextSceneIsSilentContinuation
      ? videoSpan
      : Math.max(videoSpan, remainingSpanningAudio);
    rippleCursor = Math.round((sceneStart + nextAdvance) * 100) / 100;
  }

  if (mergedVideoTrack) {
    mergedVideoTrack.clips.sort((a, b) => a.timelineStart - b.timelineStart);
  }
  if (mergedDlgTrack) {
    mergedDlgTrack.clips.sort((a, b) => a.timelineStart - b.timelineStart);
  }

  merged.timeline.markers = updatedMarkers;
  merged.sequence = activeSequence;
  applyStudioTextOverlayDefaults(merged, aiMovie);
  saveVideoProjectManifest(projectRoot, merged);
  return merged;
}

/**
 * Full Rebuild from Studio (`reset-to-ai-movie`):
 * Rebuilds all scenes, takes, dialogue, and markers cleanly from `ai-movie.json`,
 * while preserving user-imported BGM and SFX clips on the Music/SFX tracks.
 */
export async function rebuildProjectFromAiMovie(
  projectRoot: string,
  currentProject?: VideoProjectManifest
): Promise<VideoProjectManifest> {
  const aiMovie = readAiMovieReadOnly(projectRoot);
  if (!aiMovie) {
    return currentProject || createOrLoadStandaloneProject(projectRoot);
  }

  const fresh = await buildProjectFromAiMovie(projectRoot, aiMovie);

  if (currentProject) {
    const freshAssetIds = new Set(fresh.assets.map((a) => a.id));
    for (const oldAsset of currentProject.assets) {
      if (oldAsset.source === 'user-imported' && !freshAssetIds.has(oldAsset.id)) {
        fresh.assets.push(oldAsset);
        freshAssetIds.add(oldAsset.id);
      }
    }

    // Text defaults become editor-owned after import, even when their clips are deleted.
    fresh.timeline.tracks = fresh.timeline.tracks.filter((track) => track.type !== 'text');
    fresh.timeline.tracks.push(...currentProject.timeline.tracks
      .filter((track) => track.type === 'text').map((track) => structuredClone(track)));
    delete fresh.studioTextOverlayDefaultsApplied;
    if (currentProject.studioTextOverlayDefaultsApplied) {
      fresh.studioTextOverlayDefaultsApplied = [...currentProject.studioTextOverlayDefaultsApplied];
    }
    applyStudioTextOverlayDefaults(fresh, aiMovie);
    // Preserve user-placed Music and SFX clips that aren't tied to an AI Movie scene
    for (const trackType of ['music', 'sfx'] as const) {
      const oldTrack = currentProject.timeline.tracks.find((t) => t.type === trackType);
      const newTrack = fresh.timeline.tracks.find((t) => t.type === trackType);
      if (oldTrack && newTrack) {
        newTrack.volume = oldTrack.volume;
        newTrack.muted = oldTrack.muted;
        for (const clip of oldTrack.clips) {
          if (!clip.sceneId && freshAssetIds.has(clip.assetId)) {
            newTrack.clips.push(clip);
          }
        }
      }
    }
  }

  saveVideoProjectManifest(projectRoot, fresh);
  return fresh;
}

/**
 * Refreshes ONLY a single selected clip (and its underlying asset) from disk & `ai-movie.json`
 * without touching or ripple-resetting the rest of the timeline.
 */
export async function refreshSingleClipInProject(
  projectRoot: string,
  currentProject: VideoProjectManifest,
  clipId: string
): Promise<{ project: VideoProjectManifest; refreshedLabel: string; newDurationSeconds: number }> {
  const updated: VideoProjectManifest = JSON.parse(JSON.stringify(currentProject));
  let targetClip: TimelineClip | null = null;
  let targetTrack: TimelineTrack | null = null;

  for (const track of updated.timeline.tracks) {
    const found = track.clips.find((c) => c.id === clipId);
    if (found) {
      targetClip = found;
      targetTrack = track;
      break;
    }
  }

  if (!targetClip || !targetTrack) {
    return { project: currentProject, refreshedLabel: 'Clip', newDurationSeconds: 0 };
  }

  const aiMovie = readAiMovieReadOnly(projectRoot);
  const freshFromAiMovie = aiMovie ? await buildProjectFromAiMovie(projectRoot, aiMovie) : null;
  const nowVersion = Date.now();

  let asset = updated.assets.find((a) => a.id === targetClip!.assetId) || null;

  // If this clip belongs to an AI Movie scene, check if `ai-movie.json` has an updated asset or newly generated take/poster/dialogue for it
  if (freshFromAiMovie) {
    let freshAsset = freshFromAiMovie.assets.find((a) => a.id === targetClip!.assetId);

    // If the clip was a placeholder slate or poster and Studio now has a poster/video for this scene, or if a dialogue line got a new audio ID
    if (targetClip.sceneId) {
      if (targetTrack.type === 'video') {
        const freshVidTrack = freshFromAiMovie.timeline.tracks.find((t) => t.type === 'video');
        const freshSceneClip = freshVidTrack?.clips.find((c) => c.sceneId === targetClip!.sceneId);
        if (freshSceneClip) {
          targetClip.availableTakeAssetIds = freshSceneClip.availableTakeAssetIds;
          // Ensure all available take assets for this scene exist in `updated.assets`
          for (const takeAssetId of freshSceneClip.availableTakeAssetIds || []) {
            const fTake = freshFromAiMovie.assets.find((a) => a.id === takeAssetId);
            if (fTake && !updated.assets.some((a) => a.id === takeAssetId)) {
              updated.assets.push({ ...fTake, cacheVersion: nowVersion });
            }
          }
          // If current asset was a placeholder slate (or missing) and Studio now has a real poster/video, upgrade this clip
          if (!freshAsset || asset?.isPlaceholderSlate) {
            const candidate = freshFromAiMovie.assets.find((a) => a.id === freshSceneClip.assetId);
            if (candidate && !candidate.isPlaceholderSlate) {
              freshAsset = candidate;
              if (!updated.assets.some((a) => a.id === candidate.id)) {
                updated.assets.push(candidate);
              }
              targetClip.assetId = candidate.id;
              asset = updated.assets.find((a) => a.id === candidate.id) || null;
            }
          }
        }
      } else if (targetTrack.type === 'dialogue' && !freshAsset) {
        // Check if the scene's dialogue clip was regenerated under a new audio ID in Studio
        const freshDlgTrack = freshFromAiMovie.timeline.tracks.find((t) => t.type === 'dialogue');
        const sceneFreshDlgs =
          freshDlgTrack?.clips.filter((c) => c.sceneId === targetClip!.sceneId) || [];
        const sceneExistingDlgs = targetTrack.clips.filter((c) => c.sceneId === targetClip!.sceneId);
        const clipIdxInScene = sceneExistingDlgs.findIndex((c) => c.id === targetClip!.id);
        const replacementClip =
          sceneFreshDlgs[clipIdxInScene] || sceneFreshDlgs[sceneFreshDlgs.length - 1];
        if (replacementClip) {
          const candidate = freshFromAiMovie.assets.find((a) => a.id === replacementClip.assetId);
          if (candidate) {
            freshAsset = candidate;
            if (!updated.assets.some((a) => a.id === candidate.id)) {
              updated.assets.push(candidate);
            }
            targetClip.assetId = candidate.id;
            asset = updated.assets.find((a) => a.id === candidate.id) || null;
          }
        }
      }
    }

    if (asset && freshAsset) {
      asset.relativePath = freshAsset.relativePath;
      asset.originalRelativePath = undefined;
      asset.isNormalized = false;
      asset.label = freshAsset.label;
      asset.dialogueText = freshAsset.dialogueText ?? asset.dialogueText;
      asset.speaker = freshAsset.speaker ?? asset.speaker;
      asset.isPlaceholderSlate = freshAsset.isPlaceholderSlate;
      asset.isPosterFallback = freshAsset.isPosterFallback;
    }
  }

  if (!asset) {
    return { project: currentProject, refreshedLabel: targetClip.label, newDurationSeconds: 0 };
  }

  // Re-probe the file on disk (falling back to originalRelativePath if normalized copy was stale)
  const rawRelPath = asset.originalRelativePath || asset.relativePath;
  const fullPath = path.join(projectRoot, rawRelPath);
  if (asset.isNormalized && asset.originalRelativePath && fs.existsSync(fullPath)) {
    asset.relativePath = asset.originalRelativePath;
    asset.originalRelativePath = undefined;
    asset.isNormalized = false;
  }

  let newDur = asset.durationSeconds;
  if (fs.existsSync(fullPath) && asset.kind !== 'image' && !asset.isPosterFallback) {
    const probed = await probeMediaDuration(fullPath);
    if (probed && probed > 0) {
      newDur = Math.round(probed * 100) / 100;
      asset.durationSeconds = newDur;
    }
  }

  asset.cacheVersion = nowVersion;
  targetClip.label = asset.label;

  // If it's an audio/video clip (not a still image hold), update sourceOut to reflect the refreshed file's duration
  if (asset.kind !== 'image' && !asset.isPosterFallback && newDur > 0) {
    targetClip.sourceIn = 0;
    targetClip.sourceOut = newDur;
  }

  // Invalidate any pre-mixed audio cache if an audio clip was refreshed
  if (targetTrack.type !== 'video') {
    updated.preMixedAudioSignature = undefined;
  }

  saveVideoProjectManifest(projectRoot, updated);
  return {
    project: updated,
    refreshedLabel: targetClip.label,
    newDurationSeconds: Math.round((targetClip.sourceOut - targetClip.sourceIn) * 100) / 100,
  };
}

/**
 * Promotes a Standalone Folder project (`projectMode === 'standalone'`) into a full
 * **SpliceWright Studio** project by creating `ai-movie.json` — strictly ONLY when `ai-movie.json`
 * does not already exist on disk (preserving the Read-Only guarantee for existing Studio files).
 *
 * Maps timeline video clips (including OBS chapter sub-clips and speed-ramped segments) into
 * `AiMovieScene` entries (`scene-1`, `scene-2`, ...), extracts `scenes/scene-N/first-frame.png`
 * thumbnails via FFmpeg, and links timeline dialogue/SFX/music clips so the folder opens
 * immediately in SpliceWright Studio.
 */
export async function convertStandaloneToStudioProject(
  projectRoot: string,
  currentProject: VideoProjectManifest
): Promise<LoadedProjectBundle> {
  const aiMoviePath = path.join(projectRoot, 'ai-movie.json');
  if (fs.existsSync(aiMoviePath)) {
    throw new Error(
      'ai-movie.json already exists in this folder and is strictly Read-Only. Use "Sync Studio" instead.'
    );
  }

  const updated: VideoProjectManifest = JSON.parse(JSON.stringify(currentProject));
  const assetMap = new Map<string, ProjectMediaAsset>(updated.assets.map((a) => [a.id, a]));
  const videoTrack = updated.timeline.tracks.find((t) => t.type === 'video');
  const dialogueTrack = updated.timeline.tracks.find((t) => t.type === 'dialogue');
  const sfxTrack = updated.timeline.tracks.find((t) => t.type === 'sfx');

  const sortedVidClips = videoTrack
    ? [...videoTrack.clips].sort((a, b) => a.timelineStart - b.timelineStart)
    : [];

  // Group consecutive clips that already share a `sceneId` (e.g., from Split Clip at Playhead) into one scene,
  // while giving each independent clip or OBS chapter sub-clip its own `scene-N`.
  interface SceneClipGroup {
    sceneId: string;
    order: number;
    clips: TimelineClip[];
  }

  const groups: SceneClipGroup[] = [];
  for (const clip of sortedVidClips) {
    const prevGroup = groups[groups.length - 1];
    if (prevGroup && clip.sceneId && prevGroup.sceneId === clip.sceneId) {
      prevGroup.clips.push(clip);
    } else {
      const order = groups.length + 1;
      const sceneId = `scene-${order}`;
      groups.push({
        sceneId,
        order,
        clips: [clip],
      });
    }
  }

  // Fallback if the user hasn't placed any video clips yet
  if (groups.length === 0) {
    groups.push({
      sceneId: 'scene-1',
      order: 1,
      clips: [],
    });
  }

  const scenes: AiMovieScene[] = [];
  const updatedMarkers: TimelineMarker[] = [
    ...updated.timeline.markers.filter((m) => m.kind === 'user'),
  ];
  const updatedSequence: VideoProjectSequenceItem[] = [];
  const nowTs = Date.now();

  for (let gIdx = 0; gIdx < groups.length; gIdx++) {
    const grp = groups[gIdx];
    const nextGrp = groups[gIdx + 1];
    const { sceneId, order, clips } = grp;

    const sceneDir = path.join(projectRoot, 'scenes', sceneId);
    const sceneVideosDir = path.join(sceneDir, 'videos');
    const sceneAudioDir = path.join(projectRoot, 'audio', sceneId);
    fs.mkdirSync(sceneVideosDir, { recursive: true });
    fs.mkdirSync(sceneAudioDir, { recursive: true });

    const primaryClip = clips[0] || null;
    const primaryAsset = primaryClip ? assetMap.get(primaryClip.assetId) || null : null;

    const rawLabel = primaryClip?.label || `Scene ${order}`;
    const cleanTitle =
      rawLabel
        .replace(/^\[(?:VIDEO|IMAGE|SHARED)[^\]]*\]\s*/i, '')
        .replace(/\s*\(\[.*?\)\s*$/, '')
        .replace(/\.(mp4|mkv|mov|webm|png|jpg|jpeg|webp)$/i, '')
        .trim() || `Scene ${order}`;

    const sceneStart = primaryClip ? primaryClip.timelineStart : 0;
    const sceneVisualDuration =
      clips.length > 0
        ? Math.max(
            1,
            Math.round(
              clips.reduce((sum, c) => sum + getClipTimelineDuration(c), 0) * 100
            ) / 100
          )
        : 5;
    const sceneWindowEnd = nextGrp?.clips[0]
      ? nextGrp.clips[0].timelineStart
      : sceneStart + sceneVisualDuration + 300;

    for (const c of clips) {
      c.sceneId = sceneId;
      c.sceneOrder = order;
    }

    // 1. Create or extract `scenes/scene-N/first-frame.png`
    let firstFrameFileName: string | undefined;
    let posterRelPath: string | null = null;
    if (primaryAsset && !primaryAsset.isPlaceholderSlate) {
      const srcFull = path.join(projectRoot, primaryAsset.relativePath);
      if (fs.existsSync(srcFull)) {
        if (primaryAsset.kind === 'image') {
          const ext = path.extname(srcFull).toLowerCase() || '.png';
          firstFrameFileName = `first-frame${ext}`;
          const destPosterFull = path.join(sceneDir, firstFrameFileName);
          if (path.resolve(srcFull) !== path.resolve(destPosterFull)) {
            fs.copyFileSync(srcFull, destPosterFull);
          }
          posterRelPath = normalizeRelPath(`scenes/${sceneId}/${firstFrameFileName}`);
        } else if (primaryAsset.kind === 'video') {
          firstFrameFileName = 'first-frame.png';
          const destPosterFull = path.join(sceneDir, firstFrameFileName);
          const ok = await extractVideoFrameToPng(
            srcFull,
            primaryClip?.sourceIn || 0,
            destPosterFull
          );
          if (ok) {
            posterRelPath = normalizeRelPath(`scenes/${sceneId}/${firstFrameFileName}`);
          }
        }
      }
    }

    if (posterRelPath) {
      const posterAssetId = `asset_${sceneId}_poster`;
      if (!updated.assets.some((a) => a.id === posterAssetId)) {
        updated.assets.push({
          id: posterAssetId,
          kind: 'image',
          label: `[${cleanTitle}] First Frame Poster`,
          relativePath: posterRelPath,
          durationSeconds: sceneVisualDuration,
          sceneId,
          source: 'ai-movie',
          isPosterFallback: true,
        });
      }
    }

    // 2. Build `scene.videos[]` entry (supporting Scenario 1 shared master video + `segments[]`)
    const sceneVideos: AiMovieVideoTake[] = [];
    let selectedVideoId: string | undefined;

    if (primaryClip && primaryAsset && primaryAsset.kind === 'video') {
      const takeId = `video-${nowTs}-${order}`;
      selectedVideoId = takeId;
      const firstSeg = clips[0];
      const lastSeg = clips[clips.length - 1];
      const takeEntry: AiMovieVideoTake = {
        id: takeId,
        label: cleanTitle,
        fileName: primaryAsset.relativePath,
        source: 'SpliceWright / OBS Recording',
        providerModel: 'external',
        durationSeconds: sceneVisualDuration,
        aspectRatio: updated.format.aspectRatio,
        resolution: `${updated.format.width}x${updated.format.height}`,
        sourceInSeconds: firstSeg.sourceIn,
        sourceOutSeconds: lastSeg.sourceOut,
        playbackRate: firstSeg.playbackRate || 1.0,
        muteSourceAudio: firstSeg.muteSourceAudio ?? false,
        segments:
          clips.length > 1
            ? clips.map((c) => ({
                sourceInSeconds: c.sourceIn,
                sourceOutSeconds: c.sourceOut,
                playbackRate: c.playbackRate || 1.0,
              }))
            : undefined,
      };
      sceneVideos.push(takeEntry);
    }

    // 3. Collect any Dialogue or SFX clips falling inside `[sceneStart, sceneWindowEnd)`
    const sceneAudioAssets: AiMovieAudioAsset[] = [];
    const dialogueLines: string[] = [];

    if (dialogueTrack) {
      const matchingDlgs = dialogueTrack.clips.filter(
        (d) => d.timelineStart >= sceneStart - 0.1 && d.timelineStart < sceneWindowEnd - 0.05
      );
      matchingDlgs.forEach((dClip, dIdx) => {
        dClip.sceneId = sceneId;
        const dAsset = assetMap.get(dClip.assetId);
        if (!dAsset) return;
        dAsset.sceneId = sceneId;
        const lineText = dAsset.dialogueText || dClip.label;
        dialogueLines.push(lineText);
        sceneAudioAssets.push({
          id: `audio-${nowTs}-${order}-${dIdx + 1}`,
          kind: 'dialogue',
          fileName: dAsset.originalRelativePath || dAsset.relativePath,
          dialogueLine: lineText,
          characterId: 'char-narrator',
          durationSeconds: getClipTimelineDuration(dClip),
          status: 'approved',
        });
      });
    }

    if (sfxTrack) {
      const matchingSfx = sfxTrack.clips.filter(
        (s) => s.timelineStart >= sceneStart - 0.1 && s.timelineStart < sceneWindowEnd - 0.05
      );
      matchingSfx.forEach((sClip, sIdx) => {
        sClip.sceneId = sceneId;
        const sAsset = assetMap.get(sClip.assetId);
        if (!sAsset) return;
        sAsset.sceneId = sceneId;
        sceneAudioAssets.push({
          id: `sfx-${nowTs}-${order}-${sIdx + 1}`,
          kind: 'sound-effect',
          fileName: sAsset.originalRelativePath || sAsset.relativePath,
          durationSeconds: getClipTimelineDuration(sClip),
          startTimeSeconds: Math.max(0, Math.round((sClip.timelineStart - sceneStart) * 100) / 100),
          status: 'approved',
        });
      });
    }

    scenes.push({
      id: sceneId,
      title: cleanTitle,
      order,
      sceneOrder: order,
      status: sceneVideos.length > 0 ? 'ready' : 'planned',
      summary: cleanTitle,
      dialogue: dialogueLines.join('\n'),
      durationSeconds: sceneVisualDuration,
      aspectRatio: updated.format.aspectRatio,
      resolution: `${updated.format.width}x${updated.format.height}`,
      characterIds: ['char-narrator'],
      audioAssets: sceneAudioAssets,
      videos: sceneVideos,
      properties: {
        firstFrameFileName,
        selectedVideoId,
        order,
        sceneOrder: order,
      },
    });

    updatedMarkers.push({
      id: `marker_scene_${sceneId}`,
      time: Math.round(sceneStart * 100) / 100,
      label: `Scene ${order}: ${cleanTitle}`,
      kind: 'scene',
      sceneId,
      sceneOrder: order,
      details: cleanTitle,
    });

    updatedSequence.push({
      id: sceneId,
      order,
      title: cleanTitle,
      targetDurationSeconds: sceneVisualDuration,
      aspectRatio: updated.format.aspectRatio,
      resolution: `${updated.format.width}x${updated.format.height}`,
      posterFrame: posterRelPath,
      selectedVideo:
        primaryAsset && primaryAsset.kind === 'video' ? primaryAsset.relativePath : null,
      alternateVideos: [],
      dialogue: [],
      soundEffects: [],
      music: [],
    });
  }

  const aiMovieManifest: AiMovieManifest = {
    schemaVersion: 1,
    projectVersion: 1,
    title: updated.title || path.basename(projectRoot),
    createdAt: new Date().toISOString(),
    options: {
      aspectRatio: updated.format.aspectRatio,
      colorGrade: updated.lookPreset && updated.lookPreset !== 'none' ? updated.lookPreset : undefined,
    },
    characters: [
      {
        id: 'char-narrator',
        name: 'Narrator',
      },
    ],
    scenes,
    storyboards: [],
    editorState: {
      hasUnsavedChanges: false,
      dirtyFormKeys: [],
      pendingOperations: [],
      dirtySince: null,
    },
  };

  // Write `ai-movie.json` once to initialize the Studio project
  fs.writeFileSync(aiMoviePath, JSON.stringify(aiMovieManifest, null, 2), 'utf-8');

  updated.projectMode = 'ai-movie';
  updated.timeline.markers = updatedMarkers;
  updated.sequence = updatedSequence;
  saveVideoProjectManifest(projectRoot, updated);

  const syncSummary = await computeAiMovieSyncSummary(projectRoot, updated);

  return {
    projectRoot,
    project: updated,
    aiMovieStatus: {
      exists: true,
      hasUnsavedChanges: false,
      pendingOperationsCount: 0,
    },
    syncSummary,
  };
}

export async function loadProjectFromFolder(projectRoot: string): Promise<LoadedProjectBundle> {
  const aiMovie = readAiMovieReadOnly(projectRoot);
  const existingManifestPath = findExistingVideoProjectPath(projectRoot);
  let project: VideoProjectManifest;

  if (existingManifestPath) {
    const raw = fs.readFileSync(existingManifestPath, 'utf-8');
    project = JSON.parse(raw) as VideoProjectManifest;
    if (project.normalizeDialogueAudio === undefined) {
      project.normalizeDialogueAudio = true;
    }
    const activeSceneIds = aiMovie
      ? new Set<string>((aiMovie.scenes || []).map((s) => s.id))
      : undefined;
    // Scan shared assets folders (`assets/audio`, `assets/video`, `assets/images`, `audio/`)
    await scanSharedAssetsFolder(projectRoot, project.assets, activeSceneIds);
    // Clean up any orphaned scene markers or deleted/archived scenes on load
    const sanitized = sanitizeProjectManifest(projectRoot, project, aiMovie);
    // Reconcile the saved timeline against media on disk (stale/archived takes, unlinked audio, invalid posters)
    const reconciled = await reconcileProjectMedia(projectRoot, project, aiMovie);
    const textDefaultsAdded = aiMovie ? applyStudioTextOverlayDefaults(project, aiMovie) : false;
    if (sanitized || reconciled || textDefaultsAdded) {
      saveVideoProjectManifest(projectRoot, project);
    }
  } else if (aiMovie) {
    project = await buildProjectFromAiMovie(projectRoot, aiMovie);
    saveVideoProjectManifest(projectRoot, project);
  } else {
    project = await createOrLoadStandaloneProject(projectRoot);
  }

  const syncSummary = aiMovie
    ? await computeAiMovieSyncSummary(projectRoot, project)
    : undefined;

  return {
    projectRoot,
    project,
    aiMovieStatus: {
      exists: Boolean(aiMovie),
      hasUnsavedChanges: Boolean(aiMovie?.editorState?.hasUnsavedChanges),
      pendingOperationsCount: aiMovie?.editorState?.pendingOperations?.length || 0,
    },
    syncSummary,
  };
}

/**
 * Topic 13: Scans a parent Production Folder (or loads `movie-catalogue.json` if present)
 * to discover all child chapter project folders (`ai-movie.json` / `exports/video-project.json` / `exports/*.mp4`),
 * computing live readiness status (`ready`, `outdated`, or `unrendered`) for each chapter.
 */
export async function scanOrLoadStitchCatalogue(productionRoot: string): Promise<StitchCatalogue> {
  const cataloguePath = path.join(productionRoot, 'movie-catalogue.json');
  let existingCatalogue: StitchCatalogue | null = null;
  if (fs.existsSync(cataloguePath)) {
    try {
      existingCatalogue = JSON.parse(fs.readFileSync(cataloguePath, 'utf-8')) as StitchCatalogue;
    } catch {
      existingCatalogue = null;
    }
  }

  const discoveredByFolder = new Map<string, StitchVideoItem>();

  // Helper to inspect a chapter folder
  const inspectChapterDir = async (chapterDir: string) => {
    const aiMoviePath = path.join(chapterDir, 'ai-movie.json');
    const vidProjPath = path.join(chapterDir, 'exports', 'video-project.json');
    const exportsDir = path.join(chapterDir, 'exports');

    const hasAiMovie = fs.existsSync(aiMoviePath);
    const hasVidProj = fs.existsSync(vidProjPath);
    let chapterTitle = path.basename(chapterDir);

    if (hasAiMovie) {
      try {
        const parsed = JSON.parse(fs.readFileSync(aiMoviePath, 'utf-8')) as AiMovieManifest;
        if (parsed.title) chapterTitle = parsed.title;
      } catch {}
    } else if (hasVidProj) {
      try {
        const parsed = JSON.parse(fs.readFileSync(vidProjPath, 'utf-8')) as VideoProjectManifest;
        if (parsed.title) chapterTitle = parsed.title;
      } catch {}
    }

    // Find newest rendered .mp4 inside `exports/`
    let bestMp4Path = '';
    let bestMp4Mtime = 0;
    if (fs.existsSync(exportsDir)) {
      const files = fs.readdirSync(exportsDir);
      for (const f of files) {
        if (!f.toLowerCase().endsWith('.mp4')) continue;
        const full = path.join(exportsDir, f);
        try {
          const st = fs.statSync(full);
          if (st.isFile() && st.mtimeMs >= bestMp4Mtime) {
            bestMp4Mtime = st.mtimeMs;
            bestMp4Path = full;
          }
        } catch {}
      }
    }

    if (!hasAiMovie && !hasVidProj && !bestMp4Path) return;

    let latestSourceMtime = 0;
    if (hasAiMovie) {
      try {
        latestSourceMtime = Math.max(latestSourceMtime, fs.statSync(aiMoviePath).mtimeMs);
      } catch {}
    }
    if (hasVidProj) {
      try {
        latestSourceMtime = Math.max(latestSourceMtime, fs.statSync(vidProjPath).mtimeMs);
      } catch {}
    }

    let status: 'ready' | 'outdated' | 'unrendered' = 'unrendered';
    let durationSeconds = 0;
    let hasCompanionSrt = false;

    if (bestMp4Path && fs.existsSync(bestMp4Path)) {
      durationSeconds = Math.round((await probeMediaDuration(bestMp4Path)) * 100) / 100;
      hasCompanionSrt = fs.existsSync(bestMp4Path.replace(/\.[^.]+$/, '.srt'));
      status = latestSourceMtime > bestMp4Mtime + 2500 ? 'outdated' : 'ready';
    }

    const normDir = path.resolve(chapterDir).toLowerCase();
    discoveredByFolder.set(normDir, {
      filePath: bestMp4Path,
      label: bestMp4Path ? `${chapterTitle} (${path.basename(bestMp4Path)})` : `${chapterTitle} (Not Exported Yet)`,
      durationSeconds,
      hasCompanionSrt,
      chapterFolderPath: chapterDir,
      chapterTitle,
      status,
    });
  };

  // Scan immediate subdirectories of `productionRoot`
  if (fs.existsSync(productionRoot)) {
    const entries = fs.readdirSync(productionRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (isArchiveOrIgnoredFolderName(entry.name) || entry.name === 'exports' || entry.name === 'assets' || entry.name === 'scenes' || entry.name === 'audio') {
        continue;
      }
      await inspectChapterDir(path.join(productionRoot, entry.name));
    }
  }

  const mergedItems: StitchVideoItem[] = [];
  const seenFolders = new Set<string>();

  if (existingCatalogue && Array.isArray(existingCatalogue.items)) {
    for (const oldItem of existingCatalogue.items) {
      if (oldItem.chapterFolderPath) {
        const key = path.resolve(oldItem.chapterFolderPath).toLowerCase();
        const refreshed = discoveredByFolder.get(key);
        if (refreshed) {
          mergedItems.push(refreshed);
          seenFolders.add(key);
          continue;
        }
      }
      if (oldItem.filePath && fs.existsSync(oldItem.filePath)) {
        const dur = oldItem.durationSeconds || Math.round((await probeMediaDuration(oldItem.filePath)) * 100) / 100;
        mergedItems.push({
          ...oldItem,
          durationSeconds: dur,
          hasCompanionSrt: fs.existsSync(oldItem.filePath.replace(/\.[^.]+$/, '.srt')),
          status: 'ready',
        });
      }
    }
  }

  for (const [key, item] of discoveredByFolder.entries()) {
    if (!seenFolders.has(key)) {
      mergedItems.push(item);
    }
  }

  const catalogue: StitchCatalogue = {
    schemaVersion: '1.0',
    productionRoot,
    title: existingCatalogue?.title || path.basename(productionRoot),
    updatedAt: new Date().toISOString(),
    outputFilePath:
      existingCatalogue?.outputFilePath || path.join(productionRoot, 'full-stitched-movie.mp4'),
    spacerSeconds: existingCatalogue?.spacerSeconds ?? 0,
    mergeSubtitles: existingCatalogue?.mergeSubtitles ?? true,
    items: mergedItems,
  };

  saveStitchCatalogueToDisk(catalogue);
  return catalogue;
}

export function saveStitchCatalogueToDisk(catalogue: StitchCatalogue): string {
  const targetPath = path.join(catalogue.productionRoot, 'movie-catalogue.json');
  catalogue.updatedAt = new Date().toISOString();
  fs.writeFileSync(targetPath, JSON.stringify(catalogue, null, 2), 'utf-8');
  return targetPath;
}
