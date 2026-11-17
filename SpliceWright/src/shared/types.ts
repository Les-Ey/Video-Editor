// ============================================================================
// SpliceWright — Shared Types & Schema Contracts
// ============================================================================
// Supports:
// 1. Read-Only monitoring of AI Movies `ai-movie.json`
// 2. Persistent read/write of `exports/video-project.json`
// 3. Standalone Folder Workflow (importing arbitrary video/audio/image files)
// 4. Adaptive hardware profile & FFmpeg export pipeline
// ============================================================================

// --- 1. Canonical AI Movies Schema (`ai-movie.json` - Read-Only) ---

export interface AiMovieCharacter {
  id: string;
  name: string;
  voice?: string;
}

export interface AiMovieAudioAsset {
  id: string;
  kind: 'dialogue' | 'voiceover' | 'music' | 'sound-effect' | 'mix';
  fileName: string; // e.g. "audio/scene-1/audio-1730001000-1.mp3"
  source?: string;
  providerModel?: string;
  dialogueLine?: string; // e.g. "Maya: We should go before the gate locks."
  characterId?: string;
  durationSeconds: number;
  status?: 'generated' | 'approved' | 'rejected';
  startTimeSeconds?: number;
}

export interface AiMovieVideoSegment {
  sourceInSeconds: number;
  sourceOutSeconds: number;
  playbackRate?: number;
}

export interface AiMovieVideoTake {
  id: string;
  label?: string;
  fileName: string; // e.g. "scenes/scene-1/videos/video-1730002000.mp4" or "assets/video/obs-demo.mp4"
  source?: string;
  providerModel?: string;
  prompt?: string;
  createdAt?: string;
  durationSeconds: number;
  aspectRatio?: string;
  resolution?: string;
  /** Scenario 1 (Section 8): Non-destructive trim, speed & source audio controls */
  sourceInSeconds?: number;
  sourceOutSeconds?: number;
  playbackRate?: number;
  muteSourceAudio?: boolean;
  fitMode?: ClipFitMode;
  kenBurns?: KenBurnsPreset;
  segments?: AiMovieVideoSegment[];
  properties?: Record<string, unknown>;
}

export interface AiMovieScene {
  id: string;
  title: string;
  order?: number;
  sceneOrder?: number;
  status?: string;
  summary?: string;
  dialogue?: string;
  /** Optional initial editor text; the editor takes ownership after first import. */
  defaultTextOverlay?: string;
  notes?: string;
  durationSeconds: number;
  aspectRatio?: string;
  resolution?: string;
  characterIds?: string[];
  audioAssets?: AiMovieAudioAsset[];
  videos?: AiMovieVideoTake[];
  properties?: {
    firstFrameFileName?: string; // e.g. "first-frame.png" (resolve under scenes/<scene-id>/)
    selectedVideoId?: string; // e.g. "video-1730002000" (Studio v0.0.66+ preferred take)
    order?: number;
    sceneOrder?: number;
    fitMode?: ClipFitMode;
    kenBurns?: KenBurnsPreset;
    [key: string]: unknown;
  };
}

export interface AiMovieStoryboardPanel {
  id: string;
  title?: string;
  cameraDirection?: string;
  sceneId?: string;
  dialogue?: string;
  soundEffects?: string;
  dialogueTags?: string[];
}

export interface AiMovieStoryboard {
  id: string;
  title: string;
  sceneIds: string[];
  panels?: AiMovieStoryboardPanel[];
  videos?: AiMovieVideoTake[];
}

export interface AiMovieEditorState {
  hasUnsavedChanges?: boolean;
  dirtyFormKeys?: string[];
  pendingOperations?: unknown[];
  dirtySince?: string | null;
}

export interface AiMovieManifest {
  schemaVersion?: number;
  projectVersion?: number;
  title: string;
  createdAt?: string;
  options?: {
    aspectRatio?: string; // "16:9", "9:16", "1:1", "21:9", "4:3"
    colorGrade?: string;
    accentColors?: string;
    mutedColors?: string;
    characterVaultPath?: string;
  };
  characters?: AiMovieCharacter[];
  scenes: AiMovieScene[];
  storyboards?: AiMovieStoryboard[];
  editorState?: AiMovieEditorState;
}

// --- 2. SpliceWright Editor Asset & Timeline Schema (`exports/video-project.json`) ---

export type MediaAssetKind = 'video' | 'image' | 'dialogue' | 'sfx' | 'music';

