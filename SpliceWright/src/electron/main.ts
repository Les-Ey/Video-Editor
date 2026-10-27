import { app, BrowserWindow, dialog, ipcMain, protocol, screen, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import chokidar, { FSWatcher } from 'chokidar';
import {
  ExportOptions,
  MediaAssetKind,
  ProjectMediaAsset,
  StitchCatalogue,
  StitchChaptersOptions,
  StitchVideoItem,
  VideoProjectManifest,
} from '../shared/types';
import { detectHardwareProfile, probeMediaDuration } from './hardware';
import {
  computeAiMovieSyncSummary,
  createOrLoadStandaloneProject,
  getVideoProjectPath,
  loadProjectFromFolder,
  mergeNewAssetsFromAiMovie,
  normalizeRelPath,
  readAiMovieReadOnly,
  rebuildProjectFromAiMovie,
  saveStitchCatalogueToDisk,
  saveVideoProjectManifest,
  scanOrLoadStitchCatalogue,
} from './projectManager';
import {
  normalizeDialogueClipsInProject,
  renderPreviewAudioMixToMp3,
  renderProjectWithFfmpeg,
  stitchVideoChaptersWithFfmpeg,
} from './ffmpegEngine';
import { ensureSampleAiMovieProject } from './sampleProjectGenerator';

// Register custom `media://` scheme as privileged BEFORE app is ready
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

let mainWindow: BrowserWindow | null = null;
let externalMonitorWindow: BrowserWindow | null = null;
let aiMovieWatcher: FSWatcher | null = null;
let projectManifestWatcher: FSWatcher | null = null;
let lastInternalSaveTimestamp = 0;
let activeProjectRoot: string | null = null;
let latestLoadedProject: VideoProjectManifest | null = null;

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.mp4':
      return 'video/mp4';
    case '.webm':
      return 'video/webm';
    case '.mov':
      return 'video/quicktime';
    case '.mkv':
      return 'video/x-matroska';
    case '.mp3':
      return 'audio/mpeg';
    case '.wav':
      return 'audio/wav';
    case '.ogg':
      return 'audio/ogg';
    case '.m4a':
      return 'audio/mp4';
    case '.aac':
      return 'audio/aac';
    case '.flac':
      return 'audio/flac';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Registers the `media://local?path=<encodedFullPath>` handler with full HTTP 206 Partial Content
 * byte-range support for smooth, frame-accurate local video scrubbing on any drive (including external SSDs).
 */
function registerMediaProtocolHandler(): void {
  protocol.handle('media', async (request) => {
    try {
      const urlObj = new URL(request.url);
      const rawPath = urlObj.searchParams.get('path');
      if (!rawPath || !fs.existsSync(rawPath)) {
        return new Response('File not found', { status: 404 });
      }

      const stat = fs.statSync(rawPath);
      const fileSize = stat.size;
      const mimeType = getMimeType(rawPath);
      const rangeHeader = request.headers.get('range') || request.headers.get('Range');

      if (rangeHeader) {
        const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
        if (match) {
          const start = match[1] ? parseInt(match[1], 10) : 0;
          const end = match[2] ? Math.min(parseInt(match[2], 10), fileSize - 1) : fileSize - 1;
          if (start >= fileSize || start > end) {
            return new Response(null, {
              status: 416,
              headers: { 'Content-Range': `bytes */${fileSize}` },
            });
          }
          const chunkSize = end - start + 1;
          const stream = fs.createReadStream(rawPath, { start, end });
          return new Response(stream as unknown as BodyInit, {
            status: 206,
            headers: {
              'Content-Range': `bytes ${start}-${end}/${fileSize}`,
              'Accept-Ranges': 'bytes',
              'Content-Length': String(chunkSize),
              'Content-Type': mimeType,
            },
          });
        }
      }

      const stream = fs.createReadStream(rawPath);
      return new Response(stream as unknown as BodyInit, {
        status: 200,
        headers: {
          'Accept-Ranges': 'bytes',
          'Content-Length': String(fileSize),
          'Content-Type': mimeType,
        },
      });
    } catch (err) {
      return new Response(`Media load error: ${(err as Error).message}`, { status: 500 });
    }
  });
}

function setupAiMovieWatcher(projectRoot: string): void {
  if (aiMovieWatcher) {
    aiMovieWatcher.close();
    aiMovieWatcher = null;
  }

  const aiMovieFile = path.join(projectRoot, 'ai-movie.json');
  if (!fs.existsSync(aiMovieFile)) {
    return;
  }

  const watchTargets = [
    aiMovieFile,
    path.join(projectRoot, 'audio'),
    path.join(projectRoot, 'scenes'),
  ];

  aiMovieWatcher = chokidar.watch(watchTargets, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 350,
      pollInterval: 100,
    },
  });

  const handleFsUpdate = async () => {
    if (!mainWindow || !activeProjectRoot || !latestLoadedProject) return;
    try {
      const summary = await computeAiMovieSyncSummary(activeProjectRoot, latestLoadedProject);
      mainWindow.webContents.send('ai-movie:updated', summary);
    } catch {
      // Ignore transient parse errors while VS Code extension writes
    }
  };

  aiMovieWatcher.on('change', handleFsUpdate);
  aiMovieWatcher.on('add', handleFsUpdate);
}

