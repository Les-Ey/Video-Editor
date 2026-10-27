import fs from 'fs';
import path from 'path';
import {
  AiMovieManifest,
  AiMovieSyncSummary,
  KenBurnsPreset,
  LoadedProjectBundle,
  MediaAssetKind,
  ProjectMediaAsset,
  StitchCatalogue,
  StitchVideoItem,
  TimelineClip,
  TimelineMarker,
  TimelineTrack,
  VideoProjectFormat,
  VideoProjectManifest,
  VideoProjectSequenceItem,
  VisualLookPreset,
} from '../shared/types';
import { probeMediaDuration } from './hardware';

const DIALOGUE_PAUSE_SECONDS = 0.25;

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
        if (fs.existsSync(path.join(projectRoot, candidate))) {
          posterRelPath = candidate;
          break;
        }
      }
    }

    // Fallback: check if scene.notes references an image in `assets/images/...`
    if ((!posterRelPath || !fs.existsSync(path.join(projectRoot, posterRelPath))) && typeof scene.notes === 'string') {
      const imgMatch = scene.notes.match(/(assets\/images\/[^\s,;)]+\.(?:png|jpg|jpeg|webp))/i);
      if (imgMatch && fs.existsSync(path.join(projectRoot, imgMatch[1]))) {
        posterRelPath = normalizeRelPath(imgMatch[1]);
      }
    }

    let posterAssetId: string | null = null;
    if (posterRelPath && fs.existsSync(path.join(projectRoot, posterRelPath))) {
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

    // 2. Resolve Scene Video Takes (`scenes/<scene-id>/videos/video-<timestamp>.mp4`)
    const sceneTakeAssetIds: string[] = [];
    const alternateVideos: VideoProjectSequenceItem['alternateVideos'] = [];
    const registeredSceneVideoPaths = new Set<string>();

    for (let tIdx = 0; tIdx < (scene.videos || []).length; tIdx++) {
      const take = scene.videos![tIdx];
      const relPath = take.fileName.startsWith('scenes/')
        ? normalizeRelPath(take.fileName)
        : normalizeRelPath(`scenes/${scene.id}/videos/${path.basename(take.fileName)}`);

      const fullVideoPath = path.join(projectRoot, relPath);
      const probedDur =
        (!take.durationSeconds || take.durationSeconds <= 0) && fs.existsSync(fullVideoPath)
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

    // 3. Resolve Audio Assets (`scene.audioAssets[]` AND `audio/<scene-id>/` on disk)
    // Per Section 7.3: exclude `rejected`, and if multiple takes exist for the same dialogue line, prefer `approved`.
    const nonRejectedAudio = (scene.audioAssets || []).filter((a) => a.status !== 'rejected');
    const approvedLines = new Set<string>();
    for (const a of nonRejectedAudio) {
      if (
        (a.kind === 'dialogue' || a.kind === 'voiceover') &&
        a.status === 'approved' &&
        a.dialogueLine
      ) {
        approvedLines.add(`${a.characterId || ''}::${a.dialogueLine.trim().toLowerCase()}`);
      }
    }
    const validAudio = nonRejectedAudio.filter((a) => {
      if (
        (a.kind === 'dialogue' || a.kind === 'voiceover') &&
        a.dialogueLine &&
        a.status !== 'approved'
      ) {
        const key = `${a.characterId || ''}::${a.dialogueLine.trim().toLowerCase()}`;
        if (approvedLines.has(key)) {
          return false; // Prefer the approved take for this dialogue line
        }
      }
      return true;
    });
    const registeredAudioPaths = new Set<string>();
    for (const a of validAudio) {
      const norm = a.fileName.startsWith('audio/') || a.fileName.startsWith('assets/')
        ? normalizeRelPath(a.fileName)
        : normalizeRelPath(`audio/${scene.id}/${path.basename(a.fileName)}`);
      registeredAudioPaths.add(norm);
    }

    // Also scan `audio/<scene-id>/` on disk so any generated MP3/WAV in `audio/<scene-id>/` is ALWAYS found
    const sceneAudioDir = path.join(projectRoot, 'audio', scene.id);
    if (fs.existsSync(sceneAudioDir)) {
      const diskAudioFiles = fs.readdirSync(sceneAudioDir).sort();
      const sceneDialogueLines = (scene.dialogue || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);

      let diskIdx = 0;
      for (const file of diskAudioFiles) {
        const ext = path.extname(file).toLowerCase();
        if (!['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'].includes(ext)) continue;
        const relPath = normalizeRelPath(`audio/${scene.id}/${file}`);
        if (registeredAudioPaths.has(relPath)) continue;

        const baseId = path.basename(file, ext);
        const inferredLine = sceneDialogueLines[diskIdx] || scene.dialogue || scene.title;
        diskIdx++;

        validAudio.push({
          id: baseId,
          kind: 'dialogue',
          fileName: relPath,
          dialogueLine: inferredLine,
          characterId: scene.characterIds?.[0],
          durationSeconds: 0,
          status: 'generated',
        });
        registeredAudioPaths.add(relPath);
      }
    }

    let dialogueOffsetInScene = 0;
    const sequenceDialogue: VideoProjectSequenceItem['dialogue'] = [];
    const sequenceSfx: VideoProjectSequenceItem['soundEffects'] = [];
    const sequenceMusic: VideoProjectSequenceItem['music'] = [];

    let dialogueIndex = 0;
    for (const aud of validAudio) {
      let relPath =
        aud.fileName.startsWith('audio/') || aud.fileName.startsWith('assets/')
          ? normalizeRelPath(aud.fileName)
          : normalizeRelPath(`audio/${scene.id}/${path.basename(aud.fileName)}`);

      // If `audio/<scene-id>/<file>` is missing, check `assets/audio/<file>` fallback
      if (!fs.existsSync(path.join(projectRoot, relPath))) {
        const fallbackInAssets = normalizeRelPath(`assets/audio/${path.basename(aud.fileName)}`);
        if (fs.existsSync(path.join(projectRoot, fallbackInAssets))) {
          relPath = fallbackInAssets;
        }
      }

      const fullAudioPath = path.join(projectRoot, relPath);
      let duration = aud.durationSeconds || 0;
      if ((!duration || duration <= 0) && fs.existsSync(fullAudioPath)) {
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
    const scenePanels = panelsByScene.get(scene.id) || [];
    const primaryCameraDir = scenePanels.find((p) => p.cameraDirection)?.cameraDirection || scene.summary;

    const totalDialogueSpan =
      dialogueOffsetInScene > 0 ? Math.max(0, dialogueOffsetInScene - DIALOGUE_PAUSE_SECONDS) : 0;
    const targetDuration = scene.durationSeconds || 5;
    const effectiveStillSpan = Math.max(targetDuration, Math.ceil(totalDialogueSpan));

    if (!heroAssetId) {
      const slateAssetId = `asset_${scene.id}_slate`;
      assets.push({
        id: slateAssetId,
        kind: 'image',
        label: `[${scene.title}] Scene Slate (No Graphic Yet)`,
        relativePath: `__slate__/${scene.id}`,
        durationSeconds: effectiveStillSpan,
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
    if (heroAsset && heroAsset.isPosterFallback) {
      heroAsset.durationSeconds = effectiveStillSpan;
    }

    const clipDuration = heroAsset
      ? heroAsset.isPosterFallback
        ? effectiveStillSpan
        : heroAsset.durationSeconds
      : effectiveStillSpan;

    if (heroAsset) {
      const isStillHero =
        (heroAsset.kind === 'image' || Boolean(heroAsset.isPosterFallback)) &&
        !heroAsset.isPlaceholderSlate;
      const suffix = heroAsset.isPlaceholderSlate
        ? 'Scene Slate — No Graphic Yet'
        : heroAsset.isPosterFallback
        ? 'Poster Frame'
        : 'Video';
      videoTrack.clips.push({
        id: `clip_vid_${scene.id}`,
        assetId: heroAsset.id,
        trackId: videoTrack.id,
        sceneId: scene.id,
        sceneOrder,
        label: `${scene.title} (${suffix})`,
        timelineStart: Math.round(sceneStart * 100) / 100,
        sourceIn: 0,
        sourceOut: clipDuration,
        volume: 1.0,
        kenBurns: isStillHero
          ? inferKenBurnsFromCameraDirection(primaryCameraDir, 'zoom-in')
          : 'none',
        availableTakeAssetIds: sceneTakeAssetIds,
      });
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

    timelineCursor = Math.round((sceneStart + Math.max(clipDuration, totalDialogueSpan)) * 100) / 100;
  }

  // 6. Scan `assets/audio/` and `assets/video/` for any shared BGM, SFX, or video clips
  await scanSharedAssetsFolder(projectRoot, assets, activeSceneIds);

  return {
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
        // If `ai-movie.json` is active and a `scene-*` folder is no longer in `activeSceneIds` (e.g. scene-2 deleted), skip it
        if (
          activeSceneIds &&
          activeSceneIds.size > 0 &&
          entry.name.toLowerCase().startsWith('scene-') &&
          !activeSceneIds.has(entry.name)
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
  return targetPath;
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

  let newTakesCount = 0;
  let newDialogueCount = 0;
  for (const asset of freshFromAiMovie.assets) {
    if (asset.isPlaceholderSlate) continue;
    if (!existingAssetMap.has(asset.id)) {
      if (asset.kind === 'video' || asset.isPosterFallback) newTakesCount++;
      if (asset.kind === 'dialogue') newDialogueCount++;
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
      durationChangesCount > 0,
    aiMovieBusy: false,
    newTakesCount,
    newDialogueCount,
    newScenesCount,
    durationChangesCount,
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

  const existingAssetsById = new Map(merged.assets.map((a) => [a.id, a]));
  for (const asset of fresh.assets) {
    if (asset.sceneId && dismissedSet.has(asset.sceneId)) continue;
    const existing = existingAssetsById.get(asset.id);
    if (!existing) {
      merged.assets.push(asset);
      existingAssetsById.set(asset.id, asset);
    } else {
      existing.durationSeconds = asset.durationSeconds;
      existing.relativePath = asset.relativePath;
      existing.label = asset.label;
      existing.isPlaceholderSlate = asset.isPlaceholderSlate;
      existing.isPosterFallback = asset.isPosterFallback;
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
        existingClip.availableTakeAssetIds = freshClip.availableTakeAssetIds;
        const currentAsset = existingAssetsById.get(existingClip.assetId);
        const freshAsset = existingAssetsById.get(freshClip.assetId);

        // Upgrade from Placeholder Slate -> Poster or Video, or from Poster -> Video
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

  for (const seq of activeSequence) {
    const sceneId = seq.id;
    const sceneOrder = seq.order;
    const sceneStart = Math.round(rippleCursor * 100) / 100;

    // 1. Position scene's video/poster/slate clip at sceneStart
    let videoSpan = seq.targetDurationSeconds || 5;
    if (mergedVideoTrack) {
      const vidClip = mergedVideoTrack.clips.find((c) => c.sceneId === sceneId);
      if (vidClip) {
        vidClip.timelineStart = sceneStart;
        vidClip.sceneOrder = sceneOrder;
        videoSpan = Math.max(0.2, vidClip.sourceOut - vidClip.sourceIn);
      }
    }

    // 2. Position scene's dialogue clips sequentially starting at sceneStart
    let dlgOffset = 0;
    if (mergedDlgTrack) {
      const sceneDlgClips = mergedDlgTrack.clips.filter((c) => c.sceneId === sceneId);
      for (const dClip of sceneDlgClips) {
        dClip.timelineStart = Math.round((sceneStart + dlgOffset) * 100) / 100;
        const dDur = Math.max(0.2, dClip.sourceOut - dClip.sourceIn);
        dlgOffset += dDur + DIALOGUE_PAUSE_SECONDS;
      }
    }
    const totalDlgSpan =
      dlgOffset > 0 ? Math.max(0, dlgOffset - DIALOGUE_PAUSE_SECONDS) : 0;

    // If the scene clip is a poster or slate and dialogue is longer than videoSpan, extend it
    if (mergedVideoTrack) {
      const vidClip = mergedVideoTrack.clips.find((c) => c.sceneId === sceneId);
      const vidAsset = vidClip ? existingAssetsById.get(vidClip.assetId) : undefined;
      if (vidClip && vidAsset?.isPosterFallback && totalDlgSpan > videoSpan) {
        videoSpan = Math.ceil(totalDlgSpan);
        vidClip.sourceOut = videoSpan;
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

    rippleCursor = Math.round((sceneStart + Math.max(videoSpan, totalDlgSpan)) * 100) / 100;
  }

  if (mergedVideoTrack) {
    mergedVideoTrack.clips.sort((a, b) => a.timelineStart - b.timelineStart);
  }
  if (mergedDlgTrack) {
    mergedDlgTrack.clips.sort((a, b) => a.timelineStart - b.timelineStart);
  }

  merged.timeline.markers = updatedMarkers;
  merged.sequence = activeSequence;
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
    if (sanitizeProjectManifest(projectRoot, project, aiMovie)) {
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