export interface ProjectMediaAsset {
  id: string;
  kind: MediaAssetKind;
  label: string;
  /** Always normalized relative to the project root with forward slashes (`/`) */
  relativePath: string;
  durationSeconds: number;
  sceneId?: string;
  storyboardId?: string;
  speaker?: string;
  characterId?: string;
  dialogueText?: string;
  aspectRatio?: string;
  resolution?: string;
  source: 'ai-movie' | 'user-imported';
  isPosterFallback?: boolean;
  isPlaceholderSlate?: boolean;
  originalRelativePath?: string;
  isNormalized?: boolean;
  /** Cache-busting revision timestamp when the underlying file on disk is refreshed in-place */
  cacheVersion?: number;
  /** Scenario 1 (Section 8): Embedded OBS / video chapter markers discovered via ffprobe */
  probedChapters?: Array<{
    id: string;
    title: string;
    startTimeSeconds: number;
    endTimeSeconds: number;
  }>;
}

export type TrackType = 'video' | 'dialogue' | 'sfx' | 'music' | 'text';

export interface TextOverlay {
  text: string;
  fontFamily: 'sans-serif' | 'serif' | 'monospace';
  /** Font size in output-frame pixels. */
  fontSize: number;
  color: string;
  /** Optional background behind the text, with opacity from 0 to 1. */
  background?: { color: string; opacity: number };
  /** Top-left position as fractions of the output frame, independent of media motion. */
  x: number;
  y: number;
}

export type KenBurnsPreset =
  | 'none'
  | 'zoom-in'
  | 'zoom-out'
  | 'pan-top-to-bottom'
  | 'pan-bottom-to-top'
  | 'pan-left-to-right'
  | 'pan-right-to-left'
  | 'zoom-in-top-left'
  | 'zoom-in-top-right'
  | 'zoom-in-bottom'
  | 'star-wars-crawl';

export type ClipFitMode =
  | 'contain'
  | 'stretch-fill'
  | 'fill-width'
  | 'fill-height'
  | 'cover-crop';

export type ImageBackground = 'black' | 'mottled' | 'softened';

export const IMAGE_BACKGROUND_LABELS: Record<ImageBackground, string> = {
  black: 'Plain (Black)',
  mottled: 'Mottled',
  softened: 'Softened Image',
};

export const CLIP_FIT_MODE_LABELS: Record<ClipFitMode, string> = {
  contain: '1. Fit Inside (Letterbox / Pillarbox — Default)',
  'stretch-fill': '2. Stretch to Fill Frame (Stretch Wide 16:9 / Stretch Tall 9:16)',
  'fill-width': '3. Fit Full Width (Wide 16:9 — Ideal for Document Scroll)',
  'fill-height': '4. Fit Full Height (Tall 9:16 — Ideal for Horizontal Pan)',
  'cover-crop': '5. Zoom to Fill / Cover (No Black Bars)',
};

export type VisualLookPreset =
  | 'none'
  | 'cinematic'
  | 'monochrome'
  | 'vintage-film'
  | 'vintage-film-crackle'
  | 'muted';

export const VISUAL_LOOK_PRESET_LABELS: Record<VisualLookPreset, string> = {
  none: 'Clean Original (No Look Filter)',
  cinematic: 'Cinematic Contrast & Warm/Cool Grade',
  monochrome: 'Noir Monochrome (Silver B&W + Vignette)',
  'vintage-film': '1920s Vintage Film (Sepia + Film Grain + Vignette)',
  'vintage-film-crackle': 'Old Film + Vintage Projector Audio (300Hz–3.2kHz + Crackle)',
  muted: 'Muted Documentary (Desaturated Bleach-Bypass)',
};

export const KEN_BURNS_PRESET_LABELS: Record<KenBurnsPreset, string> = {
  none: '1. None (Static Hold)',
  'zoom-in': '2. Slow Zoom In (Center Push-In)',
  'zoom-out': '3. Slow Zoom Out (Pull-Back)',
  'pan-top-to-bottom': '4a. Pan Top-to-Bottom (Document Scroll)',
  'pan-bottom-to-top': '4b. Pan Bottom-to-Top (Reverse Scroll)',
  'pan-left-to-right': '5a. Pan Left-to-Right (Horizontal Drift)',
  'pan-right-to-left': '5b. Pan Right-to-Left (Horizontal Drift)',
  'zoom-in-top-left': '6a. Zoom In Top-Left Corner',
  'zoom-in-top-right': '6b. Zoom In Top-Right Corner',
  'zoom-in-bottom': '6c. Zoom In Bottom / Timeline Area',
  'star-wars-crawl': '7. Star Wars Crawl (3D Perspective Scroll)',
};

