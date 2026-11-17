import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AiMovieSyncSummary,
  ExportOptions,
  ExportPreset,
  ExportProgressEvent,
  getClipTimelineDuration,
  HardwareProfile,
  ImportMediaSceneTarget,
  LoadedProjectBundle,
  MediaAssetKind,
  StitchCatalogue,
  StitchVideoItem,
  VideoProjectFormat,
  VideoProjectManifest,
  VISUAL_LOOK_PRESET_LABELS,
  VisualLookPreset,
} from '../shared/types';
import { PreviewPlayer } from './components/PreviewPlayer';
import { TimelineEditor, deleteClipFromManifest } from './components/TimelineEditor';
import { MediaBinAndInspector } from './components/MediaBinAndInspector';
import {
  FolderOpen,
  FolderPlus,
  Save,
  Download,
  RefreshCw,
  Cpu,
  HardDrive,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
  ExternalLink,
  Clapperboard,
  Film,
  ArrowUp,
  ArrowDown,
  Trash2,
  Monitor,
  Coffee,
  ChevronDown,
  Wand2,
} from 'lucide-react';

const BUY_ME_A_COFFEE_URL = 'https://www.buymeacoffee.com/les.ey';

export const App: React.FC = () => {
  const isExternalMonitorMode = useMemo(
    () => new URLSearchParams(window.location.search).get('mode') === 'external-monitor',
    []
  );
  const [isDualMonitorOpen, setIsDualMonitorOpen] = useState<boolean>(false);
  const dualMonitorChannelRef = useRef<BroadcastChannel | null>(null);
  const [hardware, setHardware] = useState<HardwareProfile | null>(null);
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  const [project, setProject] = useState<VideoProjectManifest | null>(null);
  const [aiMovieExists, setAiMovieExists] = useState<boolean>(false);
  const [syncSummary, setSyncSummary] = useState<AiMovieSyncSummary | null>(null);

  const [playhead, setPlayhead] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [lastImportedAssetId, setLastImportedAssetId] = useState<string | null>(null);
  const [statusToast, setStatusToast] = useState<string | null>(null);
  const [isNormalizing, setIsNormalizing] = useState<boolean>(false);
  const [isPreMixingAudio, setIsPreMixingAudio] = useState<boolean>(false);
  const [isBusy, setIsBusy] = useState<boolean>(false);
  const [isStudioAutoLaunching, setIsStudioAutoLaunching] = useState<boolean>(true);
  const [studioLaunchPath, setStudioLaunchPath] = useState<string | null>(null);

  const liveStateRef = useRef<{
    projectRoot: string | null;
    project: VideoProjectManifest | null;
    playhead: number;
    isPlaying: boolean;
  }>({
    projectRoot: null,
    project: null,
    playhead: 0,
    isPlaying: false,
  });
  liveStateRef.current = { projectRoot, project, playhead, isPlaying };

  // Modals
  const [showNewStandaloneModal, setShowNewStandaloneModal] = useState<boolean>(false);
  const [standaloneFolder, setStandaloneFolder] = useState<string>('');
  const [standaloneTitle, setStandaloneTitle] = useState<string>('My Standalone Video');
  const [standaloneAspect, setStandaloneAspect] = useState<string>('16:9');

  const [showExportModal, setShowExportModal] = useState<boolean>(false);
  const [showSyncModal, setShowSyncModal] = useState<boolean>(false);
  const [showToolsMenu, setShowToolsMenu] = useState<boolean>(false);
  const toolsMenuRef = useRef<HTMLDivElement | null>(null);

  // Scene Assignment Modal when importing media into a Studio project (Section 7 of what-studio-needs-to-know.md)
  const [pendingImportKind, setPendingImportKind] = useState<MediaAssetKind | null>(null);
  const [importSceneSelection, setImportSceneSelection] = useState<string>('shared-project');
  const [importNewSceneTitle, setImportNewSceneTitle] = useState<string>('New Scene');
  const [importAutoPlaceOnTimeline, setImportAutoPlaceOnTimeline] = useState<boolean>(true);
  const [exportFileName, setExportFileName] = useState<string>('final-cut.mp4');
  const [exportPreset, setExportPreset] = useState<ExportPreset>('balanced');
  const [exportEncoder, setExportEncoder] = useState<string>('libx264');
  const [exportSrt, setExportSrt] = useState<boolean>(true);
  const [exportFcpxml, setExportFcpxml] = useState<boolean>(false);
  const [exportProgress, setExportProgress] = useState<ExportProgressEvent | null>(null);

  // Topic 11 & 13: Master Chapter / Reel Stitcher & Catalogue Modal state
  const [showStitchModal, setShowStitchModal] = useState<boolean>(false);
  const [stitchCatalogueRoot, setStitchCatalogueRoot] = useState<string>('');
  const [stitchItems, setStitchItems] = useState<StitchVideoItem[]>([]);
  const [stitchOutputPath, setStitchOutputPath] = useState<string>('');
  const [stitchSpacerSeconds, setStitchSpacerSeconds] = useState<number>(0);
  const [stitchMergeSubtitles, setStitchMergeSubtitles] = useState<boolean>(true);
  const [isStitching, setIsStitching] = useState<boolean>(false);

  const rafRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number | null>(null);

  // Undo / Redo History Stacks (capped at 50 snapshots)
  const undoStackRef = useRef<VideoProjectManifest[]>([]);
  const redoStackRef = useRef<VideoProjectManifest[]>([]);
  const [historyCounts, setHistoryCounts] = useState<{ past: number; future: number }>({
    past: 0,
    future: 0,
  });

  const syncHistoryCounts = () => {
    setHistoryCounts({
      past: undoStackRef.current.length,
      future: redoStackRef.current.length,
    });
  };

  const commitUndoSnapshot = (snapshot: VideoProjectManifest) => {
    undoStackRef.current.push(JSON.parse(JSON.stringify(snapshot)));
    if (undoStackRef.current.length > 50) {
      undoStackRef.current.shift();
    }
    redoStackRef.current = [];
    syncHistoryCounts();
  };

  const updateProjectWithHistory = (
    updater: (prev: VideoProjectManifest) => VideoProjectManifest,
    options?: { recordUndo?: boolean }
  ) => {
    setProject((prev) => {
      if (!prev) return prev;
      const next = updater(prev);
      if (next !== prev && options?.recordUndo !== false) {
        undoStackRef.current.push(JSON.parse(JSON.stringify(prev)));
        if (undoStackRef.current.length > 50) {
          undoStackRef.current.shift();
        }
        redoStackRef.current = [];
        syncHistoryCounts();
      }
      return next;
    });
  };

  const handleUndo = () => {
    setProject((curr) => {
      if (!curr || undoStackRef.current.length === 0) return curr;
      const previous = undoStackRef.current.pop()!;
      redoStackRef.current.push(JSON.parse(JSON.stringify(curr)));
      syncHistoryCounts();
      return previous;
    });
  };

  const handleRedo = () => {
    setProject((curr) => {
      if (!curr || redoStackRef.current.length === 0) return curr;
      const next = redoStackRef.current.pop()!;
      undoStackRef.current.push(JSON.parse(JSON.stringify(curr)));
      syncHistoryCounts();
      return next;
    });
  };

  useEffect(() => {
    window.spliceWright.getHardwareProfile().then((prof) => {
      setHardware(prof);
      setExportEncoder(prof.preferredEncoder);
      if (prof.tier === 'low-spec') {
        setExportPreset('fast-draft');
      }
    });

    window.spliceWright
      .getLaunchProjectFolder()
      .then(async (launchFolder) => {
        if (launchFolder) {
          setStudioLaunchPath(launchFolder);
          setIsStudioAutoLaunching(true);
          try {
            const bundle = await window.spliceWright.openProjectFolder(launchFolder);
            applyLoadedBundle(bundle);
            showToast(`Opened project from SpliceWright Studio: ${bundle.project.title}`);
          } finally {
            setIsStudioAutoLaunching(false);
          }
        } else {
          setIsStudioAutoLaunching(false);
        }
      })
      .catch(() => {
        setIsStudioAutoLaunching(false);
      });

    const unsubAi = window.spliceWright.onAiMovieUpdated((summary) => {
      setSyncSummary(summary);
      if (summary.hasChanges) {
        showToast(
          'Changes detected in SpliceWright Studio (ai-movie.json)! Click "Sync / Rebuild" to review and apply.'
        );
      }
    });

    const unsubExport = window.spliceWright.onExportProgress((prog) => {
      setExportProgress(prog);
    });

    // Topic 10: Live hot-reload when an external Agent edits `exports/video-project.json`
    const unsubExternalManifest = window.spliceWright.onProjectManifestExternalUpdate(
      (externalProject) => {
        setProject((curr) => {
          if (curr) {
            undoStackRef.current.push(JSON.parse(JSON.stringify(curr)));
            if (undoStackRef.current.length > 50) {
              undoStackRef.current.shift();
            }
            redoStackRef.current = [];
            syncHistoryCounts();
          }
          return externalProject;
        });
        showToast(
          'Timeline hot-reloaded from external Agent edit in video-project.json (Ctrl+Z to undo)!'
        );
      }
    );

    const unsubDualMonitor = window.spliceWright.onDualMonitorStateChanged((isOpen) => {
      setIsDualMonitorOpen(isOpen);
    });

    const onDocMouseDown = (ev: MouseEvent) => {
      if (toolsMenuRef.current && !toolsMenuRef.current.contains(ev.target as Node)) {
        setShowToolsMenu(false);
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);

    // Topic 14: BroadcastChannel for real-time Dual Monitor Program Preview sync
    const bc = new BroadcastChannel('splicewright-dual-monitor');
    dualMonitorChannelRef.current = bc;
    bc.onmessage = (ev) => {
      const data = ev.data;
      if (!data) return;
      if (isExternalMonitorMode && data.type === 'state') {
        if (data.projectRoot !== undefined) setProjectRoot(data.projectRoot);
        if (data.project !== undefined) setProject(data.project);
        if (typeof data.playhead === 'number') setPlayhead(data.playhead);
        if (typeof data.isPlaying === 'boolean') setIsPlaying(data.isPlaying);
      } else if (!isExternalMonitorMode && data.type === 'command') {
        if (data.action === 'toggle-play') {
          setIsPlaying((p) => !p);
        } else if (data.action === 'seek' && typeof data.time === 'number') {
          setPlayhead(data.time);
        } else if (data.action === 'request-state') {
          const st = liveStateRef.current;
          bc.postMessage({
            type: 'state',
            projectRoot: st.projectRoot,
            project: st.project,
            playhead: st.playhead,
            isPlaying: st.isPlaying,
          });
        }
      }
    };

    if (isExternalMonitorMode) {
      // Immediately fetch active project from Electron main process AND BroadcastChannel so 2nd screen never waits for playhead movement
      window.spliceWright.getDualMonitorInitialState().then((init) => {
        if (init.projectRoot) setProjectRoot(init.projectRoot);
        if (init.project) setProject(init.project);
      });
      bc.postMessage({ type: 'command', action: 'request-state' });
    }

    return () => {
      unsubAi();
      unsubExport();
      unsubExternalManifest();
      unsubDualMonitor();
      document.removeEventListener('mousedown', onDocMouseDown);
      bc.close();
    };
  }, [isExternalMonitorMode]);

  // Broadcast live playhead & project state from Primary Window to 2nd-Screen Monitor
  useEffect(() => {
    if (isExternalMonitorMode || !dualMonitorChannelRef.current) return;
    dualMonitorChannelRef.current.postMessage({
      type: 'state',
      projectRoot,
      project,
      playhead,
      isPlaying,
    });
  }, [isExternalMonitorMode, projectRoot, project, playhead, isPlaying]);

  const showToast = (msg: string) => {
    setStatusToast(msg);
    setTimeout(() => {
      setStatusToast((prev) => (prev === msg ? null : prev));
    }, 4500);
  };

  // Master monotonic requestAnimationFrame playback loop
  useEffect(() => {
    if (!isPlaying || !project) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      lastFrameTimeRef.current = null;
      return;
    }

    let maxDuration = 5;
    for (const tr of project.timeline.tracks) {
      for (const c of tr.clips) {
        const end =
          c.timelineStart + Math.max(0.1, (c.sourceOut - c.sourceIn) / (c.playbackRate || 1.0));
        if (end > maxDuration) maxDuration = end;
      }
    }

    const tick = (now: number) => {
      if (lastFrameTimeRef.current === null) {
        lastFrameTimeRef.current = now;
      }
      const deltaSec = (now - lastFrameTimeRef.current) / 1000;
      lastFrameTimeRef.current = now;

      setPlayhead((prev) => {
        const next = prev + deltaSec;
        if (next >= maxDuration) {
          setIsPlaying(false);
          return 0;
        }
        return next;
      });

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [isPlaying, project]);

  // Keyboard shortcuts (Space = Play/Pause, Ctrl+Z = Undo, Ctrl+Y / Ctrl+Shift+Z = Redo, Delete/Backspace = Delete Clip)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement as HTMLElement | null;
      if (
        activeEl &&
        (['INPUT', 'SELECT', 'TEXTAREA'].includes(activeEl.tagName) || activeEl.isContentEditable)
      ) {
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
        return;
      }

      if (
        ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') ||
        ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'z')
      ) {
        e.preventDefault();
        handleRedo();
        return;
      }

      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedClipId) {
        e.preventDefault();
        updateProjectWithHistory((prev) => deleteClipFromManifest(prev, selectedClipId, true));
        setSelectedClipId(null);
        return;
      }

      if (e.code === 'Space') {
        e.preventDefault();
        setIsPlaying((p) => !p);
        return;
      }

      // Topic 7: Pro Editor J / K / L shuttle & Arrow / Home frame-step shortcuts
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key.toLowerCase() === 'k') {
          e.preventDefault();
          setIsPlaying(false);
          return;
        }
        if (e.key.toLowerCase() === 'l') {
          e.preventDefault();
          setIsPlaying(true);
          return;
        }
        if (e.key.toLowerCase() === 'j') {
          e.preventDefault();
          setIsPlaying(false);
          setPlayhead((p) => Math.max(0, Math.round((p - 1.0) * 20) / 20));
          return;
        }
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          setIsPlaying(false);
          const step = e.shiftKey ? 1.0 : 0.05;
          setPlayhead((p) => Math.max(0, Math.round((p - step) * 100) / 100));
          return;
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          setIsPlaying(false);
          const step = e.shiftKey ? 1.0 : 0.05;
          setPlayhead((p) => Math.round((p + step) * 100) / 100);
          return;
        }
        if (e.key === 'Home') {
          e.preventDefault();
          setPlayhead(0);
          return;
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedClipId]);

  const applyLoadedBundle = (bundle: LoadedProjectBundle) => {
    undoStackRef.current = [];
    redoStackRef.current = [];
    syncHistoryCounts();
    setProjectRoot(bundle.projectRoot);
    setProject(bundle.project);
    setAiMovieExists(bundle.aiMovieStatus.exists);
    setSyncSummary(bundle.syncSummary || null);
    setPlayhead(0);
    setIsPlaying(false);
    setSelectedClipId(null);
    setExportFileName(
      `${bundle.project.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'movie'}-cut.mp4`
    );
  };

  // Workflow A: Open SpliceWright Studio Project (or existing project folder)
  const handleOpenProjectFolder = async () => {
    setIsBusy(true);
    try {
      const folder = await window.spliceWright.selectFolderDialog(
        'Select SpliceWright Studio Folder (with ai-movie.json) or Existing Project Folder'
      );
      if (!folder) return;
      showToast('Loading project folder...');
      const bundle = await window.spliceWright.openProjectFolder(folder);
      applyLoadedBundle(bundle);
      showToast(
        bundle.aiMovieStatus.exists
          ? `Opened SpliceWright Studio project (monitoring ai-movie.json as Read-Only)`
          : `Opened Standalone project folder`
      );
    } finally {
      setIsBusy(false);
    }
  };

  // Load / Generate Sample SpliceWright Studio Project out-of-the-box
  const handleLoadSampleProject = async () => {
    setIsBusy(true);
    try {
      showToast('Generating playable Sample SpliceWright Studio project with FFmpeg...');
      const bundle = await window.spliceWright.generateSampleProject();
      applyLoadedBundle(bundle);
      showToast('Sample Studio Project ("Neon Gate") loaded!');
    } finally {
      setIsBusy(false);
    }
  };

  // Workflow B: Create or Open Standalone Folder Project
  const handleCreateStandalone = async () => {
    if (!standaloneFolder) return;
    setIsBusy(true);
    try {
      const bundle = await window.spliceWright.createStandaloneProject(
        standaloneFolder,
        standaloneTitle,
        standaloneAspect
      );
      applyLoadedBundle(bundle);
      setShowNewStandaloneModal(false);
      showToast(`Standalone project initialized in ${standaloneFolder}`);
    } finally {
      setIsBusy(false);
    }
  };

  // Convert Standalone Project -> SpliceWright Studio Project (creates `ai-movie.json` only when it doesn't exist yet)
  const handleConvertStandaloneToStudio = async () => {
    if (!projectRoot || !project || aiMovieExists) return;
    setShowToolsMenu(false);
    setIsBusy(true);
    try {
      showToast('Converting Standalone project to SpliceWright Studio (creating ai-movie.json & scene thumbnails)...');
      const bundle = await window.spliceWright.convertStandaloneToStudioProject(projectRoot, project);
      applyLoadedBundle(bundle);
      showToast(
        `Converted to SpliceWright Studio project! Created ai-movie.json with ${bundle.project.sequence.length} scene(s).`
      );
    } catch (err) {
      showToast(`Convert error: ${(err as Error).message}`);
    } finally {
      setIsBusy(false);
    }
  };

  const handleSaveProject = async () => {
    if (!projectRoot || !project) return;
    setIsBusy(true);
    try {
      const res = await window.spliceWright.saveProject(projectRoot, project);
      showToast(`Saved timeline to ${res.savedPath}`);
    } finally {
      setIsBusy(false);
    }
  };

  const executeMediaImportWithTarget = async (
    kind: MediaAssetKind,
    sceneTarget?: ImportMediaSceneTarget,
    autoPlace?: boolean
  ) => {
    if (!projectRoot || !project) return;
    setIsBusy(true);
    try {
      const imported = await window.spliceWright.importExternalMedia(
        projectRoot,
        kind,
        sceneTarget
      );
      if (imported.length === 0) return;

      let placedChapterClipsCount = 0;
      let updatedSnapshot: VideoProjectManifest | null = null;

      updateProjectWithHistory((prev) => {
        const next: VideoProjectManifest = JSON.parse(JSON.stringify(prev));
        next.assets.push(...imported);

        const vidTrack = next.timeline.tracks.find((t) => t.type === 'video');
        const dlgTrack = next.timeline.tracks.find((t) => t.type === 'dialogue');
        const sfxTrack = next.timeline.tracks.find((t) => t.type === 'sfx');
        const musTrack = next.timeline.tracks.find((t) => t.type === 'music');

        // If user chose "Create New Scene" in the Scene Assignment prompt, register the new scene heading & sequence item
        if (sceneTarget?.mode === 'new-scene' && sceneTarget.sceneId) {
          const newSceneId = sceneTarget.sceneId;
          const newSceneOrder = sceneTarget.sceneOrder || next.sequence.length + 1;
          const newTitle = sceneTarget.sceneTitle || `Scene ${newSceneOrder}`;
          const trackEnd = (vidTrack?.clips || []).reduce(
            (max, c) => Math.max(max, c.timelineStart + getClipTimelineDuration(c)),
            0
          );
          const firstImported = imported[0];
          const newDur = firstImported ? firstImported.durationSeconds : 5;

          next.timeline.markers.push({
            id: `marker_scene_${newSceneId}`,
            time: Math.round(trackEnd * 100) / 100,
            label: `Scene ${newSceneOrder}: ${newTitle}`,
            kind: 'scene',
            sceneId: newSceneId,
            sceneOrder: newSceneOrder,
            details: newTitle,
          });

          next.sequence.push({
            id: newSceneId,
            order: newSceneOrder,
            title: newTitle,
            targetDurationSeconds: newDur,
            aspectRatio: next.format.aspectRatio,
            resolution: `${next.format.width}x${next.format.height}`,
            posterFrame:
              firstImported && firstImported.kind === 'image' ? firstImported.relativePath : null,
            selectedVideo:
              firstImported && firstImported.kind === 'video' ? firstImported.relativePath : null,
            alternateVideos: [],
            dialogue: [],
            soundEffects: [],
            music: [],
          });
        }

        // Scenario 1 (Section 8): If an imported OBS recording had chapter markers and the user opted to split into chapter sub-clips
        if (vidTrack) {
          let cursor = vidTrack.clips.reduce(
            (max, c) => Math.max(max, c.timelineStart + getClipTimelineDuration(c)),
            0
          );
          for (const asset of imported) {
            if (asset.probedChapters && asset.probedChapters.length > 0) {
              asset.probedChapters.forEach((ch, idx) => {
                const dur = Math.max(0.2, ch.endTimeSeconds - ch.startTimeSeconds);
                vidTrack.clips.push({
                  id: `clip_${asset.id}_ch_${idx + 1}`,
                  assetId: asset.id,
                  trackId: vidTrack.id,
                  sceneId: asset.sceneId,
                  label: `${ch.title} (${asset.label})`,
                  timelineStart: Math.round(cursor * 100) / 100,
                  sourceIn: ch.startTimeSeconds,
                  sourceOut: ch.endTimeSeconds,
                  playbackRate: 1.0,
                  muteSourceAudio: false,
                  volume: 1.0,
                  kenBurns: 'none',
                });
                placedChapterClipsCount++;
                cursor = Math.round((cursor + dur) * 100) / 100;
              });
            }
          }
        }

        // If assigned to a scene (or `autoPlace` is checked) and not already split by OBS chapters, place/attach onto the scene or playhead
        if (placedChapterClipsCount === 0 && autoPlace) {
          for (const asset of imported) {
            const assignedScId = sceneTarget?.sceneId;
            const assignedScOrd = sceneTarget?.sceneOrder;

            if ((asset.kind === 'video' || asset.kind === 'image') && vidTrack) {
              const existingSceneClip = assignedScId
                ? vidTrack.clips.find((c) => c.sceneId === assignedScId)
                : undefined;

              if (existingSceneClip) {
                // Attach to the scene's available takes and switch the scene's active visual to this newly imported asset!
                const takes = new Set<string>(existingSceneClip.availableTakeAssetIds || []);
                takes.add(existingSceneClip.assetId);
                takes.add(asset.id);
                existingSceneClip.availableTakeAssetIds = Array.from(takes);
                existingSceneClip.assetId = asset.id;
                existingSceneClip.label = asset.label;
                existingSceneClip.sourceIn = 0;
                existingSceneClip.sourceOut =
                  asset.kind === 'image'
                    ? Math.max(existingSceneClip.sourceOut - existingSceneClip.sourceIn, asset.durationSeconds)
                    : asset.durationSeconds;
                existingSceneClip.kenBurns = asset.kind === 'image' ? 'zoom-in' : 'none';
              } else {
                const startSec =
                  sceneTarget?.mode === 'new-scene'
                    ? vidTrack.clips.reduce(
                        (max, c) => Math.max(max, c.timelineStart + getClipTimelineDuration(c)),
                        0
                      )
                    : Math.round(playhead * 20) / 20;
                vidTrack.clips.push({
                  id: `clip_${asset.id}_${Date.now().toString().slice(-4)}`,
                  assetId: asset.id,
                  trackId: vidTrack.id,
                  sceneId: assignedScId,
                  sceneOrder: assignedScOrd,
                  label: asset.label,
                  timelineStart: Math.round(startSec * 100) / 100,
                  sourceIn: 0,
                  sourceOut: asset.durationSeconds,
                  volume: 1.0,
                  kenBurns: asset.kind === 'image' ? 'zoom-in' : 'none',
                  availableTakeAssetIds: [asset.id],
                });
              }
            } else if (asset.kind === 'dialogue' && dlgTrack) {
              const sceneMarker = assignedScId
                ? next.timeline.markers.find((m) => m.kind === 'scene' && m.sceneId === assignedScId)
                : undefined;
              const startSec = sceneMarker ? sceneMarker.time : Math.round(playhead * 20) / 20;
              dlgTrack.clips.push({
                id: `clip_${asset.id}_${Date.now().toString().slice(-4)}`,
                assetId: asset.id,
                trackId: dlgTrack.id,
                sceneId: assignedScId,
                sceneOrder: assignedScOrd,
                label: asset.label,
                timelineStart: Math.round(startSec * 100) / 100,
                sourceIn: 0,
                sourceOut: asset.durationSeconds,
                volume: 1.0,
              });
            } else if (asset.kind === 'sfx' && sfxTrack) {
              const sceneMarker = assignedScId
                ? next.timeline.markers.find((m) => m.kind === 'scene' && m.sceneId === assignedScId)
                : undefined;
              const startSec = sceneMarker ? sceneMarker.time : Math.round(playhead * 20) / 20;
              sfxTrack.clips.push({
                id: `clip_${asset.id}_${Date.now().toString().slice(-4)}`,
                assetId: asset.id,
                trackId: sfxTrack.id,
                sceneId: assignedScId,
                sceneOrder: assignedScOrd,
                label: asset.label,
                timelineStart: Math.round(startSec * 100) / 100,
                sourceIn: 0,
                sourceOut: asset.durationSeconds,
                volume: 0.9,
              });
            } else if (asset.kind === 'music' && musTrack) {
              musTrack.clips.push({
                id: `clip_${asset.id}_${Date.now().toString().slice(-4)}`,
                assetId: asset.id,
                trackId: musTrack.id,
                label: asset.label,
                timelineStart: Math.round(playhead * 20) / 20,
                sourceIn: 0,
                sourceOut: asset.durationSeconds,
                volume: 0.35,
                fadeIn: 0.5,
                fadeOut: 1.0,
              });
            }
          }
        }

        updatedSnapshot = next;
        return next;
      });

      // Immediately persist `exports/video-project.json` + `exports/studio-updates.json` so Studio sees the new asset!
      if (updatedSnapshot) {
        await window.spliceWright.saveProject(projectRoot, updatedSnapshot);
      }

      setLastImportedAssetId(imported[imported.length - 1].id);
      showToast(
        placedChapterClipsCount > 0
          ? `Imported ${imported.length} file(s) & placed ${placedChapterClipsCount} chapter sub-clips on timeline!`
          : sceneTarget?.sceneId
          ? `Imported ${imported.length} file(s) into ${
              sceneTarget.sceneTitle || sceneTarget.sceneId
            } & logged in exports/studio-updates.json!`
          : `Imported ${imported.length} ${kind.toUpperCase()} file(s) — scrolled to "${
              imported[imported.length - 1].label
            }"`
      );
    } finally {
      setIsBusy(false);
    }
  };

  const handleImportMedia = async (kind: MediaAssetKind) => {
    if (!projectRoot || !project) return;
    // For Studio projects (or projects with scenes), ask which Scene this imported asset belongs to
    // (Music defaults to Project-Wide Shared Asset, while Video/Img/Voiceover/SFX defaults to the Scene at Playhead)
    if (aiMovieExists && kind !== 'music') {
      const vidTrack = project.timeline.tracks.find((t) => t.type === 'video');
      const clipAtPlayhead = vidTrack?.clips.find((c) => {
        const dur = getClipTimelineDuration(c);
        return playhead >= c.timelineStart && playhead < c.timelineStart + dur;
      });
      const defaultSceneId =
        clipAtPlayhead?.sceneId || project.sequence[0]?.id || 'shared-project';
      setImportSceneSelection(defaultSceneId);
      setImportNewSceneTitle(`Scene ${project.sequence.length + 1}`);
      setImportAutoPlaceOnTimeline(true);
      setPendingImportKind(kind);
      return;
    }
    await executeMediaImportWithTarget(
      kind,
      { mode: 'shared-project' },
      false
    );
  };

  const handleSyncAiMovie = async (mode: 'merge-new-assets' | 'reset-to-ai-movie') => {
    if (!projectRoot || !project) return;
    setIsBusy(true);
    try {
      const bundle = await window.spliceWright.syncFromAiMovie(projectRoot, project, mode);
      applyLoadedBundle(bundle);
      setShowSyncModal(false);
      showToast(
        mode === 'merge-new-assets'
          ? 'Synced & rippled scenes with SpliceWright Studio (ai-movie.json)!'
          : 'Rebuilt timeline from SpliceWright Studio (custom BGM/SFX preserved).'
      );
    } finally {
      setIsBusy(false);
    }
  };

  const handleRefreshSingleClip = async (clipId: string) => {
    if (!projectRoot || !project) return;
    setIsBusy(true);
    try {
      const res = await window.spliceWright.refreshSingleClipMedia(projectRoot, project, clipId);
      updateProjectWithHistory(() => res.project);
      showToast(
        `Refreshed "${res.refreshedLabel}" (${res.newDurationSeconds.toFixed(1)}s) from disk / Studio without modifying other clips!`
      );
    } catch (err) {
      showToast(`Refresh clip error: ${(err as Error).message}`);
    } finally {
      setIsBusy(false);
    }
  };

  const handleNormalizeDialogue = async (includeSfxAndMusic: boolean = false) => {
    if (!projectRoot || !project || isNormalizing) return;
    setIsNormalizing(true);
    setIsPlaying(false);
    showToast(
      includeSfxAndMusic
        ? 'Leveling Narration (dynaudnorm) + SFX & Music (EBU R128 loudnorm) with FFmpeg...'
        : 'Normalising & leveling narration audio clips with FFmpeg (dynaudnorm)...'
    );
    try {
      const res = await window.spliceWright.normalizeDialogueAudioClips(
        projectRoot,
        project,
        includeSfxAndMusic
      );
      updateProjectWithHistory(() => res.project);
      showToast(
        includeSfxAndMusic
          ? `Leveled ${res.normalizedCount} audio clip(s) across Narration, SFX & Music!`
          : `Normalised ${res.normalizedCount} narration clip(s) — soft endings lifted & loud jumps leveled!`
      );
    } catch (err) {
      showToast(`Normalisation error: ${(err as Error).message}`);
    } finally {
      setIsNormalizing(false);
    }
  };

  const handlePreMixAudio = async () => {
    if (!projectRoot || !project || isPreMixingAudio) return;
    setIsPreMixingAudio(true);
    setIsPlaying(false);
    showToast('Rendering invisible master MP3 audio pre-mix for zero-lag live preview...');
    try {
      const res = await window.spliceWright.renderPreviewAudioMix(projectRoot, project);
      setProject(res.project);
      showToast('Master MP3 Audio Pre-Mix active! Live preview now plays a single pre-mixed stream.');
    } catch (err) {
      showToast(`Audio Pre-Mix error: ${(err as Error).message}`);
    } finally {
      setIsPreMixingAudio(false);
    }
  };

  const handleAddChaptersToStitch = async () => {
    const selected = await window.spliceWright.selectVideoFilesForStitching();
    if (selected.length === 0) return;
    setStitchItems((prev) => {
      const next = [...prev, ...selected];
      if (!stitchOutputPath && selected[0]?.filePath) {
        const sep = selected[0].filePath.includes('\\') ? '\\' : '/';
        const dir = selected[0].filePath.replace(/[\\/][^\\/]+$/, '');
        setStitchOutputPath(`${dir}${sep}full-stitched-movie.mp4`);
      }
      return next;
    });
  };

  const handleMoveStitchItem = (index: number, direction: -1 | 1) => {
    setStitchItems((prev) => {
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
      const copy = [...prev];
      const [item] = copy.splice(index, 1);
      copy.splice(target, 0, item);
      return copy;
    });
  };

  const handleRemoveStitchItem = (index: number) => {
    setStitchItems((prev) => prev.filter((_, i) => i !== index));
  };

  const handleScanStitchCatalogue = async (folderPath?: string) => {
    const cat = await window.spliceWright.scanStitchCatalogueFolder(folderPath);
    if (!cat) return;
    setStitchCatalogueRoot(cat.productionRoot);
    setStitchItems(cat.items);
    setStitchOutputPath(cat.outputFilePath);
    setStitchSpacerSeconds(cat.spacerSeconds);
    setStitchMergeSubtitles(cat.mergeSubtitles);
    showToast(`Loaded Production Catalogue (${cat.items.length} chapter(s)) from ${cat.productionRoot}`);
  };

  const handleSaveStitchCatalogue = async () => {
    if (!stitchCatalogueRoot) return;
    const cat: StitchCatalogue = {
      schemaVersion: '1.0',
      productionRoot: stitchCatalogueRoot,
      title: stitchCatalogueRoot.split(/[\\/]/).pop() || 'Production',
      updatedAt: new Date().toISOString(),
      outputFilePath: stitchOutputPath,
      spacerSeconds: stitchSpacerSeconds,
      mergeSubtitles: stitchMergeSubtitles,
      items: stitchItems,
    };
    const res = await window.spliceWright.saveStitchCatalogue(cat);
    showToast(`Saved movie-catalogue.json to ${res.savedPath}`);
  };

  const handleOpenChapterFromCatalogue = async (chapterFolderPath: string) => {
    const bundle = await window.spliceWright.openProjectFolder(chapterFolderPath);
    applyLoadedBundle(bundle);
    setShowStitchModal(false);
    showToast(`Opened chapter in editor: ${bundle.project.title}`);
  };

  const handleRunStitchChapters = async () => {
    const readyItems = stitchItems.filter((i) => Boolean(i.filePath));
    if (readyItems.length === 0 || !stitchOutputPath || isStitching) return;
    setIsStitching(true);
    setIsPlaying(false);
    setExportProgress({
      phase: 'preparing',
      percent: 5,
      message: 'Starting chapter stitching...',
    });
    try {
      if (stitchCatalogueRoot) {
        await window.spliceWright.saveStitchCatalogue({
          schemaVersion: '1.0',
          productionRoot: stitchCatalogueRoot,
          title: stitchCatalogueRoot.split(/[\\/]/).pop() || 'Production',
          updatedAt: new Date().toISOString(),
          outputFilePath: stitchOutputPath,
          spacerSeconds: stitchSpacerSeconds,
          mergeSubtitles: stitchMergeSubtitles,
          items: stitchItems,
        });
      }
      const res = await window.spliceWright.stitchVideoChapters({
        items: readyItems,
        outputFilePath: stitchOutputPath,
        spacerSeconds: stitchSpacerSeconds,
        mergeSubtitles: stitchMergeSubtitles,
      });
      showToast(
        `Stitched ${readyItems.length} chapters (${Math.round(res.totalDurationSeconds)}s) to ${res.outputPath}`
      );
    } catch (err) {
      setExportProgress({
        phase: 'error',
        percent: 0,
        message: (err as Error).message,
      });
    } finally {
      setIsStitching(false);
    }
  };

  const handleChangeAspectRatio = (newRatio: string) => {
    setProject((prev) => {
      if (!prev) return prev;
      const formatMap: Record<string, VideoProjectFormat> = {
        '16:9': { aspectRatio: '16:9', width: 1920, height: 1080, fps: 30 },
        '9:16': { aspectRatio: '9:16', width: 1080, height: 1920, fps: 30 },
        '1:1': { aspectRatio: '1:1', width: 1080, height: 1080, fps: 30 },
        '21:9': { aspectRatio: '21:9', width: 2560, height: 1080, fps: 30 },
        '4:3': { aspectRatio: '4:3', width: 1440, height: 1080, fps: 30 },
      };
      const format = formatMap[newRatio] || formatMap['16:9'];
      return {
        ...prev,
        format,
      };
    });
  };

  const handleStartExport = async () => {
    if (!projectRoot || !project) return;
    setIsPlaying(false);
    const options: ExportOptions = {
      outputFileName: exportFileName,
      preset: exportPreset,
      encoder: exportEncoder,
      burnSubtitles: false,
      exportSrtFile: exportSrt,
      exportFcpxml,
    };
    try {
      await window.spliceWright.exportMovie(projectRoot, project, options);
    } catch (err) {
      setExportProgress({
        phase: 'error',
        percent: 0,
        message: (err as Error).message,
      });
    }
  };

  // Topic 14: If this window is the External 2nd-Screen Program Monitor (`?mode=external-monitor`),
  // render a dedicated 100% full-window Program Monitor!
  if (isExternalMonitorMode) {
    return (
      <div style={{ width: '100vw', height: '100vh', background: '#060911', overflow: 'hidden' }}>
        {!project || !projectRoot ? (
          <div
            style={{
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#94a3b8',
              gap: '10px',
            }}
          >
            <Monitor size={36} color="#38bdf8" />
            <div style={{ fontSize: '16px', fontWeight: 700, color: '#f8fafc' }}>
              SpliceWright — External Program Monitor (2nd Screen)
            </div>
            <div style={{ fontSize: '12px' }}>
              Waiting for an active project on Monitor 1...
            </div>
          </div>
        ) : (
          <PreviewPlayer
            projectRoot={projectRoot}
            project={project}
            playhead={playhead}
            isPlaying={isPlaying}
            recommendedPoolSize={hardware?.recommendedVideoPoolSize || 2}
            muteAllAudio={false}
            onPlayheadChange={(t) => {
              setPlayhead(t);
              dualMonitorChannelRef.current?.postMessage({
                type: 'command',
                action: 'seek',
                time: t,
              });
            }}
            onTogglePlay={() => {
              dualMonitorChannelRef.current?.postMessage({
                type: 'command',
                action: 'toggle-play',
              });
            }}
          />
        )}
      </div>
    );
  }

  const isAnyTaskRunning = isBusy || isNormalizing || isPreMixingAudio || isStitching;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        width: '100vw',
        cursor: isAnyTaskRunning ? 'wait' : undefined,
      }}
    >
      {isAnyTaskRunning && <style>{`* { cursor: wait !important; }`}</style>}
      {/* Top Application Header Bar (2-Row Layout: Row 1 = Project Identity & Sync, Row 2 = Dedicated Action Ribbon) */}
      <header
        style={{
          background: '#0b101d',
          borderBottom: '1px solid #1e293b',
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 0,
        }}
      >
        {/* Row 1: Brand, Project Title, Format, Look Preset & Sync Studio Status */}
        <div
          style={{
            minHeight: '42px',
            padding: '5px 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
            borderBottom: '1px solid #162035',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, flexWrap: 'wrap' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                fontWeight: 700,
                fontSize: '15px',
                color: '#f8fafc',
                whiteSpace: 'nowrap',
              }}
            >
              <Clapperboard size={19} color="#f59e0b" />
              <span>SpliceWright</span>
            </div>

            {project && (
              <>
                <span style={{ color: '#334155' }}>|</span>
                <span
                  style={{
                    fontSize: '13px',
                    fontWeight: 600,
                    color: '#38bdf8',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {project.title}
                </span>
                <span
                  style={{
                    fontSize: '10px',
                    padding: '2px 7px',
                    borderRadius: '4px',
                    background: aiMovieExists
                      ? 'rgba(16, 185, 129, 0.15)'
                      : 'rgba(56, 189, 248, 0.15)',
                    border: aiMovieExists ? '1px solid #10b981' : '1px solid #38bdf8',
                    color: aiMovieExists ? '#34d399' : '#38bdf8',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {aiMovieExists
                    ? 'SpliceWright Studio (ai-movie.json R/O)'
                    : 'Standalone Folder Mode'}
                </span>

                {/* Aspect Ratio Selector (Never Locked to 9:16) */}
                <select
                  value={project.format.aspectRatio}
                  onChange={(e) => handleChangeAspectRatio(e.target.value)}
                  title="Project Aspect Ratio & Output Resolution"
                  style={{
                    background: '#161f33',
                    color: '#e2e8f0',
                    border: '1px solid #283552',
                    borderRadius: '4px',
                    padding: '3px 8px',
                    fontSize: '11px',
                  }}
                >
                  <option value="16:9">16:9 Widescreen (1920×1080)</option>
                  <option value="9:16">9:16 Vertical (1080×1920)</option>
                  <option value="1:1">1:1 Square (1080×1080)</option>
                  <option value="21:9">21:9 Cinema (2560×1080)</option>
                  <option value="4:3">4:3 Classic (1440×1080)</option>
                </select>

                {/* Topic 12: Non-Destructive Visual & Vintage Audio Look Preset Selector */}
                <select
                  value={project.lookPreset || 'none'}
                  onChange={(e) =>
                    updateProjectWithHistory((prev) => ({
                      ...prev,
                      lookPreset: e.target.value as VisualLookPreset,
                    }))
                  }
                  title="Non-Destructive Visual Look & Vintage Audio Preset (applies uniformly across all scenes, posters, and exports)"
                  style={{
                    background: '#161f33',
                    color:
                      project.lookPreset && project.lookPreset !== 'none' ? '#fbbf24' : '#cbd5e1',
                    border:
                      project.lookPreset && project.lookPreset !== 'none'
                        ? '1px solid #f59e0b'
                        : '1px solid #283552',
                    borderRadius: '4px',
                    padding: '3px 8px',
                    fontSize: '11px',
                  }}
                >
                  {(Object.keys(VISUAL_LOOK_PRESET_LABELS) as VisualLookPreset[]).map((key) => (
                    <option key={key} value={key}>
                      Look: {VISUAL_LOOK_PRESET_LABELS[key]}
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>

          {/* Right side of Row 1: Status Toast & Sync Studio / Convert to Studio Project */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
            {statusToast && (
              <div
                style={{
                  background: 'rgba(14, 116, 144, 0.25)',
                  border: '1px solid #06b6d4',
                  color: '#67e8f9',
                  padding: '4px 10px',
                  borderRadius: '5px',
                  fontSize: '11px',
                  maxWidth: '420px',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                title={statusToast}
              >
                {statusToast}
              </div>
            )}

            {project && !aiMovieExists && (
              <button
                onClick={handleConvertStandaloneToStudio}
                disabled={isBusy}
                style={{
                  ...headerBtnStyle,
                  background: 'rgba(16, 185, 129, 0.16)',
                  borderColor: '#10b981',
                  color: '#34d399',
                  fontWeight: 600,
                }}
                title="Convert this Standalone folder into a SpliceWright Studio project (creates ai-movie.json & extracts scene first-frame thumbnails)"
              >
                <Wand2 size={13} color="#34d399" />
                <span>Convert to Studio Project</span>
              </button>
            )}

            {aiMovieExists && (
              <button
                onClick={() => setShowSyncModal(true)}
                style={{
                  ...headerBtnStyle,
                  background: syncSummary?.hasChanges ? '#065f46' : '#161f33',
                  borderColor: syncSummary?.hasChanges ? '#10b981' : '#f59e0b',
                  color: syncSummary?.hasChanges ? '#ecfdf5' : '#fbbf24',
                  fontWeight: syncSummary?.hasChanges ? 600 : 500,
                }}
                title="Sync changes or rebuild timeline from SpliceWright Studio (ai-movie.json)"
              >
                <RefreshCw size={13} />
                <span>
                  {syncSummary?.hasChanges
                    ? `Sync Studio (+${syncSummary.newTakesCount} takes, +${syncSummary.newDialogueCount} audio${
                        syncSummary.modifiedMediaCount
                          ? `, ${syncSummary.modifiedMediaCount} updated`
                          : ''
                      }${
                        syncSummary.newScenesCount
                          ? `, +${syncSummary.newScenesCount} scenes`
                          : ''
                      }${
                        syncSummary.durationChangesCount
                          ? `, ${syncSummary.durationChangesCount} timing`
                          : ''
                      }${
                        syncSummary.newTextOverlaysCount
                          ? `, +${syncSummary.newTextOverlaysCount} text`
                          : ''
                      })`
                    : 'Sync / Rebuild'}
                </span>
              </button>
            )}
          </div>
        </div>

        {/* Row 2: Dedicated Action Ribbon (All Action Buttons after Sync Studio, Always Visible even on Non-Maximized Windows) */}
        <div
          style={{
            minHeight: '40px',
            padding: '5px 16px',
            background: '#080c17',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '8px',
            flexWrap: 'wrap',
          }}
        >
          {/* Left Ribbon Group: Project & Workflow Tools */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <button onClick={handleOpenProjectFolder} style={headerBtnStyle}>
              <FolderOpen size={14} color="#fbbf24" />
              <span>Open Project</span>
            </button>

            <button
              onClick={() => setShowNewStandaloneModal(true)}
              style={headerBtnStyle}
              title="Create or Open a Standalone Media Folder"
            >
              <FolderPlus size={14} color="#38bdf8" />
              <span>Standalone Folder</span>
            </button>

            <button
              onClick={() => {
                setExportProgress(null);
                setShowStitchModal(true);
              }}
              style={{
                ...headerBtnStyle,
                borderColor: '#a855f7',
                color: '#e9d5ff',
              }}
              title="Stitch multiple exported Chapter / Reel MP4 videos (or scan a Production Catalogue folder) into a 20–60+ minute movie"
            >
              <Film size={14} color="#c084fc" />
              <span>Stitch Chapters</span>
            </button>

            {hardware && (
              <div
                title={`Adaptive Hardware Profile: ${hardware.cpuCores} cores, ${hardware.totalMemoryGb} GB RAM | Preferred Encoder: ${hardware.preferredEncoder} | Video Preload Pool: ${hardware.recommendedVideoPoolSize}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '5px',
                  fontSize: '11px',
                  color: '#94a3b8',
                  background: '#131c2e',
                  padding: '4px 8px',
                  borderRadius: '4px',
                  border: '1px solid #1e293b',
                  whiteSpace: 'nowrap',
                }}
              >
                <Cpu size={13} color="#38bdf8" />
                <span>{hardware.preferredEncoder}</span>
              </div>
            )}
          </div>

          {/* Right Ribbon Group: 2nd Screen, Buy Me a Coffee, Save & Export MP4 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <button
              onClick={() => window.spliceWright.openExternalUrl(BUY_ME_A_COFFEE_URL)}
              style={{
                ...headerBtnStyle,
                background: 'rgba(245, 158, 11, 0.14)',
                border: '1px solid #f59e0b',
                color: '#fde68a',
                fontWeight: 600,
              }}
              title="Support SpliceWright on Buy Me a Coffee (buymeacoffee.com/les.ey)"
            >
              <Coffee size={14} color="#fbbf24" />
              <span>Buy Me a Coffee</span>
            </button>

            {project && (
              <>
                <button
                  onClick={async () => {
                    const res = await window.spliceWright.toggleDualMonitorWindow();
                    setIsDualMonitorOpen(res.isOpen);
                  }}
                  style={{
                    ...headerBtnStyle,
                    background: isDualMonitorOpen ? '#065f46' : '#161f33',
                    borderColor: isDualMonitorOpen ? '#10b981' : '#38bdf8',
                    color: isDualMonitorOpen ? '#ecfdf5' : '#bae6fd',
                  }}
                  title="Pop out the Program Monitor onto a 2nd Screen and expand Timeline & Media Bin on Monitor 1"
                >
                  <Monitor size={14} color={isDualMonitorOpen ? '#34d399' : '#38bdf8'} />
                  <span>{isDualMonitorOpen ? '2nd Screen: ON' : '2nd Screen'}</span>
                </button>

                <button onClick={handleSaveProject} style={headerBtnStyle} title="Save video-project.json & studio-updates.json">
                  <Save size={14} color="#34d399" />
                  <span>Save</span>
                </button>

                <button
                  onClick={() => {
                    setExportProgress(null);
                    setShowExportModal(true);
                  }}
                  style={{
                    ...headerBtnStyle,
                    background: '#2563eb',
                    borderColor: '#3b82f6',
                    color: '#fff',
                    fontWeight: 600,
                  }}
                >
                  <Download size={14} />
                  <span>Export MP4</span>
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Main Content Area: Welcome Screen OR Editor Workspace */}
      {!project || !projectRoot ? (
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '32px',
            background: 'radial-gradient(circle at top, #131c31 0%, #070a12 70%)',
          }}
        >
          <div
            style={{
              maxWidth: '780px',
              width: '100%',
              background: '#0f1626',
              border: '1px solid #22304d',
              borderRadius: '12px',
              padding: '32px',
              boxShadow: '0 20px 50px rgba(0,0,0,0.6)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '12px',
                marginBottom: '12px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <Clapperboard size={32} color="#f59e0b" />
                <div>
                  <h1 style={{ fontSize: '22px', fontWeight: 700, color: '#f8fafc' }}>
                    Welcome to SpliceWright
                  </h1>
                  <p style={{ fontSize: '13px', color: '#94a3b8' }}>
                    Local-First Video Editor for SpliceWright Studio & Standalone Projects (GPL-3.0 • Zero SaaS)
                  </p>
                </div>
              </div>

              <button
                onClick={() => window.spliceWright.openExternalUrl(BUY_ME_A_COFFEE_URL)}
                style={{
                  ...headerBtnStyle,
                  background: '#f59e0b',
                  borderColor: '#fbbf24',
                  color: '#090d16',
                  fontWeight: 700,
                  padding: '8px 14px',
                }}
                title="Support SpliceWright on Buy Me a Coffee (https://www.buymeacoffee.com/les.ey)"
              >
                <Coffee size={15} color="#090d16" />
                <span>Buy Me a Coffee</span>
              </button>
            </div>

            {isStudioAutoLaunching && studioLaunchPath && (
              <div
                style={{
                  marginTop: '16px',
                  padding: '12px 16px',
                  background: 'rgba(16, 185, 129, 0.14)',
                  border: '1px solid #10b981',
                  borderRadius: '8px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  color: '#ecfdf5',
                  fontSize: '13px',
                }}
              >
                <RefreshCw size={16} color="#34d399" />
                <div>
                  <strong>Launching Project from SpliceWright Studio...</strong>
                  <div style={{ fontSize: '11px', color: '#a7f3d0', marginTop: '2px' }}>
                    Loading scenes, media assets, and timeline from <code>{studioLaunchPath}</code>. Start screen options are disabled while loading.
                  </div>
                </div>
              </div>
            )}

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr 1fr',
                gap: '14px',
                marginTop: '24px',
                opacity: isStudioAutoLaunching || isBusy ? 0.42 : 1,
                pointerEvents: isStudioAutoLaunching || isBusy ? 'none' : 'auto',
                filter: isStudioAutoLaunching || isBusy ? 'grayscale(0.55)' : 'none',
                transition: 'opacity 0.2s ease',
              }}
            >
              {/* Card 1: Open SpliceWright Studio Project */}
              <div style={welcomeCardStyle}>
                <FolderOpen size={24} color="#fbbf24" />
                <h3 style={{ fontSize: '14px', fontWeight: 600, marginTop: '8px' }}>
                  1. Open SpliceWright Studio Folder
                </h3>
                <p style={{ fontSize: '12px', color: '#94a3b8', marginTop: '6px', flex: 1 }}>
                  Select a folder containing <code>ai-movie.json</code>. SpliceWright monitors it as
                  Read-Only, loads all scenes, takes, ElevenLabs dialogue, and storyboard SFX cues.
                </p>
                <button
                  onClick={handleOpenProjectFolder}
                  disabled={isStudioAutoLaunching || isBusy}
                  style={{ ...primaryActionBtnStyle, marginTop: '14px', background: '#d97706' }}
                >
                  Select Studio Folder
                </button>
              </div>

              {/* Card 2: Standalone Folder Workflow */}
              <div style={welcomeCardStyle}>
                <FolderPlus size={24} color="#38bdf8" />
                <h3 style={{ fontSize: '14px', fontWeight: 600, marginTop: '8px' }}>
                  2. Standalone Folder Mode
                </h3>
                <p style={{ fontSize: '12px', color: '#94a3b8', marginTop: '6px', flex: 1 }}>
                  Pick any folder (including on an external 1 TB SSD) and import your own video clips,
                  voiceovers, music, and sound effects into a self-contained project.
                </p>
                <button
                  onClick={() => setShowNewStandaloneModal(true)}
                  disabled={isStudioAutoLaunching || isBusy}
                  style={{ ...primaryActionBtnStyle, marginTop: '14px', background: '#0284c7' }}
                >
                  Start Standalone Folder
                </button>
              </div>

              {/* Card 3: Instant Sample AI Movie */}
              <div style={welcomeCardStyle}>
                <Sparkles size={24} color="#a855f7" />
                <h3 style={{ fontSize: '14px', fontWeight: 600, marginTop: '8px' }}>
                  3. Try Sample AI Movie
                </h3>
                <p style={{ fontSize: '12px', color: '#94a3b8', marginTop: '6px', flex: 1 }}>
                  Generate and open a complete test AI Movie project (<em>"Neon Gate"</em>) with
                  multiple scene takes, dialogue clips, first-frame fallback, and BGM/SFX.
                </p>
                <button
                  onClick={handleLoadSampleProject}
                  disabled={isStudioAutoLaunching || isBusy}
                  style={{ ...primaryActionBtnStyle, marginTop: '14px', background: '#7e22ce' }}
                >
                  Load Sample Project
                </button>
              </div>
            </div>

            {hardware && (
              <div
                style={{
                  marginTop: '22px',
                  padding: '10px 14px',
                  background: '#090d16',
                  borderRadius: '8px',
                  border: '1px solid #1e293b',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  fontSize: '12px',
                  color: '#94a3b8',
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <HardDrive size={14} color="#10b981" />
                  Portable & External SSD Ready (All project paths & scratch renders stay on the
                  project drive)
                </span>
                <span>
                  Hardware Tier: <strong style={{ color: '#e2e8f0' }}>{hardware.tier}</strong> (
                  {hardware.totalMemoryGb} GB RAM • Encoder:{' '}
                  <strong style={{ color: '#38bdf8' }}>{hardware.preferredEncoder}</strong>)
                </span>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Upper Split: When 2nd Screen Monitor is active, Media Bin & Inspector gets 100% width in side-by-side layout */}
          <div
            style={{
              height: isDualMonitorOpen ? '48%' : '54%',
              display: 'flex',
              overflow: 'hidden',
            }}
          >
            {!isDualMonitorOpen && (
              <div style={{ width: '58%', height: '100%' }}>
                <PreviewPlayer
                  projectRoot={projectRoot}
                  project={project}
                  playhead={playhead}
                  selectedClipId={selectedClipId}
                  onSelectClip={setSelectedClipId}
                  onUpdateProject={updateProjectWithHistory}
                  onCommitUndoSnapshot={commitUndoSnapshot}
                  isPlaying={isPlaying}
                  recommendedPoolSize={hardware?.recommendedVideoPoolSize || 2}
                  onPlayheadChange={(t) => setPlayhead(t)}
                  onTogglePlay={() => setIsPlaying((p) => !p)}
                />
              </div>
            )}
            <div style={{ width: isDualMonitorOpen ? '100%' : '42%', height: '100%' }}>
              <MediaBinAndInspector
                project={project}
                playhead={playhead}
                selectedClipId={selectedClipId}
                lastImportedAssetId={lastImportedAssetId}
                isExpandedWidth={isDualMonitorOpen}
                onImportMedia={handleImportMedia}
                onUpdateProject={updateProjectWithHistory}
                onRefreshSingleClip={handleRefreshSingleClip}
              />
            </div>
          </div>

          {/* Lower Split: Multi-Track Timeline Editor */}
          <div style={{ height: isDualMonitorOpen ? '52%' : '46%', overflow: 'hidden' }}>
            <TimelineEditor
              project={project}
              playhead={playhead}
              selectedClipId={selectedClipId}
              isNormalizing={isNormalizing}
              isPreMixingAudio={isPreMixingAudio}
              canUndo={historyCounts.past > 0}
              canRedo={historyCounts.future > 0}
              onUndo={handleUndo}
              onRedo={handleRedo}
              onPlayheadChange={(t) => setPlayhead(t)}
              onSelectClip={(id) => setSelectedClipId(id)}
              onUpdateProject={updateProjectWithHistory}
              onCommitUndoSnapshot={commitUndoSnapshot}
              onNormalizeDialogue={handleNormalizeDialogue}
              onPreMixAudio={handlePreMixAudio}
              onPausePlayback={() => setIsPlaying(false)}
            />
          </div>
        </div>
      )}

      {/* Modal: Assign Imported Media to Scene (Editor -> Studio Outbox `exports/studio-updates.json`) */}
      {pendingImportKind && project && projectRoot && (
        <div style={modalBackdropStyle}>
          <div style={{ ...modalBoxStyle, width: '500px' }}>
            <h2 style={{ fontSize: '16px', fontWeight: 700, marginBottom: '8px', color: '#f8fafc' }}>
              Assign Imported {pendingImportKind.toUpperCase()} to Scene
            </h2>
            <p style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '14px', lineHeight: 1.45 }}>
              Select which scene this file belongs to so <strong>SpliceWright</strong> can store it
              in the right folder and notify <strong>SpliceWright Studio</strong> via{' '}
              <code>exports/studio-updates.json</code>.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '12px' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span style={{ fontWeight: 600, color: '#cbd5e1' }}>Target Scene Assignment</span>
                <select
                  value={importSceneSelection}
                  onChange={(e) => setImportSceneSelection(e.target.value)}
                  style={modalInputStyle}
                >
                  {project.sequence.map((seq) => (
                    <option key={seq.id} value={seq.id}>
                      Scene {seq.order}: {seq.title} ({seq.id})
                    </option>
                  ))}
                  <option value="new-scene">➕ Create a New Scene for this Asset</option>
                  <option value="shared-project">
                    🌐 Project-Wide / Shared Asset (assets/ — No Specific Scene)
                  </option>
                </select>
              </label>

              {importSceneSelection === 'new-scene' && (
                <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <span style={{ fontWeight: 600, color: '#34d399' }}>New Scene Title</span>
                  <input
                    type="text"
                    value={importNewSceneTitle}
                    onChange={(e) => setImportNewSceneTitle(e.target.value)}
                    placeholder="Enter scene title..."
                    style={modalInputStyle}
                  />
                </label>
              )}

              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  marginTop: '4px',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={importAutoPlaceOnTimeline}
                  onChange={(e) => setImportAutoPlaceOnTimeline(e.target.checked)}
                />
                <span>
                  {importSceneSelection === 'shared-project'
                    ? 'Also place clip onto timeline at current Playhead position'
                    : importSceneSelection === 'new-scene'
                    ? 'Place new scene at the end of the timeline'
                    : 'Set as active clip on the selected scene (and add to scene Take Switcher)'}
                </span>
              </label>
            </div>

            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '8px',
                marginTop: '18px',
              }}
            >
              <button onClick={() => setPendingImportKind(null)} style={headerBtnStyle}>
                Cancel
              </button>
              <button
                onClick={async () => {
                  const kindToRun = pendingImportKind;
                  setPendingImportKind(null);
                  if (!kindToRun) return;

                  let target: ImportMediaSceneTarget;
                  if (importSceneSelection === 'shared-project') {
                    target = { mode: 'shared-project' };
                  } else if (importSceneSelection === 'new-scene') {
                    const maxNum = project.sequence.reduce((max, s) => {
                      const m = s.id.match(/^scene-(\d+)$/i);
                      return m ? Math.max(max, parseInt(m[1], 10)) : max;
                    }, project.sequence.length);
                    const nextSceneId = `scene-${maxNum + 1}`;
                    const nextOrder = project.sequence.length + 1;
                    target = {
                      mode: 'new-scene',
                      sceneId: nextSceneId,
                      sceneOrder: nextOrder,
                      sceneTitle: importNewSceneTitle.trim() || `Scene ${nextOrder}`,
                    };
                  } else {
                    const seq = project.sequence.find((s) => s.id === importSceneSelection);
                    target = {
                      mode: 'assigned-scene',
                      sceneId: importSceneSelection,
                      sceneOrder: seq?.order,
                      sceneTitle: seq?.title || importSceneSelection,
                    };
                  }

                  await executeMediaImportWithTarget(
                    kindToRun,
                    target,
                    importAutoPlaceOnTimeline
                  );
                }}
                style={{
                  ...headerBtnStyle,
                  background: '#059669',
                  borderColor: '#10b981',
                  color: '#fff',
                  fontWeight: 600,
                }}
              >
                Choose File(s)...
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Create/Open Standalone Folder Project */}
      {showNewStandaloneModal && (
        <div style={modalBackdropStyle}>
          <div style={modalBoxStyle}>
            <h2 style={{ fontSize: '16px', fontWeight: 700, marginBottom: '12px' }}>
              Standalone Project Folder Workflow
            </h2>
            <p style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '14px' }}>
              Select any folder on your laptop or external SSD. Imported video, music, and SFX files
              will be stored inside <code>assets/video/</code> and <code>assets/audio/</code> so the
              project stays 100% self-contained.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '12px' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span>Target Project Folder</span>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <input
                    type="text"
                    value={standaloneFolder}
                    onChange={(e) => setStandaloneFolder(e.target.value)}
                    placeholder="Select or paste folder path..."
                    style={{ ...modalInputStyle, flex: 1 }}
                  />
                  <button
                    onClick={async () => {
                      const chosen = await window.spliceWright.selectFolderDialog(
                        'Choose Folder for Standalone Project'
                      );
                      if (chosen) setStandaloneFolder(chosen);
                    }}
                    style={headerBtnStyle}
                  >
                    Browse...
                  </button>
                </div>
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span>Project Title</span>
                <input
                  type="text"
                  value={standaloneTitle}
                  onChange={(e) => setStandaloneTitle(e.target.value)}
                  style={modalInputStyle}
                />
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span>Aspect Ratio</span>
                <select
                  value={standaloneAspect}
                  onChange={(e) => setStandaloneAspect(e.target.value)}
                  style={modalInputStyle}
                >
                  <option value="16:9">16:9 Widescreen (1920×1080)</option>
                  <option value="9:16">9:16 Vertical (1080×1920)</option>
                  <option value="1:1">1:1 Square (1080×1080)</option>
                  <option value="21:9">21:9 Cinema (2560×1080)</option>
                </select>
              </label>
            </div>

            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '8px',
                marginTop: '18px',
              }}
            >
              <button
                onClick={() => setShowNewStandaloneModal(false)}
                style={headerBtnStyle}
              >
                Cancel
              </button>
              <button
                onClick={handleCreateStandalone}
                disabled={!standaloneFolder}
                style={{
                  ...headerBtnStyle,
                  background: '#0284c7',
                  color: '#fff',
                  opacity: standaloneFolder ? 1 : 0.5,
                }}
              >
                Open / Initialize Folder
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Export Movie via FFmpeg */}
      {showExportModal && project && projectRoot && (
        <div style={modalBackdropStyle}>
          <div style={modalBoxStyle}>
            <h2 style={{ fontSize: '16px', fontWeight: 700, marginBottom: '8px' }}>
              Export Movie to <code>exports/</code>
            </h2>
            <p style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '14px' }}>
              Renders the spliced video clips, poster holds, dialogue tracks, SFX, and auto-ducked
              background music using bundled FFmpeg. Temporary scratch files are written to{' '}
              <code>exports/.temp/</code> on the project drive.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '12px' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span>Output File Name (inside {projectRoot}\exports\)</span>
                <input
                  type="text"
                  value={exportFileName}
                  onChange={(e) => setExportFileName(e.target.value)}
                  style={modalInputStyle}
                />
              </label>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <span>Speed / Quality Preset</span>
                  <select
                    value={exportPreset}
                    onChange={(e) => setExportPreset(e.target.value as ExportPreset)}
                    style={modalInputStyle}
                  >
                    <option value="fast-draft">Fast Draft (Best for Low-Spec Laptop)</option>
                    <option value="balanced">Balanced (Recommended)</option>
                    <option value="high-quality">High Quality Master</option>
                  </select>
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <span>Hardware / Software Encoder</span>
                  <select
                    value={exportEncoder}
                    onChange={(e) => setExportEncoder(e.target.value)}
                    style={modalInputStyle}
                  >
                    {(hardware?.availableEncoders || ['libx264']).map((enc) => (
                      <option key={enc} value={enc}>
                        {enc} {enc === hardware?.preferredEncoder ? '(Recommended)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
                <input
                  type="checkbox"
                  checked={exportSrt}
                  onChange={(e) => setExportSrt(e.target.checked)}
                />
                <span>Also generate synchronized .SRT subtitle file from Dialogue track</span>
              </label>

              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' }}>
                <input
                  type="checkbox"
                  checked={exportFcpxml}
                  onChange={(e) => setExportFcpxml(e.target.checked)}
                />
                <span>
                  Also export Final Cut Pro XML (<code>.fcpxml</code>) for DaVinci Resolve / Premiere Pro
                </span>
              </label>
            </div>

            {exportProgress && (
              <div
                style={{
                  marginTop: '14px',
                  padding: '10px 12px',
                  background: '#090d16',
                  borderRadius: '6px',
                  border: '1px solid #1e293b',
                  fontSize: '12px',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: '6px',
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {exportProgress.phase === 'complete' ? (
                      <CheckCircle2 size={15} color="#10b981" />
                    ) : exportProgress.phase === 'error' ? (
                      <AlertTriangle size={15} color="#ef4444" />
                    ) : null}
                    {exportProgress.message}
                  </span>
                  <span style={{ fontWeight: 700, color: '#38bdf8' }}>
                    {exportProgress.percent}%
                  </span>
                </div>

                <div
                  style={{
                    height: '6px',
                    background: '#1e293b',
                    borderRadius: '3px',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: `${exportProgress.percent}%`,
                      height: '100%',
                      background:
                        exportProgress.phase === 'error'
                          ? '#ef4444'
                          : exportProgress.phase === 'complete'
                          ? '#10b981'
                          : '#38bdf8',
                      transition: 'width 0.2s ease',
                    }}
                  />
                </div>

                {exportProgress.outputPath && (
                  <div style={{ marginTop: '8px', display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                      onClick={() =>
                        window.spliceWright.openPathInExplorer(exportProgress.outputPath!)
                      }
                      style={{
                        ...headerBtnStyle,
                        background: '#065f46',
                        color: '#ecfdf5',
                      }}
                    >
                      <ExternalLink size={13} />
                      <span>Show Rendered MP4 in Explorer</span>
                    </button>
                  </div>
                )}
              </div>
            )}

            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '8px',
                marginTop: '18px',
              }}
            >
              <button onClick={() => setShowExportModal(false)} style={headerBtnStyle}>
                Close
              </button>
              <button
                onClick={handleStartExport}
                disabled={
                  exportProgress !== null &&
                  exportProgress.phase !== 'complete' &&
                  exportProgress.phase !== 'error'
                }
                style={{
                  ...headerBtnStyle,
                  background: '#2563eb',
                  color: '#fff',
                  fontWeight: 600,
                }}
              >
                <Download size={14} />
                <span>Start FFmpeg Render</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Sync / Rebuild from SpliceWright Studio Warning & Options */}
      {showSyncModal && project && projectRoot && (
        <div style={modalBackdropStyle}>
          <div style={{ ...modalBoxStyle, width: '560px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
              <AlertTriangle size={22} color="#f59e0b" />
              <h2 style={{ fontSize: '16px', fontWeight: 700, color: '#f8fafc' }}>
                Sync or Rebuild Timeline from SpliceWright Studio
              </h2>
            </div>

            <div
              style={{
                background: 'rgba(245, 158, 11, 0.12)',
                border: '1px solid rgba(245, 158, 11, 0.45)',
                borderRadius: '6px',
                padding: '10px 12px',
                fontSize: '12px',
                color: '#fde68a',
                marginBottom: '14px',
                lineHeight: 1.5,
              }}
            >
              <strong>Warning — May Adjust Previous Timeline Edits:</strong> Syncing or rebuilding
              from <code>ai-movie.json</code> will recalculate scene durations and ripple-shift
              scene clips, dialogue clips, and Scene Headings so scenes do not overlap.
            </div>

            {syncSummary && (
              <div
                style={{
                  background: '#090d16',
                  border: '1px solid #1e293b',
                  borderRadius: '6px',
                  padding: '10px 12px',
                  fontSize: '12px',
                  color: '#cbd5e1',
                  marginBottom: '14px',
                }}
              >
                <div style={{ fontWeight: 600, color: '#38bdf8', marginBottom: '4px' }}>
                  Detected Studio Updates since last save:
                </div>
                <ul style={{ margin: 0, paddingLeft: '18px', color: '#94a3b8' }}>
                  <li>New video / poster takes: <strong style={{ color: '#f8fafc' }}>{syncSummary.newTakesCount}</strong></li>
                  <li>New dialogue / voiceover clips: <strong style={{ color: '#f8fafc' }}>{syncSummary.newDialogueCount}</strong></li>
                  <li>Modified audio / image / video files in-place: <strong style={{ color: '#f8fafc' }}>{syncSummary.modifiedMediaCount || 0}</strong></li>
                  <li>Scene duration / slate updates: <strong style={{ color: '#f8fafc' }}>{syncSummary.durationChangesCount || 0}</strong></li>
                  <li>New scenes added: <strong style={{ color: '#f8fafc' }}>{syncSummary.newScenesCount}</strong></li>
                  {!!syncSummary.newTextOverlaysCount && (
                    <li>New scene text overlays: <strong style={{ color: '#f8fafc' }}>{syncSummary.newTextOverlaysCount}</strong></li>
                  )}
                </ul>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '12px' }}>
              <div
                style={{
                  background: '#131c2e',
                  border: '1px solid #10b981',
                  borderRadius: '6px',
                  padding: '12px',
                }}
              >
                <div style={{ fontWeight: 700, color: '#34d399', marginBottom: '4px' }}>
                  Option 1: Smart Sync &amp; Ripple Scenes (Recommended)
                </div>
                <p style={{ color: '#94a3b8', marginBottom: '10px', lineHeight: 1.45 }}>
                  Imports new audio/video/posters, updates scene durations (and creates Scene Slates
                  for scenes without graphics yet), and ripple-shifts subsequent scenes &amp; headings
                  while preserving your chosen takes, Ken Burns presets, and custom BGM/SFX tracks.
                </p>
                <button
                  onClick={() => handleSyncAiMovie('merge-new-assets')}
                  style={{
                    ...headerBtnStyle,
                    background: '#059669',
                    borderColor: '#10b981',
                    color: '#fff',
                    fontWeight: 600,
                  }}
                >
                  <RefreshCw size={13} />
                  <span>Smart Sync &amp; Ripple Timeline</span>
                </button>
              </div>

              <div
                style={{
                  background: '#131c2e',
                  border: '1px solid #38bdf8',
                  borderRadius: '6px',
                  padding: '12px',
                }}
              >
                <div style={{ fontWeight: 700, color: '#38bdf8', marginBottom: '4px' }}>
                  Option 2: Full Rebuild from Studio (Reset Scene Edits)
                </div>
                <p style={{ color: '#94a3b8', marginBottom: '10px', lineHeight: 1.45 }}>
                  Rebuilds all scene clips, dialogue placements, and Scene Headings cleanly from
                  scratch in <code>ai-movie.json</code> order. Custom imported Music &amp; SFX tracks
                  are preserved, but manual scene trims/splits are reset.
                </p>
                <button
                  onClick={() => handleSyncAiMovie('reset-to-ai-movie')}
                  style={{
                    ...headerBtnStyle,
                    background: '#0284c7',
                    borderColor: '#38bdf8',
                    color: '#fff',
                    fontWeight: 600,
                  }}
                >
                  <RefreshCw size={13} />
                  <span>Full Rebuild from Studio</span>
                </button>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '16px' }}>
              <button onClick={() => setShowSyncModal(false)} style={headerBtnStyle}>
                Cancel (Keep Current Edits)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Topic 11 Master Chapter / Reel Stitcher (for 20-min to 1-hour+ Movies) */}
      {showStitchModal && (
        <div style={modalBackdropStyle}>
          <div style={{ ...modalBoxStyle, width: '620px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
              <Film size={20} color="#c084fc" />
              <h2 style={{ fontSize: '16px', fontWeight: 700, color: '#f8fafc' }}>
                Master Chapter / Reel Stitcher (Long-Form 20–60+ Min Movies)
              </h2>
            </div>
            <p style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '12px', lineHeight: 1.45 }}>
              Build long-form movies by creating separate chapter/location projects and stitching
              their rendered <code>.mp4</code> cuts together here. Uses near-instant lossless FFmpeg
              stream copy (<code>-c copy</code>) when formats match and automatically time-shifts
              and merges companion <code>.srt</code> subtitle files.
            </p>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', flexWrap: 'wrap', gap: '6px' }}>
              <span style={{ fontSize: '12px', fontWeight: 600, color: '#cbd5e1' }}>
                Chapters in Sequence ({stitchItems.length} item{stitchItems.length === 1 ? '' : 's'} •{' '}
                Ready MP4 Total:{' '}
                {Math.round(
                  stitchItems.reduce((acc, i) => acc + (i.durationSeconds || 0), 0) +
                    Math.max(0, stitchItems.filter((i) => Boolean(i.filePath)).length - 1) *
                      stitchSpacerSeconds
                )}
                s)
              </span>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button
                  onClick={() => handleScanStitchCatalogue()}
                  title="Select a parent Production Folder to auto-discover all chapter folders and save/load movie-catalogue.json"
                  style={{
                    ...headerBtnStyle,
                    background: '#064e3b',
                    borderColor: '#10b981',
                    color: '#ecfdf5',
                  }}
                >
                  <FolderOpen size={13} />
                  <span>Scan Production Folder (Catalogue)</span>
                </button>
                {stitchCatalogueRoot && (
                  <button
                    onClick={handleSaveStitchCatalogue}
                    title={`Save chapter order & settings to ${stitchCatalogueRoot}\\movie-catalogue.json`}
                    style={headerBtnStyle}
                  >
                    <Save size={13} color="#34d399" />
                    <span>Save Catalogue</span>
                  </button>
                )}
                <button
                  onClick={handleAddChaptersToStitch}
                  style={{
                    ...headerBtnStyle,
                    background: '#581c87',
                    borderColor: '#a855f7',
                    color: '#f3e8ff',
                  }}
                >
                  <FolderOpen size={13} />
                  <span>+ Add MP4(s)</span>
                </button>
              </div>
            </div>

            {stitchCatalogueRoot && (
              <div
                style={{
                  fontSize: '11px',
                  color: '#34d399',
                  marginBottom: '6px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <span>Catalogue Folder: {stitchCatalogueRoot}\movie-catalogue.json</span>
                <button
                  onClick={() => handleScanStitchCatalogue(stitchCatalogueRoot)}
                  style={{ ...headerBtnStyle, padding: '2px 7px', fontSize: '10px' }}
                >
                  <RefreshCw size={11} />
                  <span>Refresh Status</span>
                </button>
              </div>
            )}

            <div
              style={{
                maxHeight: '220px',
                overflowY: 'auto',
                background: '#090d16',
                border: '1px solid #1e293b',
                borderRadius: '6px',
                padding: '8px',
                marginBottom: '12px',
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
              }}
            >
              {stitchItems.length === 0 ? (
                <div style={{ padding: '20px', textAlign: 'center', fontSize: '12px', color: '#64748b' }}>
                  Click &ldquo;Scan Production Folder (Catalogue)&rdquo; to auto-discover chapter sub-projects, or
                  click &ldquo;+ Add MP4(s)&rdquo; to pick rendered chapter videos.
                </div>
              ) : (
                stitchItems.map((item, idx) => (
                  <div
                    key={`${item.chapterFolderPath || item.filePath}_${idx}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '6px 10px',
                      background: '#131c2e',
                      border: '1px solid #22304d',
                      borderRadius: '5px',
                      fontSize: '12px',
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontWeight: 600, color: '#f8fafc', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span>
                          {idx + 1}. {item.label}
                        </span>
                        {item.durationSeconds > 0 && (
                          <span style={{ color: '#38bdf8', fontWeight: 400 }}>
                            ({item.durationSeconds.toFixed(1)}s)
                          </span>
                        )}
                        {item.status === 'ready' && (
                          <span
                            style={{
                              fontSize: '10px',
                              padding: '1px 5px',
                              borderRadius: '3px',
                              background: 'rgba(16, 185, 129, 0.2)',
                              color: '#34d399',
                            }}
                          >
                            🟢 Ready
                          </span>
                        )}
                        {item.status === 'outdated' && (
                          <span
                            title="Chapter timeline or ai-movie.json was edited after its last MP4 export"
                            style={{
                              fontSize: '10px',
                              padding: '1px 5px',
                              borderRadius: '3px',
                              background: 'rgba(245, 158, 11, 0.2)',
                              color: '#fbbf24',
                            }}
                          >
                            🟡 Outdated Render
                          </span>
                        )}
                        {item.status === 'unrendered' && (
                          <span
                            style={{
                              fontSize: '10px',
                              padding: '1px 5px',
                              borderRadius: '3px',
                              background: 'rgba(148, 163, 184, 0.2)',
                              color: '#cbd5e1',
                            }}
                          >
                            ⚪ Unrendered Draft
                          </span>
                        )}
                        {item.hasCompanionSrt && (
                          <span
                            style={{
                              fontSize: '10px',
                              padding: '1px 5px',
                              borderRadius: '3px',
                              background: 'rgba(56, 189, 248, 0.18)',
                              color: '#38bdf8',
                            }}
                          >
                            +.SRT
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: '10px', color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {item.filePath || item.chapterFolderPath}
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginLeft: '8px' }}>
                      {item.chapterFolderPath && (
                        <button
                          onClick={() => handleOpenChapterFromCatalogue(item.chapterFolderPath!)}
                          title="Open this chapter folder directly in the SpliceWright timeline editor"
                          style={{
                            ...headerBtnStyle,
                            padding: '3px 7px',
                            fontSize: '11px',
                            background: '#1e3a8a',
                            borderColor: '#3b82f6',
                            color: '#e0f2fe',
                          }}
                        >
                          Edit Chapter
                        </button>
                      )}
                      <button
                        onClick={() => handleMoveStitchItem(idx, -1)}
                        disabled={idx === 0}
                        title="Move Chapter Up"
                        style={{ ...headerBtnStyle, padding: '3px 6px', opacity: idx === 0 ? 0.4 : 1 }}
                      >
                        <ArrowUp size={12} />
                      </button>
                      <button
                        onClick={() => handleMoveStitchItem(idx, 1)}
                        disabled={idx === stitchItems.length - 1}
                        title="Move Chapter Down"
                        style={{
                          ...headerBtnStyle,
                          padding: '3px 6px',
                          opacity: idx === stitchItems.length - 1 ? 0.4 : 1,
                        }}
                      >
                        <ArrowDown size={12} />
                      </button>
                      <button
                        onClick={() => handleRemoveStitchItem(idx)}
                        title="Remove Chapter"
                        style={{ ...headerBtnStyle, padding: '3px 6px', color: '#f87171' }}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '12px' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span>Output Stitched Movie File (.mp4)</span>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <input
                    type="text"
                    value={stitchOutputPath}
                    onChange={(e) => setStitchOutputPath(e.target.value)}
                    placeholder="Select output .mp4 path..."
                    style={{ ...modalInputStyle, flex: 1 }}
                  />
                  <button
                    onClick={async () => {
                      const chosen = await window.spliceWright.selectOutputMp4Path(
                        'full-stitched-movie.mp4'
                      );
                      if (chosen) setStitchOutputPath(chosen);
                    }}
                    style={headerBtnStyle}
                  >
                    Browse...
                  </button>
                </div>
              </label>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', alignItems: 'center' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <span>Black Transition Spacer Between Chapters</span>
                  <select
                    value={stitchSpacerSeconds}
                    onChange={(e) => setStitchSpacerSeconds(parseFloat(e.target.value) || 0)}
                    style={modalInputStyle}
                  >
                    <option value={0}>0.0s — Instant Lossless Cut (-c copy)</option>
                    <option value={0.5}>0.5s — Brief Black Beat</option>
                    <option value={1.0}>1.0s — Standard Chapter Spacer</option>
                    <option value={2.0}>2.0s — Act / Location Pause</option>
                  </select>
                </label>

                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '16px' }}>
                  <input
                    type="checkbox"
                    checked={stitchMergeSubtitles}
                    onChange={(e) => setStitchMergeSubtitles(e.target.checked)}
                  />
                  <span>Auto-merge &amp; time-shift companion .SRT subtitles</span>
                </label>
              </div>
            </div>

            {exportProgress && (
              <div
                style={{
                  marginTop: '12px',
                  padding: '10px 12px',
                  background: '#090d16',
                  borderRadius: '6px',
                  border: '1px solid #1e293b',
                  fontSize: '12px',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <span>{exportProgress.message}</span>
                  <span style={{ fontWeight: 700, color: '#38bdf8' }}>{exportProgress.percent}%</span>
                </div>
                {exportProgress.outputPath && (
                  <div style={{ marginTop: '8px', display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                      onClick={() =>
                        window.spliceWright.openPathInExplorer(exportProgress.outputPath!)
                      }
                      style={{ ...headerBtnStyle, background: '#065f46', color: '#ecfdf5' }}
                    >
                      <ExternalLink size={13} />
                      <span>Show Stitched Movie in Explorer</span>
                    </button>
                  </div>
                )}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' }}>
              <button onClick={() => setShowStitchModal(false)} style={headerBtnStyle}>
                Close
              </button>
              <button
                onClick={handleRunStitchChapters}
                disabled={stitchItems.length === 0 || !stitchOutputPath || isStitching}
                style={{
                  ...headerBtnStyle,
                  background: '#7e22ce',
                  borderColor: '#a855f7',
                  color: '#fff',
                  fontWeight: 600,
                  opacity: stitchItems.length > 0 && stitchOutputPath && !isStitching ? 1 : 0.5,
                }}
              >
                <Download size={14} />
                <span>{isStitching ? 'Stitching...' : 'Stitch Chapters into Movie'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const headerBtnStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  background: '#161f33',
  color: '#e2e8f0',
  border: '1px solid #283552',
  borderRadius: '5px',
  padding: '5px 10px',
  fontSize: '12px',
  whiteSpace: 'nowrap',
  flexShrink: 0,
  boxSizing: 'border-box',
};

const dropdownItemBtnStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  width: '100%',
  background: 'transparent',
  border: '1px solid transparent',
  borderRadius: '6px',
  padding: '7px 10px',
  fontSize: '12px',
  cursor: 'pointer',
};

const welcomeCardStyle: React.CSSProperties = {
  background: '#151e32',
  border: '1px solid #263554',
  borderRadius: '8px',
  padding: '18px',
  display: 'flex',
  flexDirection: 'column',
};

const primaryActionBtnStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 12px',
  borderRadius: '6px',
  border: 'none',
  color: '#fff',
  fontWeight: 600,
  fontSize: '12px',
};

const modalBackdropStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(3, 6, 14, 0.78)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 100,
};

const modalBoxStyle: React.CSSProperties = {
  width: '520px',
  background: '#0f1626',
  border: '1px solid #283552',
  borderRadius: '10px',
  padding: '22px',
  boxShadow: '0 20px 50px rgba(0,0,0,0.75)',
};

const modalInputStyle: React.CSSProperties = {
  background: '#090d16',
  color: '#f1f5f9',
  border: '1px solid #283552',
  borderRadius: '5px',
  padding: '7px 10px',
  fontSize: '12px',
};