/**
 * Topic 10: Watches `exports/video-project.json` for external edits made by an AI Agent
 * in VS Code (ignoring internal saves from SpliceWright itself) and hot-reloads the timeline.
 */
function setupProjectManifestWatcher(projectRoot: string): void {
  if (projectManifestWatcher) {
    projectManifestWatcher.close();
    projectManifestWatcher = null;
  }

  const manifestFile = getVideoProjectPath(projectRoot);
  const exportsDir = path.dirname(manifestFile);
  fs.mkdirSync(exportsDir, { recursive: true });

  projectManifestWatcher = chokidar.watch(manifestFile, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  });

  const handleManifestExternalChange = () => {
    if (!mainWindow || !activeProjectRoot) return;
    if (Date.now() - lastInternalSaveTimestamp < 1500) {
      return; // Ignore our own internal save
    }
    try {
      if (!fs.existsSync(manifestFile)) return;
      const raw = fs.readFileSync(manifestFile, 'utf-8');
      const parsed = JSON.parse(raw) as VideoProjectManifest;
      if (parsed && parsed.timeline && Array.isArray(parsed.timeline.tracks)) {
        latestLoadedProject = parsed;
        mainWindow.webContents.send('project-manifest:external-update', parsed);
      }
    } catch {
      // Ignore transient write states
    }
  };

  projectManifestWatcher.on('change', handleManifestExternalChange);
  projectManifestWatcher.on('add', handleManifestExternalChange);
}

function createWindow(): void {
  const iconCandidate = path.join(__dirname, '..', '..', 'assets', 'icon.png');
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#090d16',
    title: 'SpliceWright — Local AI Movie & Video Editor',
    icon: fs.existsSync(iconCandidate) ? iconCandidate : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';
  const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';

  if (isDev && process.env.USE_VITE_DEV === 'true') {
    mainWindow.loadURL(devUrl);
  } else {
    const indexHtml = path.join(__dirname, '..', '..', 'dist', 'index.html');
    if (fs.existsSync(indexHtml)) {
      mainWindow.loadFile(indexHtml);
    } else {
      mainWindow.loadURL(devUrl);
    }
  }
}