export interface TimelineClip {
  id: string;
  assetId: string;
  trackId: string;
  sceneId?: string;
  /** 1-based sequential scene order (decoupled from sceneId name gaps like scene-1, scene-3) */
  sceneOrder?: number;
  label: string;
  /** Start time on the timeline (seconds) */
  timelineStart: number;
  /** Trim start within the source file (seconds) */
  sourceIn: number;
  /** Trim end within the source file (seconds) */
  sourceOut: number;
  /** Clip volume (0.0 to 1.5, default 1.0) */
  volume: number;
  fadeIn?: number;
  fadeOut?: number;
  /** Camera motion / Ken Burns effect for still images (or video reframing) */
  kenBurns?: KenBurnsPreset;
  /** Aspect-ratio framing / stretch mode (default 'contain') */
  fitMode?: ClipFitMode;
  /** Stationary still-image backdrop; omitted settings retain the original black framing. */
  imageBackground?: ImageBackground;
  /** Generated text clips live on a text track and have no source media asset. */
  textOverlay?: TextOverlay;
  /** Scenario 1 (Section 8): Playback speed multiplier (default 1.0, e.g. 0.5 to 4.0) */
  playbackRate?: number;
  /** Scenario 1 (Section 8): Whether to mute embedded audio on a video clip (default true when scene has dialogue) */
  muteSourceAudio?: boolean;
  /** Available video takes for this scene (allows 1-click take switching on timeline) */
  availableTakeAssetIds?: string[];
  /** Set on load when this clip's media file is missing, archived, or not a valid image (shows a "Missing media" state) */
  missingMedia?: boolean;
}

/**
 * Computes the effective timeline duration of a clip in seconds:
 * `(sourceOut - sourceIn) / (playbackRate || 1.0)`
 */
export function getClipTimelineDuration(
  clip: Pick<TimelineClip, 'sourceIn' | 'sourceOut' | 'playbackRate'>
): number {
  const rawSpan = Math.max(0.1, (clip.sourceOut || 0) - (clip.sourceIn || 0));
  const rate = clip.playbackRate && clip.playbackRate > 0 ? clip.playbackRate : 1.0;
  return Math.max(0.1, Math.round((rawSpan / rate) * 100) / 100);
}

export interface TimelineTrack {
  id: string;
  name: string;
  type: TrackType;
  volume: number;
  muted: boolean;
  locked?: boolean;
  /** Whether overlapping sub-lanes are vertically expanded in the timeline UI */
  expanded?: boolean;
  clips: TimelineClip[];
}

export interface TimelineMarker {
  id: string;
  time: number;
  label: string;
  kind: 'scene' | 'sfx-cue' | 'camera-cue' | 'user';
  sceneId?: string;
  sceneOrder?: number;
  panelId?: string;
  details?: string;
}

export interface VideoProjectFormat {
  aspectRatio: string; // e.g. "16:9", "9:16", "1:1"
  width: number;
  height: number;
  fps: number;
}

export interface VideoProjectSequenceItem {
  id: string;
  order: number;
  title: string;
  targetDurationSeconds: number;
  aspectRatio: string;
  resolution: string;
  posterFrame: string | null;
  selectedVideo: string | null;
  alternateVideos: Array<{
    id: string;
    label: string;
    path: string;
    durationSeconds: number;
  }>;
  dialogue: Array<{
    id: string;
    order: number;
    speaker: string;
    characterId?: string;
    text: string;
    path: string;
    durationSeconds: number;
  }>;
  soundEffects: Array<{
    id: string;
    label: string;
    path: string;
    durationSeconds: number;
    startTimeSeconds: number;
  }>;
  music: Array<{
    id: string;
    label: string;
    path: string;
    durationSeconds: number;
  }>;
}

