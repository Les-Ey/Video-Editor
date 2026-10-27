import { contextBridge, ipcRenderer } from 'electron';
import {
  AiMovieSyncSummary,
  ExportOptions,
  ExportProgressEvent,
  MediaAssetKind,
  SpliceWrightApi,
  StitchCatalogue,
  StitchChaptersOptions,
  VideoProjectManifest,
} from '../shared/types';

const api: SpliceWrightApi = {
  getHardwareProfile: () => ipcRenderer.invoke('hardware:get-profile'),
  getLaunchProjectFolder: () => ipcRenderer.invoke('app:get-launch-project'),
  selectFolderDialog: (title?: string) => ipcRenderer.invoke('dialog:select-folder', title),
  openProjectFolder: (folderPath: string) => ipcRenderer.invoke('project:open-folder', folderPath),
  createStandaloneProject: (folderPath: string, title: string, aspectRatio: string) =>
    ipcRenderer.invoke('project:create-standalone', folderPath, title, aspectRatio),
  saveProject: (projectRoot: string, project: VideoProjectManifest) =>
    ipcRenderer.invoke('project:save', projectRoot, project),
  importExternalMedia: (projectRoot: string, targetKind: MediaAssetKind) =>
    ipcRenderer.invoke('project:import-media', projectRoot, targetKind),
  syncFromAiMovie: (
    projectRoot: string,
    currentProject: VideoProjectManifest,
    mode: 'merge-new-assets' | 'reset-to-ai-movie'
  ) => ipcRenderer.invoke('project:sync-ai-movie', projectRoot, currentProject, mode),
  exportMovie: (projectRoot: string, project: VideoProjectManifest, options: ExportOptions) =>
    ipcRenderer.invoke('project:export-movie', projectRoot, project, options),
  normalizeDialogueAudioClips: (
    projectRoot: string,
    project: VideoProjectManifest,
    includeSfxAndMusic?: boolean
  ) => ipcRenderer.invoke('project:normalize-dialogue', projectRoot, project, includeSfxAndMusic),
  renderPreviewAudioMix: (projectRoot: string, project: VideoProjectManifest) =>
    ipcRenderer.invoke('project:render-preview-audio-mix', projectRoot, project),
  selectVideoFilesForStitching: () => ipcRenderer.invoke('stitch:select-videos'),
  selectOutputMp4Path: (defaultName?: string) =>
    ipcRenderer.invoke('stitch:select-output', defaultName),
  stitchVideoChapters: (options: StitchChaptersOptions) =>
    ipcRenderer.invoke('stitch:run', options),
  scanStitchCatalogueFolder: (folderPath?: string) =>
    ipcRenderer.invoke('stitch:scan-catalogue', folderPath),
  saveStitchCatalogue: (catalogue: StitchCatalogue) =>
    ipcRenderer.invoke('stitch:save-catalogue', catalogue),
  toggleDualMonitorWindow: () => ipcRenderer.invoke('dual-monitor:toggle'),
  getDualMonitorInitialState: () => ipcRenderer.invoke('dual-monitor:get-state'),
  onDualMonitorStateChanged: (callback: (isOpen: boolean) => void) => {
    const handler = (_event: unknown, isOpen: boolean) => callback(isOpen);
    ipcRenderer.on('dual-monitor:changed', handler);
    return () => ipcRenderer.removeListener('dual-monitor:changed', handler);
  },
  openPathInExplorer: (targetPath: string) => ipcRenderer.invoke('shell:open-path', targetPath),
  openExternalUrl: (url: string) => ipcRenderer.invoke('shell:open-external', url),
  generateSampleProject: () => ipcRenderer.invoke('project:generate-sample'),
  onAiMovieUpdated: (callback: (summary: AiMovieSyncSummary) => void) => {
    const handler = (_event: unknown, summary: AiMovieSyncSummary) => callback(summary);
    ipcRenderer.on('ai-movie:updated', handler);
    return () => ipcRenderer.removeListener('ai-movie:updated', handler);
  },
  onExportProgress: (callback: (progress: ExportProgressEvent) => void) => {
    const handler = (_event: unknown, progress: ExportProgressEvent) => callback(progress);
    ipcRenderer.on('export:progress', handler);
    return () => ipcRenderer.removeListener('export:progress', handler);
  },
  onProjectManifestExternalUpdate: (callback: (project: VideoProjectManifest) => void) => {
    const handler = (_event: unknown, project: VideoProjectManifest) => callback(project);
    ipcRenderer.on('project-manifest:external-update', handler);
    return () => ipcRenderer.removeListener('project-manifest:external-update', handler);
  },
};

contextBridge.exposeInMainWorld('spliceWright', api);