function resolveLaunchProjectFolderFromArgs(): string | null {
  const envDir = process.env.SPLICEWRIGHT_PROJECT_DIR;
  if (envDir && fs.existsSync(envDir)) {
    const stat = fs.statSync(envDir);
    return stat.isDirectory() ? envDir : path.dirname(envDir);
  }

  const args = process.argv.slice(app.isPackaged ? 1 : 2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--project' && args[i + 1]) {
      const candidate = path.resolve(args[i + 1]);
      if (fs.existsSync(candidate)) {
        const stat = fs.statSync(candidate);
        return stat.isDirectory() ? candidate : path.dirname(candidate);
      }
    } else if (arg.startsWith('--project=')) {
      const candidate = path.resolve(arg.slice('--project='.length));
      if (fs.existsSync(candidate)) {
        const stat = fs.statSync(candidate);
        return stat.isDirectory() ? candidate : path.dirname(candidate);
      }
    } else if (!arg.startsWith('-') && arg !== '.') {
      const candidate = path.resolve(arg);
      if (fs.existsSync(candidate)) {
        const stat = fs.statSync(candidate);
        const dir = stat.isDirectory() ? candidate : path.dirname(candidate);
        if (
          fs.existsSync(path.join(dir, 'ai-movie.json')) ||
          fs.existsSync(path.join(dir, 'exports', 'video-project.json'))
        ) {
          return dir;
        }
      }
    }
  }
  return null;
}