export interface VideoProjectManifest {
  schemaVersion: '1.0';
  appName: 'SpliceWright';
  projectMode: 'ai-movie' | 'standalone';
  title: string;
  updatedAt: string;
  format: VideoProjectFormat;
  autoDuckMusicUnderDialogue: boolean;
  duckingVolumeRatio: number; // e.g. 0.25 (25% volume when dialogue is active)
  /** Smooths intra-clip volume drops and levels clip-to-clip loudness (-16 LUFS / dynaudnorm) */
  normalizeDialogueAudio?: boolean;
  /** Non-destructive project-wide visual grade & optional vintage audio character (Topic 12) */
  lookPreset?: VisualLookPreset;
  /** Scene IDs explicitly deleted/dismissed on the timeline so Sync Studio does not resurrect empty slates */
  dismissedSceneIds?: string[];
  /** Scenes whose Studio text default was consumed, including overlays later deleted by the editor. */
  studioTextOverlayDefaultsApplied?: string[];
  /** Relative path to pre-mixed master audio MP3 (`exports/.cache/preview-audio-mix.mp3`) for zero-lag live preview */
  preMixedAudioRelativePath?: string;
  /** Signature of audio tracks when `preMixedAudioRelativePath` was rendered */
  preMixedAudioSignature?: string;
  assets: ProjectMediaAsset[];
  timeline: {
    tracks: TimelineTrack[];
    markers: TimelineMarker[];
  };
  /** Flattened sequence export compatible with `what-editor-app-needs-to-know.md` Section 4 */
  sequence: VideoProjectSequenceItem[];
}

// --- 3. Adaptive Hardware & Export Types ---

export type ExportPreset = 'fast-draft' | 'balanced' | 'high-quality';

export interface HardwareProfile {
  cpuCores: number;
  totalMemoryGb: number;
  tier: 'low-spec' | 'mid-spec' | 'high-spec';
  /** Number of <video> elements to keep preloaded in the lookahead pool */
  recommendedVideoPoolSize: number;
  availableEncoders: string[];
  preferredEncoder: string; // e.g. 'h264_nvenc' | 'h264_qsv' | 'h264_amf' | 'h264_mf' | 'libx264'
}

export interface ExportOptions {
  outputFileName: string;
  preset: ExportPreset;
  encoder: string;
  burnSubtitles: boolean;
  exportSrtFile: boolean;
  exportFcpxml?: boolean;
}

export interface ExportProgressEvent {
  phase: 'preparing' | 'rendering-video' | 'mixing-audio' | 'finalizing' | 'complete' | 'error';
  percent: number;
  message: string;
  outputPath?: string;
  srtPath?: string;
  fcpxmlPath?: string;
}

export interface StitchVideoItem {
  filePath: string;
  label: string;
  durationSeconds: number;
  hasCompanionSrt: boolean;
  /** Optional chapter project folder path when loaded via a Production Catalogue (Topic 13) */
  chapterFolderPath?: string;
  chapterTitle?: string;
  status?: 'ready' | 'outdated' | 'unrendered';
}

export interface StitchCatalogue {
  schemaVersion: '1.0';
  productionRoot: string;
  title: string;
  updatedAt: string;
  outputFilePath: string;
  spacerSeconds: number;
  mergeSubtitles: boolean;
  items: StitchVideoItem[];
}

export interface StitchChaptersOptions {
  items: StitchVideoItem[];
  outputFilePath: string;
  spacerSeconds: number;
  mergeSubtitles: boolean;
}

export interface StudioUpdateAddedAssetEntry {
  id: string;
  kind: MediaAssetKind;
  label: string;
  relativePath: string;
  durationSeconds: number;
  sceneId?: string;
  sceneOrder?: number;
  assignment: 'assigned-scene' | 'new-scene' | 'shared-project';
  placedAtTimelineSeconds?: number;
  sourceInSeconds?: number;
  sourceOutSeconds?: number;
  playbackRate?: number;
  muteSourceAudio?: boolean;
  fitMode?: ClipFitMode;
  kenBurns?: KenBurnsPreset;
  addedAt: string;
}

export interface StudioUpdateSceneTimelineEntry {
  sceneId: string;
  sceneOrder: number;
  title: string;
  timelineStartSeconds: number;
  visualDurationSeconds: number;
  selectedAssetId?: string;
  selectedRelativePath: string | null;
  isCustomEditorSelection?: boolean;
  fitMode?: ClipFitMode;
  kenBurns?: KenBurnsPreset;
  playbackRate?: number;
  muteSourceAudio?: boolean;
  segments?: AiMovieVideoSegment[];
}

export interface StudioUpdatesManifest {
  schemaVersion: '1.0';
  projectTitle: string;
  updatedAt: string;
  addedAssets: StudioUpdateAddedAssetEntry[];
  sceneTimelineUpdates: StudioUpdateSceneTimelineEntry[];
}

