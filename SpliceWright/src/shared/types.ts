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

export interface AiMovieVideoTake {
  id: string;
  label?: string;
  fileName: string; // e.g. "scenes/scene-1/videos/video-1730002000.mp4" or "videos/video-1730005000.mp4"
  source?: string;
  providerModel?: string;
  prompt?: string;
  createdAt?: string;
  durationSeconds: number;
  aspectRatio?: string;
  resolution?: string;
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
}

export type TrackType = 'video' | 'dialogue' | 'sfx' | 'music';

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
  | 'zoom-in-bottom';

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
  /** Available video takes for this scene (allows 1-click take switching on timeline) */
  availableTakeAssetIds?: string[];
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

export interface AiMovieSyncSummary {
  hasChanges: boolean;
  aiMovieBusy: boolean;
  busyReason?: string;
  newTakesCount: number;
  newDialogueCount: number;
  newScenesCount: number;
  durationChangesCount?: number;
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
  saveProject: (projectRoot: string, project: VideoProjectManifest) => Promise<{ savedPath: string }>;
  importExternalMedia: (
    projectRoot: string,
    targetKind: MediaAssetKind
  ) => Promise<ProjectMediaAsset[]>;
  syncFromAiMovie: (
    projectRoot: string,
    currentProject: VideoProjectManifest,
    mode: 'merge-new-assets' | 'reset-to-ai-movie'
  ) => Promise<LoadedProjectBundle>;
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