app.whenReady().then(() => {
  registerMediaProtocolHandler();
  createWindow();

  ipcMain.handle('hardware:get-profile', async () => {
    return detectHardwareProfile();
  });

  ipcMain.handle('app:get-launch-project', async () => {
    return resolveLaunchProjectFolderFromArgs();
  });

  ipcMain.handle('dialog:select-folder', async (_event, title?: string) => {
    if (!mainWindow) return null;
    const res = await dialog.showOpenDialog(mainWindow, {
      title: title || 'Select Project Folder (AI Movie or Standalone)',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('project:open-folder', async (_event, folderPath: string) => {
    lastInternalSaveTimestamp = Date.now();
    const bundle = await loadProjectFromFolder(folderPath);
    activeProjectRoot = folderPath;
    latestLoadedProject = bundle.project;
    setupAiMovieWatcher(folderPath);
    setupProjectManifestWatcher(folderPath);
    return bundle;
  });

  ipcMain.handle(
    'project:create-standalone',
    async (_event, folderPath: string, title: string, aspectRatio: string) => {
      lastInternalSaveTimestamp = Date.now();
      const project = await createOrLoadStandaloneProject(folderPath, title, aspectRatio);
      activeProjectRoot = folderPath;
      latestLoadedProject = project;
      if (aiMovieWatcher) {
        aiMovieWatcher.close();
        aiMovieWatcher = null;
      }
      setupProjectManifestWatcher(folderPath);
      return {
        projectRoot: folderPath,
        project,
        aiMovieStatus: {
          exists: false,
          hasUnsavedChanges: false,
          pendingOperationsCount: 0,
        },
      };
    }
  );

  ipcMain.handle(
    'project:save',
    async (_event, projectRoot: string, project: VideoProjectManifest) => {
      latestLoadedProject = project;
      lastInternalSaveTimestamp = Date.now();
      const savedPath = saveVideoProjectManifest(projectRoot, project);
      return { savedPath };
    }
  );

  ipcMain.handle(
    'project:import-media',
    async (_event, projectRoot: string, targetKind: MediaAssetKind) => {
      if (!mainWindow) return [];

      const filters =
        targetKind === 'video' || targetKind === 'image'
          ? [
              {
                name: 'Video & Images',
                extensions: ['mp4', 'webm', 'mov', 'mkv', 'png', 'jpg', 'jpeg', 'webp'],
              },
            ]
          : [
              {
                name: 'Audio Files (BGM, SFX, Voiceover)',
                extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'],
              },
            ];

      const preferredDefaultDir =
        targetKind === 'dialogue'
          ? fs.existsSync(path.join(projectRoot, 'audio'))
            ? path.join(projectRoot, 'audio')
            : projectRoot
          : targetKind === 'video' || targetKind === 'image'
          ? fs.existsSync(path.join(projectRoot, 'assets', 'images'))
            ? path.join(projectRoot, 'assets', 'images')
            : projectRoot
          : fs.existsSync(path.join(projectRoot, 'assets', 'audio'))
          ? path.join(projectRoot, 'assets', 'audio')
          : projectRoot;

      const res = await dialog.showOpenDialog(mainWindow, {
        title: `Import ${targetKind.toUpperCase()} Files (From Project Folder or External Drive)`,
        defaultPath: preferredDefaultDir,
        properties: ['openFile', 'multiSelections'],
        filters,
      });

      if (res.canceled || res.filePaths.length === 0) return [];

      const subFolder =
        targetKind === 'video' || targetKind === 'image'
          ? path.join('assets', 'video')
          : path.join('assets', 'audio');

      const destDir = path.join(projectRoot, subFolder);
      fs.mkdirSync(destDir, { recursive: true });

      const importedAssets: ProjectMediaAsset[] = [];
      const normalizedRoot = path.resolve(projectRoot).toLowerCase();

      for (const srcFile of res.filePaths) {
        const ext = path.extname(srcFile);
        const baseName = path.basename(srcFile, ext);
        const resolvedSrc = path.resolve(srcFile);

        let destFull = resolvedSrc;
        let relPath = '';

        // If the selected file is already inside the project folder (e.g., `audio/scene-1/...` or `assets/images/...`),
        // reference it in-place without duplicating it into `assets/audio/`!
        if (resolvedSrc.toLowerCase().startsWith(normalizedRoot + path.sep)) {
          relPath = normalizeRelPath(path.relative(projectRoot, resolvedSrc));
        } else {
          let safeFileName = `${baseName}${ext}`;
          destFull = path.join(destDir, safeFileName);

          // Collision-safe filename if a different file with the same name already exists
          if (fs.existsSync(destFull) && resolvedSrc !== path.resolve(destFull)) {
            safeFileName = `${baseName}_${Date.now().toString().slice(-5)}${ext}`;
            destFull = path.join(destDir, safeFileName);
          }

          if (resolvedSrc !== path.resolve(destFull)) {
            fs.copyFileSync(srcFile, destFull);
          }
          relPath = normalizeRelPath(path.join(subFolder, safeFileName));
        }

        const isImg = ['.png', '.jpg', '.jpeg', '.webp'].includes(ext.toLowerCase());
        const duration = isImg ? 6.0 : await probeMediaDuration(destFull);
        const actualKind: MediaAssetKind = isImg
          ? 'image'
          : ['.mp4', '.webm', '.mov', '.mkv'].includes(ext.toLowerCase())
          ? 'video'
          : targetKind;

        importedAssets.push({
          id: `asset_imp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          kind: actualKind,
          label: `[${actualKind.toUpperCase()}] ${path.basename(destFull)}`,
          relativePath: relPath,
          durationSeconds: Math.round(duration * 100) / 100,
          source: 'user-imported',
        });
      }

      return importedAssets;
    }
  );

  ipcMain.handle(
    'project:sync-ai-movie',
    async (
      _event,
      projectRoot: string,
      currentProject: VideoProjectManifest,
      mode: 'merge-new-assets' | 'reset-to-ai-movie'
    ) => {
      const aiMovie = readAiMovieReadOnly(projectRoot);
      if (!aiMovie) {
        return loadProjectFromFolder(projectRoot);
      }

      let updatedProject: VideoProjectManifest;
      if (mode === 'reset-to-ai-movie') {
        updatedProject = await rebuildProjectFromAiMovie(projectRoot, currentProject);
      } else {
        updatedProject = await mergeNewAssetsFromAiMovie(projectRoot, currentProject);
      }

      latestLoadedProject = updatedProject;
      const syncSummary = await computeAiMovieSyncSummary(projectRoot, updatedProject);

      return {
        projectRoot,
        project: updatedProject,
        aiMovieStatus: {
          exists: true,
          hasUnsavedChanges: Boolean(aiMovie.editorState?.hasUnsavedChanges),
          pendingOperationsCount: aiMovie.editorState?.pendingOperations?.length || 0,
        },
        syncSummary,
      };
    }
  );

  ipcMain.handle(
    'project:export-movie',
    async (
      _event,
      projectRoot: string,
      project: VideoProjectManifest,
      options: ExportOptions
    ) => {
      lastInternalSaveTimestamp = Date.now();
      saveVideoProjectManifest(projectRoot, project);
      return renderProjectWithFfmpeg(projectRoot, project, options, (progress) => {
        mainWindow?.webContents.send('export:progress', progress);
      });
    }
  );

  ipcMain.handle(
    'project:normalize-dialogue',
    async (
      _event,
      projectRoot: string,
      project: VideoProjectManifest,
      includeSfxAndMusic?: boolean
    ) => {
      const res = await normalizeDialogueClipsInProject(projectRoot, project, includeSfxAndMusic);
      latestLoadedProject = res.project;
      lastInternalSaveTimestamp = Date.now();
      saveVideoProjectManifest(projectRoot, res.project);
      return res;
    }
  );

  ipcMain.handle(
    'project:render-preview-audio-mix',
    async (_event, projectRoot: string, project: VideoProjectManifest) => {
      const res = await renderPreviewAudioMixToMp3(projectRoot, project);
      latestLoadedProject = res.project;
      lastInternalSaveTimestamp = Date.now();
      saveVideoProjectManifest(projectRoot, res.project);
      return res;
    }
  );

  ipcMain.handle('stitch:select-videos', async () => {
    if (!mainWindow) return [];
    const defaultDir =
      activeProjectRoot && fs.existsSync(path.join(activeProjectRoot, 'exports'))
        ? path.join(activeProjectRoot, 'exports')
        : activeProjectRoot || undefined;

    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Chapter / Reel MP4 Videos to Stitch Together',
      defaultPath: defaultDir,
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Video Files', extensions: ['mp4', 'mov', 'mkv', 'webm'] }],
    });
    if (res.canceled || res.filePaths.length === 0) return [];

    const items: StitchVideoItem[] = [];
    for (const fp of res.filePaths) {
      const dur = Math.round((await probeMediaDuration(fp)) * 100) / 100;
      const companionSrt = fp.replace(/\.[^.]+$/, '.srt');
      items.push({
        filePath: fp,
        label: path.basename(fp),
        durationSeconds: dur,
        hasCompanionSrt: fs.existsSync(companionSrt),
      });
    }
    return items;
  });

  ipcMain.handle('stitch:select-output', async (_event, defaultName?: string) => {
    if (!mainWindow) return null;
    const baseDir =
      activeProjectRoot && fs.existsSync(path.join(activeProjectRoot, 'exports'))
        ? path.join(activeProjectRoot, 'exports')
        : activeProjectRoot || app.getPath('videos');

    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Stitched Full-Length Movie MP4',
      defaultPath: path.join(baseDir, defaultName || 'full-stitched-movie.mp4'),
      filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
    });
    if (res.canceled || !res.filePath) return null;
    return res.filePath;
  });

  ipcMain.handle('stitch:run', async (_event, options: StitchChaptersOptions) => {
    return stitchVideoChaptersWithFfmpeg(options, (progress) => {
      mainWindow?.webContents.send('export:progress', progress);
    });
  });

  ipcMain.handle('stitch:scan-catalogue', async (_event, folderPath?: string) => {
    let targetDir = folderPath;
    if (!targetDir) {
      if (!mainWindow) return null;
      const defaultParent = activeProjectRoot ? path.dirname(activeProjectRoot) : undefined;
      const res = await dialog.showOpenDialog(mainWindow, {
        title: 'Select Multi-Chapter Production Root Folder (for movie-catalogue.json)',
        defaultPath: defaultParent,
        properties: ['openDirectory', 'createDirectory'],
      });
      if (res.canceled || res.filePaths.length === 0) return null;
      targetDir = res.filePaths[0];
    }
    return scanOrLoadStitchCatalogue(targetDir);
  });

  ipcMain.handle('stitch:save-catalogue', async (_event, catalogue: StitchCatalogue) => {
    const savedPath = saveStitchCatalogueToDisk(catalogue);
    return { savedPath };
  });

  ipcMain.handle('dual-monitor:get-state', async () => {
    return {
      projectRoot: activeProjectRoot,
      project: latestLoadedProject,
    };
  });

  // Topic 14: Dual Monitor Support (Dedicated Second-Screen Program Monitor Window)
  ipcMain.handle('dual-monitor:toggle', async () => {
    if (externalMonitorWindow && !externalMonitorWindow.isDestroyed()) {
      externalMonitorWindow.close();
      externalMonitorWindow = null;
      mainWindow?.webContents.send('dual-monitor:changed', false);
      return { isOpen: false };
    }

    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    const secondDisplay = displays.find((d) => d.id !== primary.id);

    const iconCandidate = path.join(__dirname, '..', '..', 'assets', 'icon.png');
    externalMonitorWindow = new BrowserWindow({
      x: secondDisplay ? secondDisplay.bounds.x + 40 : undefined,
      y: secondDisplay ? secondDisplay.bounds.y + 40 : undefined,
      width: secondDisplay ? Math.min(1440, secondDisplay.workAreaSize.width) : 960,
      height: secondDisplay ? Math.min(860, secondDisplay.workAreaSize.height) : 580,
      backgroundColor: '#060911',
      title: 'SpliceWright — External Program Monitor (2nd Screen)',
      icon: fs.existsSync(iconCandidate) ? iconCandidate : undefined,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    if (secondDisplay) {
      externalMonitorWindow.maximize();
    }

    const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';
    const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';

    if (isDev && process.env.USE_VITE_DEV === 'true') {
      externalMonitorWindow.loadURL(`${devUrl}?mode=external-monitor`);
    } else {
      const indexHtml = path.join(__dirname, '..', '..', 'dist', 'index.html');
      if (fs.existsSync(indexHtml)) {
        externalMonitorWindow.loadFile(indexHtml, { query: { mode: 'external-monitor' } });
      } else {
        externalMonitorWindow.loadURL(`${devUrl}?mode=external-monitor`);
      }
    }

    externalMonitorWindow.on('closed', () => {
      externalMonitorWindow = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('dual-monitor:changed', false);
      }
    });

    mainWindow?.webContents.send('dual-monitor:changed', true);
    return { isOpen: true };
  });

  ipcMain.handle('shell:open-path', async (_event, targetPath: string) => {
    if (fs.existsSync(targetPath)) {
      const stat = fs.statSync(targetPath);
      if (stat.isFile()) {
        shell.showItemInFolder(targetPath);
      } else {
        await shell.openPath(targetPath);
      }
    }
  });

  ipcMain.handle('shell:open-external', async (_event, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
    }
  });

  ipcMain.handle('project:generate-sample', async () => {
    const baseDir = path.resolve(app.getAppPath(), '..');
    const sampleRoot = await ensureSampleAiMovieProject(baseDir);
    lastInternalSaveTimestamp = Date.now();
    const bundle = await loadProjectFromFolder(sampleRoot);
    activeProjectRoot = sampleRoot;
    latestLoadedProject = bundle.project;
    setupAiMovieWatcher(sampleRoot);
    setupProjectManifestWatcher(sampleRoot);
    return bundle;
  });
});

app.on('window-all-closed', () => {
  if (aiMovieWatcher) {
    aiMovieWatcher.close();
  }
  if (projectManifestWatcher) {
    projectManifestWatcher.close();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
