import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  KEN_BURNS_PRESET_LABELS,
  KenBurnsPreset,
  ProjectMediaAsset,
  TimelineClip,
  VideoProjectManifest,
  VisualLookPreset,
} from '../../shared/types';
import { buildMediaUrl, formatTimecode } from '../bridge';

function computeVisualLookCssFilter(preset: VisualLookPreset | undefined): string {
  switch (preset) {
    case 'cinematic':
      return 'contrast(1.08) saturate(1.12)';
    case 'monochrome':
      return 'grayscale(1) contrast(1.18) brightness(0.98)';
    case 'vintage-film':
    case 'vintage-film-crackle':
      return 'sepia(0.55) contrast(1.12) saturate(0.75) brightness(0.97)';
    case 'muted':
      return 'saturate(0.58) contrast(1.06)';
    case 'none':
    default:
      return 'none';
  }
}

function computeKenBurnsTransform(preset: KenBurnsPreset | undefined, progress: number): string {
  const p = Math.max(0, Math.min(1, progress));
  switch (preset) {
    case 'zoom-in': {
      const s = 1 + 0.18 * p;
      return `scale(${s.toFixed(4)})`;
    }
    case 'zoom-out': {
      const s = 1.18 - 0.18 * p;
      return `scale(${s.toFixed(4)})`;
    }
    case 'pan-top-to-bottom': {
      const ty = 9.5 - 19.0 * p;
      return `scale(1.24) translate(0%, ${ty.toFixed(3)}%)`;
    }
    case 'pan-bottom-to-top': {
      const ty = -9.5 + 19.0 * p;
      return `scale(1.24) translate(0%, ${ty.toFixed(3)}%)`;
    }
    case 'pan-left-to-right': {
      const tx = 9.0 - 18.0 * p;
      return `scale(1.22) translate(${tx.toFixed(3)}%, 0%)`;
    }
    case 'pan-right-to-left': {
      const tx = -9.0 + 18.0 * p;
      return `scale(1.22) translate(${tx.toFixed(3)}%, 0%)`;
    }
    case 'zoom-in-top-left': {
      const s = 1 + 0.24 * p;
      const t = 6.5 * p;
      return `scale(${s.toFixed(4)}) translate(${t.toFixed(3)}%, ${t.toFixed(3)}%)`;
    }
    case 'zoom-in-top-right': {
      const s = 1 + 0.24 * p;
      const tx = -6.5 * p;
      const ty = 6.5 * p;
      return `scale(${s.toFixed(4)}) translate(${tx.toFixed(3)}%, ${ty.toFixed(3)}%)`;
    }
    case 'zoom-in-bottom': {
      const s = 1 + 0.24 * p;
      const ty = -6.5 * p;
      return `scale(${s.toFixed(4)}) translate(0%, ${ty.toFixed(3)}%)`;
    }
    case 'none':
    default:
      return 'none';
  }
}
import {
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Volume2,
  Film,
  Subtitles,
  Maximize2,
  Minimize2,
} from 'lucide-react';

interface PreviewPlayerProps {
  projectRoot: string;
  project: VideoProjectManifest;
  playhead: number;
  isPlaying: boolean;
  recommendedPoolSize: number;
  muteAllAudio?: boolean;
  onPlayheadChange: (newTime: number) => void;
  onTogglePlay: () => void;
}

const SCRUB_DRIFT_TOLERANCE_SECONDS = 0.06;
const PLAYING_DRIFT_TOLERANCE_SECONDS = 0.42;
const AUDIO_LOOKAHEAD_SECONDS = 10.0;
const AUDIO_LOOKBEHIND_SECONDS = 2.0;