export interface ImportMediaSceneTarget {
  mode: 'assigned-scene' | 'new-scene' | 'shared-project';
  sceneId?: string;
  sceneOrder?: number;
  sceneTitle?: string;
}

export interface AiMovieSyncSummary {
  hasChanges: boolean;
  aiMovieBusy: boolean;
  busyReason?: string;
  newTakesCount: number;
  newDialogueCount: number;
  newScenesCount: number;
  durationChangesCount?: number;
  modifiedMediaCount?: number;
  newTextOverlaysCount?: number;
}

export interface LoadedProjectBundle {
  projectRoot: string;
  project: VideoProjectManifest;
  aiMovieStatus: {
    exists: boolean;
    hasUnsavedChanges: boolean;
    pendingOperationsCount: number;
  };
  syncSummary?: AiMovieSyncSummary;
}

// --- 4. Electron IPC Bridge API (`window.spliceTech`) ---

export interface SpliceWrightApi {
  getHardwareProfile: () => Promise<HardwareProfile>;
  getLaunchProjectFolder: () => Promise<string | null>;
  selectFolderDialog: (title?: string) => Promise<string | null>;
  openProjectFolder: (folderPath: string) => Promise<LoadedProjectBundle>;
  createStandaloneProject: (folderPath: string, title: string, aspectRatio: string) => Promise<LoadedProjectBundle>;
  convertStandaloneToStudioProject: (
    projectRoot: string,
    currentProject: VideoProjectManifest
  ) => Promise<LoadedProjectBundle>;
  saveProject: (projectRoot: string, project: VideoProjectManifest) => Promise<{ savedPath: string }>;
  importExternalMedia: (
    projectRoot: string,
    targetKind: MediaAssetKind,
    sceneTarget?: ImportMediaSceneTarget
  ) => Promise<ProjectMediaAsset[]>;
  syncFromAiMovie: (
    projectRoot: string,
    currentProject: VideoProjectManifest,
    mode: 'merge-new-assets' | 'reset-to-ai-movie'
  ) => Promise<LoadedProjectBundle>;
  refreshSingleClipMedia: (
    projectRoot: string,
    currentProject: VideoProjectManifest,
    clipId: string
  ) => Promise<{ project: VideoProjectManifest; refreshedLabel: string; newDurationSeconds: number }>;
  exportMovie: (
    projectRoot: string,
    project: VideoProjectManifest,
    options: ExportOptions
  ) => Promise<{ outputPath: string; srtPath?: string; fcpxmlPath?: string }>;
  normalizeDialogueAudioClips: (
    projectRoot: string,
    project: VideoProjectManifest,
    includeSfxAndMusic?: boolean
  ) => Promise<{ project: VideoProjectManifest; normalizedCount: number }>;
  renderPreviewAudioMix: (
    projectRoot: string,
    project: VideoProjectManifest
  ) => Promise<{ project: VideoProjectManifest; mixRelativePath: string }>;
  selectVideoFilesForStitching: () => Promise<StitchVideoItem[]>;
  selectOutputMp4Path: (defaultName?: string) => Promise<string | null>;
  stitchVideoChapters: (
    options: StitchChaptersOptions
  ) => Promise<{ outputPath: string; srtPath?: string; totalDurationSeconds: number }>;
  scanStitchCatalogueFolder: (folderPath?: string) => Promise<StitchCatalogue | null>;
  saveStitchCatalogue: (catalogue: StitchCatalogue) => Promise<{ savedPath: string }>;
  toggleDualMonitorWindow: () => Promise<{ isOpen: boolean }>;
  getDualMonitorInitialState: () => Promise<{
    projectRoot: string | null;
    project: VideoProjectManifest | null;
  }>;
  onDualMonitorStateChanged: (callback: (isOpen: boolean) => void) => () => void;
  openPathInExplorer: (targetPath: string) => Promise<void>;
  openExternalUrl: (url: string) => Promise<void>;
  generateSampleProject: () => Promise<LoadedProjectBundle>;
  onAiMovieUpdated: (callback: (summary: AiMovieSyncSummary) => void) => () => void;
  onExportProgress: (callback: (progress: ExportProgressEvent) => void) => () => void;
  onProjectManifestExternalUpdate: (
    callback: (project: VideoProjectManifest) => void
  ) => () => void;
}