function computeRendererAudioSignature(project: VideoProjectManifest): string {
  const parts: string[] = [
    `duck:${project.autoDuckMusicUnderDialogue ? project.duckingVolumeRatio : 0}`,
    `norm:${project.normalizeDialogueAudio !== false ? 1 : 0}`,
  ];
  const assetMap = new Map<string, ProjectMediaAsset>(project.assets.map((a) => [a.id, a]));
  for (const track of project.timeline.tracks) {
    if (track.type === 'video') continue;
    parts.push(`tr:${track.id}:${track.muted ? 'M' : track.volume}`);
    for (const c of track.clips) {
      const asset = assetMap.get(c.assetId);
      parts.push(
        `c:${c.id}:${asset?.relativePath || c.assetId}:${c.timelineStart}:${c.sourceIn}:${
          c.sourceOut
        }:${c.volume}:${c.fadeIn || 0}:${c.fadeOut || 0}`
      );
    }
  }
  return parts.join('|');
}

export const PreviewPlayer: React.FC<PreviewPlayerProps> = ({
  projectRoot,
  project,
  playhead,
  isPlaying,
  muteAllAudio,
  onPlayheadChange,
  onTogglePlay,
}) => {
  const playerContainerRef = useRef<HTMLDivElement | null>(null);
  const videoARef = useRef<HTMLVideoElement | null>(null);
  const videoBRef = useRef<HTMLVideoElement | null>(null);
  const activeDeckRef = useRef<'A' | 'B'>('A');
  const [activeDeck, setActiveDeck] = useState<'A' | 'B'>('A');
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  const audioRefs = useRef<Map<string, HTMLAudioElement>>(new Map());
  const preMixAudioRef = useRef<HTMLAudioElement | null>(null);
  const seekInFlightRef = useRef<boolean>(false);
  const lastActiveClipIdRef = useRef<string | null>(null);
  const wasPlayingRef = useRef<boolean>(false);

  const isPreMixValid = useMemo(() => {
    if (!project.preMixedAudioRelativePath || !project.preMixedAudioSignature) return false;
    return computeRendererAudioSignature(project) === project.preMixedAudioSignature;
  }, [project]);

  const toggleFullscreen = useCallback(() => {
    const el = playerContainerRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      el.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }, []);

  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement as HTMLElement | null;
      if (
        activeEl &&
        (['INPUT', 'SELECT', 'TEXTAREA'].includes(activeEl.tagName) || activeEl.isContentEditable)
      ) {
        return;
      }
      if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        toggleFullscreen();
      }
    };
    document.addEventListener('fullscreenchange', onFsChange);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [toggleFullscreen]);

  const assetMap = useMemo(
    () => new Map<string, ProjectMediaAsset>(project.assets.map((a) => [a.id, a])),
    [project.assets]
  );

  const videoTrack = useMemo(
    () => project.timeline.tracks.find((t) => t.type === 'video'),
    [project.timeline.tracks]
  );

  const sortedVideoClips = useMemo(() => {
    if (!videoTrack || videoTrack.muted) return [];
    return [...videoTrack.clips].sort((a, b) => a.timelineStart - b.timelineStart);
  }, [videoTrack]);

  // Active video clip at current playhead + next upcoming video clip for lookahead preloading
  const { activeVideoClip, nextVideoClip } = useMemo(() => {
    let active: TimelineClip | null = null;
    let next: TimelineClip | null = null;

    for (const clip of sortedVideoClips) {
      const dur = Math.max(0.1, clip.sourceOut - clip.sourceIn);
      const end = clip.timelineStart + dur;
      if (playhead >= clip.timelineStart && playhead < end) {
        active = clip;
      } else if (clip.timelineStart > playhead && !next) {
        next = clip;
      }
    }
    return { activeVideoClip: active, nextVideoClip: next };
  }, [sortedVideoClips, playhead]);

  const activeVideoAsset = activeVideoClip ? assetMap.get(activeVideoClip.assetId) || null : null;
  const nextVideoAsset = nextVideoClip ? assetMap.get(nextVideoClip.assetId) || null : null;

  const activeClipProgress = useMemo(() => {
    if (!activeVideoClip) return 0;
    const dur = Math.max(0.1, activeVideoClip.sourceOut - activeVideoClip.sourceIn);
    return Math.max(0, Math.min(1, (playhead - activeVideoClip.timelineStart) / dur));
  }, [activeVideoClip, playhead]);

  const activeKenBurnsTransform = useMemo(
    () => computeKenBurnsTransform(activeVideoClip?.kenBurns, activeClipProgress),
    [activeVideoClip?.kenBurns, activeClipProgress]
  );

  // Active dialogue line for live subtitle caption preview
  const activeDialogueClip = useMemo(() => {
    const dlgTrack = project.timeline.tracks.find((t) => t.type === 'dialogue');
    if (!dlgTrack || dlgTrack.muted) return null;
    for (const clip of dlgTrack.clips) {
      const dur = Math.max(0.1, clip.sourceOut - clip.sourceIn);
      if (playhead >= clip.timelineStart && playhead <= clip.timelineStart + dur) {
        return clip;
      }
    }
    return null;
  }, [project.timeline.tracks, playhead]);

  const activeDialogueAsset = activeDialogueClip
    ? assetMap.get(activeDialogueClip.assetId) || null
    : null;

  // Collect all audio clips across Dialogue, SFX, and Music tracks
  const allAudioClips = useMemo(() => {
    const list: Array<{
      clip: TimelineClip;
      asset: ProjectMediaAsset;
      trackVolume: number;
      trackType: string;
      muted: boolean;
    }> = [];
    for (const track of project.timeline.tracks) {
      if (track.type === 'video') continue;
      for (const clip of track.clips) {
        const asset = assetMap.get(clip.assetId);
        if (asset) {
          list.push({
            clip,
            asset,
            trackVolume: track.volume,
            trackType: track.type,
            muted: track.muted,
          });
        }
      }
    }
    return list;
  }, [project.timeline.tracks, assetMap]);

  // Sync Primary & Standby Video Decks (True A/B Double-Buffering + Relaxed Playing Drift)
  useEffect(() => {
    const vidA = videoARef.current;
    const vidB = videoBRef.current;
    if (!vidA || !vidB) return;

    if (!activeVideoClip || !activeVideoAsset || activeVideoAsset.kind === 'image') {
      if (!vidA.paused) vidA.pause();
      if (!vidB.paused) vidB.pause();
      lastActiveClipIdRef.current = activeVideoClip?.id || null;
      wasPlayingRef.current = isPlaying;
      return;
    }

    const expectedSrc = buildMediaUrl(projectRoot, activeVideoAsset.relativePath);
    const clipChanged = lastActiveClipIdRef.current !== activeVideoClip.id;
    const playStateChanged = wasPlayingRef.current !== isPlaying;

    let currentEl = activeDeckRef.current === 'A' ? vidA : vidB;
    let standbyEl = activeDeckRef.current === 'A' ? vidB : vidA;

    // If clip changed and the standby deck already preloaded `expectedSrc`, swap active deck immediately!
    if (
      clipChanged &&
      currentEl.getAttribute('data-media-src') !== expectedSrc &&
      standbyEl.getAttribute('data-media-src') === expectedSrc
    ) {
      if (!currentEl.paused) currentEl.pause();
      const nextDeck = activeDeckRef.current === 'A' ? 'B' : 'A';
      activeDeckRef.current = nextDeck;
      setActiveDeck(nextDeck);
      currentEl = standbyEl;
      standbyEl = nextDeck === 'A' ? vidB : vidA;
      seekInFlightRef.current = false;
    }

    if (currentEl.getAttribute('data-media-src') !== expectedSrc) {
      currentEl.setAttribute('data-media-src', expectedSrc);
      currentEl.src = expectedSrc;
      currentEl.load();
      seekInFlightRef.current = false;
    }

    const targetClipTime =
      activeVideoClip.sourceIn + Math.max(0, playhead - activeVideoClip.timelineStart);
    const drift = Math.abs(currentEl.currentTime - targetClipTime);

    // Only force hardware keyframe seek if scrubbing, starting playback, switching clips, or if drift > 0.42s
    const tolerance =
      !isPlaying || clipChanged || playStateChanged
        ? SCRUB_DRIFT_TOLERANCE_SECONDS
        : PLAYING_DRIFT_TOLERANCE_SECONDS;

    if (drift > tolerance && !seekInFlightRef.current) {
      seekInFlightRef.current = true;
      try {
        currentEl.currentTime = targetClipTime;
      } catch {
        seekInFlightRef.current = false;
      }
    }

    if (isPlaying && currentEl.paused) {
      currentEl.play().catch(() => {});
    } else if (!isPlaying && !currentEl.paused) {
      currentEl.pause();
    }

    if (!standbyEl.paused) {
      standbyEl.pause();
    }

    lastActiveClipIdRef.current = activeVideoClip.id;
    wasPlayingRef.current = isPlaying;
  }, [projectRoot, activeVideoClip, activeVideoAsset, playhead, isPlaying]);

  // Preload upcoming clip into the standby video deck and pre-seek to its `sourceIn`
  useEffect(() => {
    const vidA = videoARef.current;
    const vidB = videoBRef.current;
    if (!vidA || !vidB || !nextVideoClip || !nextVideoAsset || nextVideoAsset.kind === 'image') {
      return;
    }
    const standbyEl = activeDeck === 'A' ? vidB : vidA;
    const nextSrc = buildMediaUrl(projectRoot, nextVideoAsset.relativePath);
    const targetStart = nextVideoClip.sourceIn || 0;

    if (standbyEl.getAttribute('data-media-src') !== nextSrc) {
      standbyEl.setAttribute('data-media-src', nextSrc);
      standbyEl.src = nextSrc;
      standbyEl.preload = 'auto';
      const onLoadedMeta = () => {
        try {
          if (Math.abs(standbyEl.currentTime - targetStart) > 0.05) {
            standbyEl.currentTime = targetStart;
          }
        } catch {}
        standbyEl.removeEventListener('loadedmetadata', onLoadedMeta);
      };
      standbyEl.addEventListener('loadedmetadata', onLoadedMeta);
      standbyEl.load();
    }
  }, [projectRoot, nextVideoClip, nextVideoAsset, activeDeck]);

  // Sync Audio Elements using either the Invisible Pre-Mixed MP3 Master (Topic 6)
  // OR the rolling lookahead window (supports 1–10+ minute timelines cleanly)
  useEffect(() => {
    if (muteAllAudio) {
      for (const el of audioRefs.current.values()) {
        if (!el.paused) el.pause();
      }
      if (preMixAudioRef.current && !preMixAudioRef.current.paused) {
        preMixAudioRef.current.pause();
      }
      return;
    }

    // Mode A: Invisible Pre-Mixed Master MP3 is valid -> play single `<audio>` stream!
    if (isPreMixValid && project.preMixedAudioRelativePath) {
      for (const el of audioRefs.current.values()) {
        if (!el.paused) el.pause();
      }
      audioRefs.current.clear();

      const mixSrc = `${buildMediaUrl(projectRoot, project.preMixedAudioRelativePath)}&v=${encodeURIComponent(
        project.updatedAt || ''
      )}`;
      let masterEl = preMixAudioRef.current;
      if (!masterEl) {
        masterEl = new Audio(mixSrc);
        masterEl.preload = 'auto';
        masterEl.setAttribute('data-media-src', mixSrc);
        preMixAudioRef.current = masterEl;
      } else if (masterEl.getAttribute('data-media-src') !== mixSrc) {
        masterEl.setAttribute('data-media-src', mixSrc);
        masterEl.src = mixSrc;
      }

      if (!isPlaying) {
        if (!masterEl.paused) masterEl.pause();
        if (Math.abs(masterEl.currentTime - playhead) > 0.08) {
          try {
            masterEl.currentTime = playhead;
          } catch {}
        }
        return;
      }

      const tolerance = masterEl.paused
        ? SCRUB_DRIFT_TOLERANCE_SECONDS
        : PLAYING_DRIFT_TOLERANCE_SECONDS;
      if (Math.abs(masterEl.currentTime - playhead) > tolerance) {
        try {
          masterEl.currentTime = playhead;
        } catch {}
      }
      if (masterEl.paused) {
        masterEl.play().catch(() => {});
      }
      return;
    }

    // Mode B: Live per-clip audio window -> ensure preMixAudioRef is paused
    if (preMixAudioRef.current && !preMixAudioRef.current.paused) {
      preMixAudioRef.current.pause();
    }

    const isDialogueSpeaking = Boolean(activeDialogueClip);
    const activeWindowClipIds = new Set<string>();

    for (const item of allAudioClips) {
      const { clip, asset, trackVolume, trackType, muted } = item;
      const dur = Math.max(0.1, clip.sourceOut - clip.sourceIn);
      const clipEnd = clip.timelineStart + dur;

      // Windowed audio pool: only keep HTMLAudioElement instances within [playhead - 2s, playhead + 10s]
      const inWindow =
        clipEnd >= playhead - AUDIO_LOOKBEHIND_SECONDS &&
        clip.timelineStart <= playhead + AUDIO_LOOKAHEAD_SECONDS;

      if (!inWindow) {
        const existingEl = audioRefs.current.get(clip.id);
        if (existingEl) {
          existingEl.pause();
          audioRefs.current.delete(clip.id);
        }
        continue;
      }

      activeWindowClipIds.add(clip.id);
      let audioEl = audioRefs.current.get(clip.id);
      const src = buildMediaUrl(projectRoot, asset.relativePath);

      if (!audioEl) {
        audioEl = new Audio(src);
        audioEl.preload = 'auto';
        audioEl.setAttribute('data-media-src', src);
        audioRefs.current.set(clip.id, audioEl);
      } else if (audioEl.getAttribute('data-media-src') !== src) {
        audioEl.setAttribute('data-media-src', src);
        audioEl.src = src;
      }

      const inRange = playhead >= clip.timelineStart && playhead < clipEnd;

      if (!inRange || muted || !isPlaying) {
        if (!audioEl.paused) {
          audioEl.pause();
        }
        if (inRange && !isPlaying) {
          const targetTime = clip.sourceIn + (playhead - clip.timelineStart);
          if (Math.abs(audioEl.currentTime - targetTime) > 0.08) {
            try {
              audioEl.currentTime = targetTime;
            } catch {}
          }
        }
        continue;
      }

      // Compute effective gain including auto-ducking & fade envelopes
      const localElapsed = playhead - clip.timelineStart;
      let gain = Math.max(0, Math.min(1, trackVolume * (clip.volume ?? 1.0)));

      if (
        trackType === 'music' &&
        project.autoDuckMusicUnderDialogue &&
        isDialogueSpeaking
      ) {
        gain *= project.duckingVolumeRatio || 0.25;
      }

      if (clip.fadeIn && clip.fadeIn > 0 && localElapsed < clip.fadeIn) {
        gain *= Math.max(0, localElapsed / clip.fadeIn);
      }
      if (clip.fadeOut && clip.fadeOut > 0 && dur - localElapsed < clip.fadeOut) {
        gain *= Math.max(0, (dur - localElapsed) / clip.fadeOut);
      }

      audioEl.volume = Math.max(0, Math.min(1, gain));

      const targetAudioTime = clip.sourceIn + localElapsed;
      const audioTolerance = audioEl.paused
        ? SCRUB_DRIFT_TOLERANCE_SECONDS
        : PLAYING_DRIFT_TOLERANCE_SECONDS;
      if (Math.abs(audioEl.currentTime - targetAudioTime) > audioTolerance) {
        try {
          audioEl.currentTime = targetAudioTime;
        } catch {}
      }

      if (audioEl.paused) {
        audioEl.play().catch(() => {});
      }
    }

    // Pause and release any clips outside the active window or removed from timeline
    for (const [id, el] of audioRefs.current.entries()) {
      if (!activeWindowClipIds.has(id)) {
        el.pause();
        audioRefs.current.delete(id);
      }
    }
  }, [
    allAudioClips,
    playhead,
    isPlaying,
    activeDialogueClip,
    projectRoot,
    project.autoDuckMusicUnderDialogue,
    project.duckingVolumeRatio,
    project.preMixedAudioRelativePath,
    project.updatedAt,
    isPreMixValid,
    muteAllAudio,
  ]);

  // Cleanup audio elements on unmount
  useEffect(() => {
    return () => {
      for (const el of audioRefs.current.values()) {
        el.pause();
      }
      audioRefs.current.clear();
      if (preMixAudioRef.current) {
        preMixAudioRef.current.pause();
      }
    };
  }, []);

  const totalDuration = useMemo(() => {
    let max = 10;
    for (const track of project.timeline.tracks) {
      for (const clip of track.clips) {
        const end = clip.timelineStart + Math.max(0.1, clip.sourceOut - clip.sourceIn);
        if (end > max) max = end;
      }
    }
    return Math.round(max * 100) / 100;
  }, [project.timeline.tracks]);

  const aspectStyle: React.CSSProperties = useMemo(() => {
    const ratio = project.format.width / Math.max(1, project.format.height);
    if (ratio < 1) {
      // Vertical 9:16
      return { height: '100%', aspectRatio: `${project.format.width} / ${project.format.height}` };
    }
    return {
      width: '100%',
      maxHeight: '100%',
      aspectRatio: `${project.format.width} / ${project.format.height}`,
    };
  }, [project.format]);

  return (
    <div
      ref={playerContainerRef}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        background: '#060911',
        borderRight: isFullscreen ? 'none' : '1px solid #1e293b',
      }}
    >
      {/* Top Viewport Header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '8px 14px',
          borderBottom: '1px solid #1e293b',
          background: '#0c1220',
          fontSize: '12px',
          color: '#94a3b8',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Film size={14} color="#f59e0b" />
          <span style={{ fontWeight: 600, color: '#e2e8f0' }}>Program Monitor</span>
          <span
            style={{
              padding: '2px 6px',
              background: '#1e293b',
              borderRadius: '4px',
              color: '#38bdf8',
              fontSize: '11px',
            }}
          >
            {project.format.aspectRatio} ({project.format.width}×{project.format.height} @{' '}
            {project.format.fps}fps)
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {activeVideoClip ? (
            <span style={{ color: '#fbbf24' }}>{activeVideoClip.label}</span>
          ) : (
            <span>No clip at playhead</span>
          )}
          <button
            onClick={toggleFullscreen}
            title={isFullscreen ? 'Exit Full Screen (F / Esc)' : 'Full Screen Preview (F)'}
            style={{
              ...transportBtnStyle,
              padding: '3px 8px',
              fontSize: '11px',
              gap: '4px',
            }}
          >
            {isFullscreen ? <Minimize2 size={13} color="#38bdf8" /> : <Maximize2 size={13} color="#38bdf8" />}
            <span>{isFullscreen ? 'Exit Full Screen' : 'Full Screen'}</span>
          </button>
        </div>
      </div>

      {/* Main Video / Poster Stage */}
      <div
        onDoubleClick={toggleFullscreen}
        title="Double-click or press F to toggle Full Screen"
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: isFullscreen ? '24px' : '14px',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            ...aspectStyle,
            background: '#000',
            borderRadius: '6px',
            border: '1px solid #263248',
            position: 'relative',
            overflow: 'hidden',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 10px 30px rgba(0,0,0,0.65)',
            filter: computeVisualLookCssFilter(project.lookPreset),
          }}
        >
          {/* Video Deck A */}
          <video
            ref={videoARef}
            muted
            playsInline
            onSeeked={() => {
              if (activeDeckRef.current === 'A') {
                seekInFlightRef.current = false;
              }
            }}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              transform: activeKenBurnsTransform,
              transformOrigin: 'center center',
              willChange: 'transform',
              display:
                activeVideoAsset && activeVideoAsset.kind === 'video' && activeDeck === 'A'
                  ? 'block'
                  : 'none',
            }}
          />

          {/* Video Deck B (Swaps seamlessly with Deck A on cuts) */}
          <video
            ref={videoBRef}
            muted
            playsInline
            onSeeked={() => {
              if (activeDeckRef.current === 'B') {
                seekInFlightRef.current = false;
              }
            }}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              transform: activeKenBurnsTransform,
              transformOrigin: 'center center',
              willChange: 'transform',
              display:
                activeVideoAsset && activeVideoAsset.kind === 'video' && activeDeck === 'B'
                  ? 'block'
                  : 'none',
            }}
          />

          {/* Poster / First-Frame Fallback when Scene has an image or First-Frame only */}
          {activeVideoAsset && activeVideoAsset.kind === 'image' && (
            <div style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
              {activeVideoAsset.isPlaceholderSlate ? (
                <div
                  style={{
                    width: '100%',
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '24px',
                    textAlign: 'center',
                    background: 'radial-gradient(circle, #131c31 0%, #070b14 100%)',
                    color: '#cbd5e1',
                  }}
                >
                  <Film size={34} color="#f59e0b" style={{ marginBottom: '10px', opacity: 0.85 }} />
                  <div style={{ fontSize: '15px', fontWeight: 700, color: '#f8fafc', marginBottom: '6px' }}>
                    {activeVideoClip?.label || activeVideoAsset.label}
                  </div>
                  <div style={{ fontSize: '12px', color: '#94a3b8', maxWidth: '75%' }}>
                    {activeVideoAsset.dialogueText || 'Scene Slate — Add a first-frame graphic or video in Studio, or drop an image onto this scene.'}
                  </div>
                </div>
              ) : (
                <img
                  src={buildMediaUrl(projectRoot, activeVideoAsset.relativePath)}
                  alt={activeVideoAsset.label}
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'contain',
                    transform: activeKenBurnsTransform,
                    transformOrigin: 'center center',
                    willChange: 'transform',
                  }}
                />
              )}
              {activeVideoAsset.isPosterFallback && !activeVideoAsset.isPlaceholderSlate && (
                <div
                  style={{
                    position: 'absolute',
                    top: '10px',
                    right: '10px',
                    background: 'rgba(15, 23, 42, 0.85)',
                    border: '1px solid #f59e0b',
                    color: '#fbbf24',
                    fontSize: '11px',
                    padding: '4px 8px',
                    borderRadius: '4px',
                  }}
                >
                  First-Frame Poster Hold (Awaiting Scene Video)
                </div>
              )}
              {activeVideoClip?.kenBurns && activeVideoClip.kenBurns !== 'none' && (
                <div
                  style={{
                    position: 'absolute',
                    top: '10px',
                    left: '10px',
                    background: 'rgba(12, 74, 110, 0.85)',
                    border: '1px solid #38bdf8',
                    color: '#e0f2fe',
                    fontSize: '11px',
                    padding: '3px 8px',
                    borderRadius: '4px',
                  }}
                >
                  Motion: {KEN_BURNS_PRESET_LABELS[activeVideoClip.kenBurns]}
                </div>
              )}
            </div>
          )}

          {/* Empty state when playhead is on a blank segment */}
          {!activeVideoAsset && (
            <div style={{ textAlign: 'center', color: '#475569', fontSize: '13px' }}>
              <Film size={32} style={{ marginBottom: '6px', opacity: 0.5 }} />
              <div>Black Frame / Empty Timeline Gap</div>
            </div>
          )}

          {/* Topic 12: Lens Vignette & Vintage Film Grain Overlay */}
          {(project.lookPreset === 'monochrome' ||
            project.lookPreset === 'vintage-film' ||
            project.lookPreset === 'vintage-film-crackle') && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                pointerEvents: 'none',
                background:
                  'radial-gradient(circle, transparent 58%, rgba(0, 0, 0, 0.55) 100%)',
                boxShadow: 'inset 0 0 40px rgba(0,0,0,0.6)',
              }}
            />
          )}

          {/* Live Dialogue Subtitle Overlay (only shown when actual dialogue text exists, not raw .mp3 filenames) */}
          {activeDialogueClip && activeDialogueAsset?.dialogueText && (
            <div
              style={{
                position: 'absolute',
                bottom: '18px',
                left: '8%',
                right: '8%',
                textAlign: 'center',
                pointerEvents: 'none',
              }}
            >
              <span
                style={{
                  display: 'inline-block',
                  background: 'rgba(6, 9, 17, 0.82)',
                  border: '1px solid rgba(56, 189, 248, 0.35)',
                  color: '#f8fafc',
                  padding: '6px 14px',
                  borderRadius: '6px',
                  fontSize: isFullscreen ? '18px' : '14px',
                  fontWeight: 500,
                  boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                }}
              >
                {activeDialogueAsset?.speaker && (
                  <strong style={{ color: '#38bdf8', marginRight: '6px' }}>
                    {activeDialogueAsset.speaker}:
                  </strong>
                )}
                {activeDialogueAsset.dialogueText}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Transport Controls Bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 16px',
          background: '#0c1220',
          borderTop: '1px solid #1e293b',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            onClick={() => onPlayheadChange(0)}
            title="Jump to Start (Home)"
            style={transportBtnStyle}
          >
            <SkipBack size={15} />
          </button>
          <button
            onClick={onTogglePlay}
            title="Play / Pause (Space)"
            style={{
              ...transportBtnStyle,
              background: isPlaying ? '#f59e0b' : '#2563eb',
              color: '#fff',
              padding: '6px 14px',
              fontWeight: 600,
            }}
          >
            {isPlaying ? <Pause size={15} /> : <Play size={15} />}
            <span style={{ marginLeft: '6px', fontSize: '12px' }}>
              {isPlaying ? 'Pause' : 'Play'}
            </span>
          </button>
          <button
            onClick={() => onPlayheadChange(totalDuration)}
            title="Jump to End"
            style={transportBtnStyle}
          >
            <SkipForward size={15} />
          </button>
        </div>

        {/* Master Clock Timecode Readout */}
        <div
          style={{
            fontFamily: 'Consolas, monospace',
            fontSize: '14px',
            background: '#060911',
            padding: '4px 12px',
            borderRadius: '4px',
            border: '1px solid #1e293b',
            color: '#38bdf8',
          }}
        >
          {formatTimecode(playhead)}{' '}
          <span style={{ color: '#64748b' }}>/ {formatTimecode(totalDuration)}</span>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            fontSize: '11px',
            color: '#94a3b8',
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Volume2 size={14} color="#10b981" />
            {isPreMixValid
              ? 'Master MP3 Pre-Mix: ACTIVE'
              : project.autoDuckMusicUnderDialogue
              ? 'Auto-Duck BGM: ON'
              : 'Auto-Duck: OFF'}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Subtitles size={14} color="#38bdf8" />
            Live Captions
          </span>
          <button
            onClick={toggleFullscreen}
            title={isFullscreen ? 'Exit Full Screen (F / Esc)' : 'Full Screen (F)'}
            style={{
              ...transportBtnStyle,
              padding: '5px 8px',
            }}
          >
            {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </div>
      </div>
    </div>
  );
};

const transportBtnStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: '#161f33',
  color: '#e2e8f0',
  border: '1px solid #283552',
  borderRadius: '5px',
  padding: '6px 10px',
};
