import React, { useMemo, useRef, useState } from 'react';
import {
  ProjectMediaAsset,
  TimelineClip,
  TimelineMarker,
  TimelineTrack,
  TrackType,
  VideoProjectManifest,
} from '../../shared/types';
import { formatTimecode } from '../bridge';
import {
  Scissors,
  Trash2,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
  Flag,
  Sparkles,
  Camera,
  Layers,
  Undo2,
  Redo2,
  ChevronDown,
  ChevronUp,
  X,
} from 'lucide-react';

interface TimelineEditorProps {
  project: VideoProjectManifest;
  playhead: number;
  selectedClipId: string | null;
  isNormalizing?: boolean;
  isPreMixingAudio?: boolean;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  onPlayheadChange: (newTime: number) => void;
  onSelectClip: (clipId: string | null) => void;
  onUpdateProject: (
    updater: (prev: VideoProjectManifest) => VideoProjectManifest,
    options?: { recordUndo?: boolean }
  ) => void;
  onCommitUndoSnapshot?: (snapshot: VideoProjectManifest) => void;
  onNormalizeDialogue?: (includeSfxAndMusic?: boolean) => void;
  onPreMixAudio?: () => void;
}

/**
 * Packs overlapping clips on a single track into non-overlapping horizontal sub-lanes (0, 1, 2...).
 */
function packClipsIntoSubLanes(clips: TimelineClip[]): {
  laneByClipId: Map<string, number>;
  laneCount: number;
} {
  const sorted = [...clips].sort((a, b) => {
    if (Math.abs(a.timelineStart - b.timelineStart) > 0.001) {
      return a.timelineStart - b.timelineStart;
    }
    const durA = a.sourceOut - a.sourceIn;
    const durB = b.sourceOut - b.sourceIn;
    return durB - durA;
  });

  const laneEndTimes: number[] = [];
  const laneByClipId = new Map<string, number>();

  for (const clip of sorted) {
    const dur = Math.max(0.15, clip.sourceOut - clip.sourceIn);
    const start = clip.timelineStart;
    const end = start + dur;

    let assignedLane = -1;
    for (let i = 0; i < laneEndTimes.length; i++) {
      if (laneEndTimes[i] <= start + 0.02) {
        assignedLane = i;
        laneEndTimes[i] = end;
        break;
      }
    }

    if (assignedLane === -1) {
      assignedLane = laneEndTimes.length;
      laneEndTimes.push(end);
    }

    laneByClipId.set(clip.id, assignedLane);
  }

  return {
    laneByClipId,
    laneCount: Math.max(1, laneEndTimes.length),
  };
}

/**
 * Deletes a clip from `VideoProjectManifest`, cleans up any orphaned scene markers/sequence entries
 * if a scene clip was deleted, records dismissed scene IDs so Sync Studio doesn't resurrect blank slates,
 * optionally ripples subsequent scenes left, and re-indexes `sceneOrder` (1..N).
 */
export function deleteClipFromManifest(
  prev: VideoProjectManifest,
  clipId: string,
  rippleMode: boolean
): VideoProjectManifest {
  const next: VideoProjectManifest = JSON.parse(JSON.stringify(prev));
  let deletedClip: TimelineClip | null = null;
  let deletedTrackType: TrackType | null = null;

  for (const track of next.timeline.tracks) {
    const found = track.clips.find((c) => c.id === clipId);
    if (found) {
      deletedClip = found;
      deletedTrackType = track.type;
      track.clips = track.clips.filter((c) => c.id !== clipId);
      break;
    }
  }

  if (!deletedClip) return prev;

  const clipDur = Math.max(0.1, deletedClip.sourceOut - deletedClip.sourceIn);
  const clipStart = deletedClip.timelineStart;
  const dismissedSet = new Set<string>(next.dismissedSceneIds || []);

  // If the primary scene video/slate clip was deleted, check if any video clip remains for that sceneId
  if (deletedTrackType === 'video' && deletedClip.sceneId) {
    const scId = deletedClip.sceneId;
    const videoTrack = next.timeline.tracks.find((t) => t.type === 'video');
    const stillHasVideoClip = videoTrack?.clips.some((c) => c.sceneId === scId) ?? false;

    if (!stillHasVideoClip) {
      // Also remove scene markers and sequence entry for this deleted scene
      next.timeline.markers = next.timeline.markers.filter((m) => m.sceneId !== scId);
      next.sequence = next.sequence.filter((s) => s.id !== scId);
      dismissedSet.add(scId);

      // If Ripple Mode is active, shift subsequent scenes, clips, and markers left to close the gap
      if (rippleMode) {
        const threshold = clipStart + 0.05;
        for (const tr of next.timeline.tracks) {
          if (tr.type === 'music') continue;
          for (const c of tr.clips) {
            if (c.timelineStart >= threshold) {
              c.timelineStart = Math.max(0, Math.round((c.timelineStart - clipDur) * 20) / 20);
            }
          }
        }
        for (const m of next.timeline.markers) {
          if (m.time >= threshold) {
            m.time = Math.max(0, Math.round((m.time - clipDur) * 20) / 20);
          }
        }
      }
    }
  }

  // Prune any orphaned scene markers whose sceneId has zero clips across all tracks
  const scenesWithClips = new Set<string>();
  for (const tr of next.timeline.tracks) {
    for (const c of tr.clips) {
      if (c.sceneId) scenesWithClips.add(c.sceneId);
    }
  }
  next.timeline.markers = next.timeline.markers.filter((m) => {
    if (m.sceneId && !scenesWithClips.has(m.sceneId)) {
      dismissedSet.add(m.sceneId);
      return false;
    }
    return true;
  });
  next.sequence = next.sequence.filter((s) => scenesWithClips.has(s.id));
  next.dismissedSceneIds = Array.from(dismissedSet);

  // Re-index `sceneOrder` (1..N) across remaining video scene clips, markers, and sequence
  const vidTrack = next.timeline.tracks.find((t) => t.type === 'video');
  if (vidTrack) {
    const sortedSceneClips = [...vidTrack.clips]
      .filter((c) => Boolean(c.sceneId))
      .sort((a, b) => a.timelineStart - b.timelineStart);
    const orderMap = new Map<string, number>();
    sortedSceneClips.forEach((c, idx) => {
      if (c.sceneId && !orderMap.has(c.sceneId)) {
        orderMap.set(c.sceneId, idx + 1);
      }
    });
    for (const c of vidTrack.clips) {
      if (c.sceneId && orderMap.has(c.sceneId)) {
        c.sceneOrder = orderMap.get(c.sceneId);
      }
    }
    for (const m of next.timeline.markers) {
      if (m.sceneId && orderMap.has(m.sceneId)) {
        const ord = orderMap.get(m.sceneId)!;
        m.sceneOrder = ord;
        if (m.kind === 'scene') {
          m.label = m.label.replace(/^Scene\s+\d+:/i, `Scene ${ord}:`);
        }
      }
    }
    for (const s of next.sequence) {
      if (orderMap.has(s.id)) {
        s.order = orderMap.get(s.id)!;
      }
    }
    next.sequence.sort((a, b) => a.order - b.order);
  }

  return next;
}

const TRACK_COLORS: Record<TrackType, { bg: string; border: string; badge: string }> = {
  video: { bg: '#1e3a8a', border: '#3b82f6', badge: '#60a5fa' },
  dialogue: { bg: '#064e3b', border: '#10b981', badge: '#34d399' },
  sfx: { bg: '#581c87', border: '#a855f7', badge: '#c084fc' },
  music: { bg: '#78350f', border: '#f59e0b', badge: '#fbbf24' },
};

const TRACK_HEADER_WIDTH = 220;

export const TimelineEditor: React.FC<TimelineEditorProps> = ({
  project,
  playhead,
  selectedClipId,
  isNormalizing,
  isPreMixingAudio,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onPlayheadChange,
  onSelectClip,
  onUpdateProject,
  onCommitUndoSnapshot,
  onNormalizeDialogue,
  onPreMixAudio,
}) => {
  const [pixelsPerSecond, setPixelsPerSecond] = useState<number>(52);
  const [rippleMode, setRippleMode] = useState<boolean>(true);
  const [expandedTracks, setExpandedTracks] = useState<Record<string, boolean>>({});
  const [scrollLeft, setScrollLeft] = useState<number>(0);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  const assetMap = useMemo(
    () => new Map<string, ProjectMediaAsset>(project.assets.map((a) => [a.id, a])),
    [project.assets]
  );

  const totalDuration = useMemo(() => {
    let max = 16;
    for (const track of project.timeline.tracks) {
      for (const clip of track.clips) {
        const end = clip.timelineStart + Math.max(0.1, clip.sourceOut - clip.sourceIn);
        if (end + 4 > max) max = end + 4;
      }
    }
    return Math.ceil(max);
  }, [project.timeline.tracks]);

  const timelineWidthPx = Math.max(800, totalDuration * pixelsPerSecond);

  // Adaptive ruler tick interval so 1–10+ minute timelines render with minimal DOM nodes
  const rulerTicks = useMemo(() => {
    const step = pixelsPerSecond < 26 ? 5 : pixelsPerSecond < 42 ? 2 : 1;
    const ticks: number[] = [];
    for (let sec = 0; sec <= totalDuration; sec += step) {
      ticks.push(sec);
    }
    return ticks;
  }, [totalDuration, pixelsPerSecond]);

  const toggleTrackExpanded = (trackId: string, currentExpanded: boolean) => {
    const nextVal = !currentExpanded;
    setExpandedTracks((prev) => ({ ...prev, [trackId]: nextVal }));
    onUpdateProject(
      (prev) => {
        const next: VideoProjectManifest = JSON.parse(JSON.stringify(prev));
        const tr = next.timeline.tracks.find((t) => t.id === trackId);
        if (tr) tr.expanded = nextVal;
        return next;
      },
      { recordUndo: false }
    );
  };

  // Split selected clip at playhead
  const handleSplitAtPlayhead = () => {
    if (!selectedClipId) return;
    onUpdateProject((prev) => {
      const next: VideoProjectManifest = JSON.parse(JSON.stringify(prev));
      for (const track of next.timeline.tracks) {
        const idx = track.clips.findIndex((c) => c.id === selectedClipId);
        if (idx === -1) continue;
        const clip = track.clips[idx];
        const dur = clip.sourceOut - clip.sourceIn;
        const offset = playhead - clip.timelineStart;
        if (offset <= 0.15 || offset >= dur - 0.15) {
          return prev; // Playhead not inside selected clip
        }
        const splitPointSource = Math.round((clip.sourceIn + offset) * 100) / 100;
        const secondClip: TimelineClip = {
          ...clip,
          id: `${clip.id}_part2_${Date.now().toString().slice(-4)}`,
          timelineStart: Math.round(playhead * 100) / 100,
          sourceIn: splitPointSource,
          sourceOut: clip.sourceOut,
        };
        clip.sourceOut = splitPointSource;
        track.clips.splice(idx + 1, 0, secondClip);
        break;
      }
      return next;
    });
  };

  // Delete selected clip (also cleans up associated scene markers & ripples if enabled)
  const handleDeleteSelectedClip = () => {
    if (!selectedClipId) return;
    onUpdateProject((prev) => deleteClipFromManifest(prev, selectedClipId, rippleMode));
    onSelectClip(null);
  };

  // Delete a ruler marker (or an entire blank/orphaned scene heading) directly from the ruler
  const handleDeleteMarker = (marker: TimelineMarker) => {
    onUpdateProject((prev) => {
      const next: VideoProjectManifest = JSON.parse(JSON.stringify(prev));
      const dismissedSet = new Set<string>(next.dismissedSceneIds || []);
      if (marker.kind === 'scene' && marker.sceneId) {
        const scId = marker.sceneId;
        const hasAnyClips = next.timeline.tracks.some((tr) =>
          tr.clips.some((c) => c.sceneId === scId)
        );
        next.timeline.markers = next.timeline.markers.filter((m) => m.sceneId !== scId);
        if (!hasAnyClips) {
          next.sequence = next.sequence.filter((s) => s.id !== scId);
          dismissedSet.add(scId);
        }
      } else {
        next.timeline.markers = next.timeline.markers.filter((m) => m.id !== marker.id);
      }
      next.dismissedSceneIds = Array.from(dismissedSet);
      return next;
    });
  };

  // Toggle track mute
  const handleToggleMute = (trackId: string) => {
    onUpdateProject((prev) => {
      const next: VideoProjectManifest = JSON.parse(JSON.stringify(prev));
      const tr = next.timeline.tracks.find((t) => t.id === trackId);
      if (tr) tr.muted = !tr.muted;
      return next;
    });
  };

  // Change track volume
  const handleTrackVolumeChange = (trackId: string, volume: number) => {
    onUpdateProject((prev) => {
      const next: VideoProjectManifest = JSON.parse(JSON.stringify(prev));
      const tr = next.timeline.tracks.find((t) => t.id === trackId);
      if (tr) tr.volume = volume;
      return next;
    });
  };

  // Switch active take on a scene video clip
  const handleTakeSwitch = (clipId: string, newAssetId: string) => {
    onUpdateProject((prev) => {
      const next: VideoProjectManifest = JSON.parse(JSON.stringify(prev));
      const newAsset = next.assets.find((a) => a.id === newAssetId);
      if (!newAsset) return prev;
      for (const track of next.timeline.tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) {
          clip.assetId = newAsset.id;
          clip.label = newAsset.label;
          clip.sourceIn = 0;
          clip.sourceOut = newAsset.durationSeconds;
          if (newAsset.kind === 'image' || newAsset.isPosterFallback) {
            if (!clip.kenBurns || clip.kenBurns === 'none') {
              clip.kenBurns = 'zoom-in';
            }
          } else {
            clip.kenBurns = 'none';
          }
          break;
        }
      }
      return next;
    });
  };

  // Dragging clip horizontal position or trimming left/right handle
  // Records the entire drag as a single atomic Undo/Redo snapshot on mouseup!
  const startClipInteraction = (
    e: React.MouseEvent,
    clip: TimelineClip,
    mode: 'move' | 'trim-left' | 'trim-right'
  ) => {
    e.stopPropagation();
    onSelectClip(clip.id);

    const preDragSnapshot: VideoProjectManifest = JSON.parse(JSON.stringify(project));
    let hasMoved = false;

    const startX = e.clientX;
    const origTimelineStart = clip.timelineStart;
    const origSourceIn = clip.sourceIn;
    const origSourceOut = clip.sourceOut;
    const asset = assetMap.get(clip.assetId);
    const maxAssetDur =
      asset?.kind === 'image' || asset?.isPosterFallback ? 300 : asset?.durationSeconds || 60;

    // Snapshot initial positions of all clips and markers so dragging/rippling is non-cumulative
    const initialClipStarts = new Map<string, number>();
    for (const tr of project.timeline.tracks) {
      for (const c of tr.clips) {
        initialClipStarts.set(c.id, c.timelineStart);
      }
    }
    const initialMarkerTimes = new Map<string, number>();
    for (const m of project.timeline.markers) {
      initialMarkerTimes.set(m.id, m.time);
    }

    const isVideoTrackClip = clip.trackId === 'track_video_main';

    const onMouseMove = (moveEv: MouseEvent) => {
      const pixelDiff = moveEv.clientX - startX;
      if (Math.abs(pixelDiff) < 2 && !hasMoved) return;
      hasMoved = true;

      const deltaSec = pixelDiff / pixelsPerSecond;

      onUpdateProject(
        (prev) => {
          const next: VideoProjectManifest = JSON.parse(JSON.stringify(prev));
          let appliedShift = 0;

          for (const track of next.timeline.tracks) {
            const target = track.clips.find((c) => c.id === clip.id);
            if (!target) continue;

            if (mode === 'move') {
              const newStart = Math.max(0, Math.round((origTimelineStart + deltaSec) * 20) / 20);
              appliedShift = newStart - origTimelineStart;
              target.timelineStart = newStart;
            } else if (mode === 'trim-left') {
              const maxIn = origSourceOut - 0.25;
              const newIn = Math.max(0, Math.min(maxIn, origSourceIn + deltaSec));
              const appliedDelta = newIn - origSourceIn;
              target.sourceIn = Math.round(newIn * 20) / 20;
              const newStart = Math.max(0, Math.round((origTimelineStart + appliedDelta) * 20) / 20);
              appliedShift = newStart - origTimelineStart;
              target.timelineStart = newStart;
            } else if (mode === 'trim-right') {
              const minOut = origSourceIn + 0.25;
              const newOut = Math.max(minOut, Math.min(maxAssetDur, origSourceOut + deltaSec));
              const roundedOut = Math.round(newOut * 20) / 20;
              appliedShift = roundedOut - origSourceOut;
              target.sourceOut = roundedOut;
            }
            break;
          }

          // 1. Always keep this scene's ruler heading & cues (`marker.sceneId === clip.sceneId`) locked to its scene start!
          if (isVideoTrackClip && clip.sceneId && (mode === 'move' || mode === 'trim-left')) {
            for (const m of next.timeline.markers) {
              if (m.sceneId === clip.sceneId) {
                const origTime = initialMarkerTimes.get(m.id) ?? m.time;
                m.time = Math.max(0, Math.round((origTime + appliedShift) * 20) / 20);
              }
            }
            // Also move this scene's dialogue clips together when moving the scene visual block in Ripple Mode
            if (rippleMode) {
              for (const tr of next.timeline.tracks) {
                if (tr.type === 'video') continue;
                for (const c of tr.clips) {
                  if (c.sceneId === clip.sceneId && c.id !== clip.id) {
                    const origStart = initialClipStarts.get(c.id) ?? c.timelineStart;
                    c.timelineStart = Math.max(0, Math.round((origStart + appliedShift) * 20) / 20);
                  }
                }
              }
            }
          }

          // 2. If Ripple Mode is active on a scene clip, shift all subsequent scenes, clips, and headings
          if (rippleMode && isVideoTrackClip && Math.abs(appliedShift) > 0.001) {
            const rippleThreshold = origTimelineStart + 0.05;

            for (const tr of next.timeline.tracks) {
              if (tr.type === 'music') continue; // Don't shift global backing music stems
              for (const c of tr.clips) {
                if (c.id === clip.id) continue;
                if (c.sceneId && c.sceneId === clip.sceneId) continue; // Already handled above
                const origStart = initialClipStarts.get(c.id) ?? c.timelineStart;
                if (origStart >= rippleThreshold) {
                  c.timelineStart = Math.max(0, Math.round((origStart + appliedShift) * 20) / 20);
                }
              }
            }

            for (const m of next.timeline.markers) {
              if (m.sceneId && m.sceneId === clip.sceneId) continue;
              const origTime = initialMarkerTimes.get(m.id) ?? m.time;
              if (origTime >= rippleThreshold) {
                m.time = Math.max(0, Math.round((origTime + appliedShift) * 20) / 20);
              }
            }
          }

          // 3. Deterministically re-index `sceneOrder` (1..N) based on current timeline order
          if (isVideoTrackClip) {
            const vidTrack = next.timeline.tracks.find((t) => t.type === 'video');
            if (vidTrack) {
              const sortedSceneClips = [...vidTrack.clips]
                .filter((c) => Boolean(c.sceneId))
                .sort((a, b) => a.timelineStart - b.timelineStart);
              const orderMap = new Map<string, number>();
              sortedSceneClips.forEach((c, idx) => {
                if (c.sceneId && !orderMap.has(c.sceneId)) {
                  orderMap.set(c.sceneId, idx + 1);
                }
              });
              for (const c of vidTrack.clips) {
                if (c.sceneId && orderMap.has(c.sceneId)) {
                  c.sceneOrder = orderMap.get(c.sceneId);
                }
              }
              for (const m of next.timeline.markers) {
                if (m.sceneId && orderMap.has(m.sceneId)) {
                  const ord = orderMap.get(m.sceneId)!;
                  m.sceneOrder = ord;
                  if (m.kind === 'scene') {
                    m.label = m.label.replace(/^Scene\s+\d+:/i, `Scene ${ord}:`);
                  }
                }
              }
              for (const s of next.sequence) {
                if (orderMap.has(s.id)) {
                  s.order = orderMap.get(s.id)!;
                }
              }
              next.sequence.sort((a, b) => a.order - b.order);
            }
          }

          return next;
        },
        { recordUndo: false }
      );
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      if (hasMoved && onCommitUndoSnapshot) {
        onCommitUndoSnapshot(preDragSnapshot);
      }
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  // Ruler scrubbing via mouse click & drag
  const handleRulerMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const updateFromClientX = (clientX: number) => {
      const offsetX = Math.max(0, clientX - rect.left);
      const timeSec = Math.round((offsetX / pixelsPerSecond) * 20) / 20;
      onPlayheadChange(timeSec);
    };
    updateFromClientX(e.clientX);

    const onMove = (moveEv: MouseEvent) => updateFromClientX(moveEv.clientX);
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const markerIcon = (kind: TimelineMarker['kind']) => {
    if (kind === 'sfx-cue') return <Sparkles size={11} color="#c084fc" />;
    if (kind === 'camera-cue') return <Camera size={11} color="#38bdf8" />;
    return <Flag size={11} color="#fbbf24" />;
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: '#090d16',
        borderTop: '1px solid #1e293b',
      }}
    >
      {/* Timeline Toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 14px',
          background: '#0f1626',
          borderBottom: '1px solid #1e293b',
          fontSize: '12px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <button
            onClick={onUndo}
            disabled={!canUndo}
            title="Undo (Ctrl+Z)"
            style={{
              ...toolBtnStyle,
              opacity: canUndo ? 1 : 0.4,
            }}
          >
            <Undo2 size={14} color="#cbd5e1" />
            <span>Undo</span>
          </button>

          <button
            onClick={onRedo}
            disabled={!canRedo}
            title="Redo (Ctrl+Y / Ctrl+Shift+Z)"
            style={{
              ...toolBtnStyle,
              opacity: canRedo ? 1 : 0.4,
            }}
          >
            <Redo2 size={14} color="#cbd5e1" />
            <span>Redo</span>
          </button>

          <button
            onClick={handleSplitAtPlayhead}
            disabled={!selectedClipId}
            title="Split Selected Clip at Playhead (S)"
            style={{
              ...toolBtnStyle,
              opacity: selectedClipId ? 1 : 0.45,
            }}
          >
            <Scissors size={14} color="#38bdf8" />
            <span>Split Clip at Playhead</span>
          </button>

          <button
            onClick={handleDeleteSelectedClip}
            disabled={!selectedClipId}
            title="Delete Selected Clip (Delete / Backspace)"
            style={{
              ...toolBtnStyle,
              opacity: selectedClipId ? 1 : 0.45,
            }}
          >
            <Trash2 size={14} color="#f87171" />
            <span>Delete Clip</span>
          </button>

          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              marginLeft: '10px',
              padding: '4px 10px',
              background: '#161f33',
              borderRadius: '4px',
              border: '1px solid #283552',
              cursor: 'pointer',
              color: '#cbd5e1',
            }}
          >
            <input
              type="checkbox"
              checked={project.autoDuckMusicUnderDialogue}
              onChange={(e) =>
                onUpdateProject((prev) => ({
                  ...prev,
                  autoDuckMusicUnderDialogue: e.target.checked,
                }))
              }
            />
            <span>Auto-Duck BGM Under Dialogue (25%)</span>
          </label>

          <label
            title="When enabled, dragging or trimming a scene clip automatically moves its Scene Heading and shifts subsequent scenes together."
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '4px 10px',
              background: rippleMode ? 'rgba(14, 116, 144, 0.25)' : '#161f33',
              borderRadius: '4px',
              border: rippleMode ? '1px solid #06b6d4' : '1px solid #283552',
              cursor: 'pointer',
              color: rippleMode ? '#67e8f9' : '#cbd5e1',
            }}
          >
            <input
              type="checkbox"
              checked={rippleMode}
              onChange={(e) => setRippleMode(e.target.checked)}
            />
            <span>Ripple Scenes &amp; Headings</span>
          </label>

          <label
            title="Automatically applies FFmpeg Dynamic Audio Normalization (dynaudnorm) to ElevenLabs narration/dialogue clips so soft sentence endings and loud starts are leveled smoothly."
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '4px 10px',
              background:
                project.normalizeDialogueAudio !== false
                  ? 'rgba(16, 185, 129, 0.2)'
                  : '#161f33',
              borderRadius: '4px',
              border:
                project.normalizeDialogueAudio !== false
                  ? '1px solid #10b981'
                  : '1px solid #283552',
              cursor: 'pointer',
              color: project.normalizeDialogueAudio !== false ? '#6ee7b7' : '#cbd5e1',
            }}
          >
            <input
              type="checkbox"
              checked={project.normalizeDialogueAudio !== false}
              onChange={(e) =>
                onUpdateProject((prev) => ({
                  ...prev,
                  normalizeDialogueAudio: e.target.checked,
                }))
              }
            />
            <span>Normalise Narration</span>
          </label>

          {onNormalizeDialogue && (
            <>
              <button
                onClick={() => onNormalizeDialogue(false)}
                disabled={isNormalizing}
                title="Run FFmpeg dynamic audio normalizer on all dialogue/narration clips now so Live Preview plays leveled narration."
                style={{
                  ...toolBtnStyle,
                  background: '#064e3b',
                  borderColor: '#10b981',
                  color: '#ecfdf5',
                  opacity: isNormalizing ? 0.6 : 1,
                }}
              >
                <Volume2 size={14} color="#34d399" />
                <span>{isNormalizing ? 'Leveling...' : 'Level Narration'}</span>
              </button>

              <button
                onClick={() => onNormalizeDialogue(true)}
                disabled={isNormalizing}
                title="Level Narration (dynaudnorm) + SFX (peak/dynamic) + Music (EBU R128 loudnorm so songs match in volume without flattening musical dynamics)."
                style={{
                  ...toolBtnStyle,
                  background: '#3b0764',
                  borderColor: '#a855f7',
                  color: '#f3e8ff',
                  opacity: isNormalizing ? 0.6 : 1,
                }}
              >
                <Sparkles size={13} color="#c084fc" />
                <span>Level All (+SFX/BGM)</span>
              </button>
            </>
          )}

          {onPreMixAudio && (
            <button
              onClick={onPreMixAudio}
              disabled={isPreMixingAudio}
              title="Mix All Audio (Dialogue + SFX + BGM + Auto-Ducking + Fades) into an invisible master MP3 for ultra-smooth live preview on large timelines."
              style={{
                ...toolBtnStyle,
                background: project.preMixedAudioRelativePath ? '#0c4a6e' : '#161f33',
                borderColor: '#38bdf8',
                color: '#e0f2fe',
                opacity: isPreMixingAudio ? 0.6 : 1,
              }}
            >
              <Volume2 size={14} color="#38bdf8" />
              <span>{isPreMixingAudio ? 'Mixing MP3...' : 'Mix All Audio (MP3)'}</span>
            </button>
          )}
        </div>

        {/* Zoom Controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ color: '#94a3b8' }}>Timeline Zoom:</span>
          <button
            onClick={() => setPixelsPerSecond((p) => Math.max(20, p - 12))}
            style={toolBtnStyle}
            title="Zoom Out"
          >
            <ZoomOut size={14} />
          </button>
          <span style={{ width: '48px', textAlign: 'center', color: '#e2e8f0' }}>
            {pixelsPerSecond}px/s
          </span>
          <button
            onClick={() => setPixelsPerSecond((p) => Math.min(140, p + 12))}
            style={toolBtnStyle}
            title="Zoom In"
          >
            <ZoomIn size={14} />
          </button>
        </div>
      </div>

      {/* Scrollable Multi-Track Canvas */}
      <div
        ref={scrollContainerRef}
        onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
        style={{
          flex: 1,
          overflow: 'auto',
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            display: 'flex',
            minWidth: `${ TRACK_HEADER_WIDTH + timelineWidthPx }px`,
            flexDirection: 'column',
            position: 'relative',
          }}
        >
          {/* Ruler & Storyboard SFX/Scene Markers Row */}
          <div
            style={{
              display: 'flex',
              height: '44px',
              background: '#0c1220',
              borderBottom: '1px solid #1e293b',
              position: 'sticky',
              top: 0,
              zIndex: 20,
            }}
          >
            <div
              style={{
                width: `${TRACK_HEADER_WIDTH}px`,
                flexShrink: 0,
                borderRight: '1px solid #1e293b',
                padding: '0 12px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                fontSize: '11px',
                color: '#94a3b8',
                background: '#0c1220',
                position: 'sticky',
                left: 0,
                zIndex: 40,
                boxShadow: '4px 0 8px rgba(0, 0, 0, 0.45)',
              }}
            >
              <span>Tracks / Scene Cues</span>
              <span style={{ color: '#fbbf24' }}>{project.timeline.markers.length} cues</span>
            </div>

            {/* Interactive Time Ruler */}
            <div
              onMouseDown={handleRulerMouseDown}
              style={{
                width: `${timelineWidthPx}px`,
                position: 'relative',
                cursor: 'ew-resize',
                background: '#0a0f1c',
                backgroundImage: `repeating-linear-gradient(to right, rgba(30, 41, 59, 0.5) 0px, rgba(30, 41, 59, 0.5) 1px, transparent 1px, transparent ${pixelsPerSecond}px)`,
              }}
            >
              {rulerTicks.map((sec) => (
                <div
                  key={sec}
                  style={{
                    position: 'absolute',
                    left: `${sec * pixelsPerSecond}px`,
                    top: 0,
                    bottom: 0,
                    borderLeft: sec % 5 === 0 ? '1px solid #334155' : '1px solid #1e293b',
                    paddingLeft: '4px',
                    paddingTop: '2px',
                    fontSize: '10px',
                    color: sec % 5 === 0 ? '#94a3b8' : '#475569',
                    pointerEvents: 'none',
                  }}
                >
                  {sec % 2 === 0 || sec % 5 === 0 ? `${sec}s` : ''}
                </div>
              ))}

              {/* Scene & Storyboard SFX / Camera Markers */}
              {project.timeline.markers.map((marker) => (
                <div
                  key={marker.id}
                  title={marker.details ? `${marker.label}\n${marker.details}` : marker.label}
                  onMouseDown={(ev) => ev.stopPropagation()}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onPlayheadChange(marker.time);
                  }}
                  style={{
                    position: 'absolute',
                    left: `${marker.time * pixelsPerSecond}px`,
                    bottom: marker.kind === 'scene' ? '20px' : '2px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    padding: '1px 5px',
                    borderRadius: '3px',
                    fontSize: '10px',
                    whiteSpace: 'nowrap',
                    background:
                      marker.kind === 'sfx-cue'
                        ? 'rgba(88, 28, 135, 0.9)'
                        : marker.kind === 'camera-cue'
                        ? 'rgba(12, 74, 110, 0.9)'
                        : 'rgba(120, 53, 15, 0.9)',
                    border:
                      marker.kind === 'sfx-cue'
                        ? '1px solid #a855f7'
                        : marker.kind === 'camera-cue'
                        ? '1px solid #38bdf8'
                        : '1px solid #f59e0b',
                    color: '#f8fafc',
                    cursor: 'pointer',
                    zIndex: 15,
                  }}
                >
                  {markerIcon(marker.kind)}
                  <span>{marker.label.slice(0, 28)}</span>
                  <button
                    type="button"
                    title="Remove this marker / empty scene heading"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      handleDeleteMarker(marker);
                    }}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: 'rgba(248, 250, 252, 0.65)',
                      padding: '0 0 0 2px',
                      display: 'inline-flex',
                      alignItems: 'center',
                      cursor: 'pointer',
                    }}
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Track Rows */}
          {project.timeline.tracks.map((track: TimelineTrack) => {
            const colors = TRACK_COLORS[track.type];
            const { laneByClipId, laneCount } = packClipsIntoSubLanes(track.clips);
            const isExpanded = expandedTracks[track.id] ?? Boolean(track.expanded);
            const baseHeight = track.type === 'video' ? 76 : 64;
            const expandedSubLaneHeight = 48;
            const expandedInnerHeight = Math.max(
              baseHeight,
              laneCount * expandedSubLaneHeight + 12
            );
            const outerRowHeight = isExpanded
              ? Math.min(216, expandedInnerHeight)
              : baseHeight;

            return (
              <div
                key={track.id}
                style={{
                  display: 'flex',
                  height: `${outerRowHeight}px`,
                  borderBottom: '1px solid #1e293b',
                  position: 'relative',
                }}
              >
                {/* Sticky Left Track Header */}
                <div
                  style={{
                    width: `${TRACK_HEADER_WIDTH}px`,
                    flexShrink: 0,
                    background: '#0f1523',
                    borderRight: '1px solid #1e293b',
                    padding: '6px 12px',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    position: 'sticky',
                    left: 0,
                    zIndex: 35,
                    boxShadow: '4px 0 8px rgba(0, 0, 0, 0.45)',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '4px',
                    }}
                  >
                    <span
                      style={{
                        fontSize: '12px',
                        fontWeight: 600,
                        color: track.muted ? '#64748b' : '#f1f5f9',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      <span
                        style={{
                          width: '8px',
                          height: '8px',
                          borderRadius: '50%',
                          background: colors.badge,
                          flexShrink: 0,
                        }}
                      />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {track.name}
                      </span>
                    </span>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                      {laneCount > 1 && (
                        <span
                          title={`${laneCount} overlapping clip lanes on this track`}
                          style={{
                            fontSize: '9px',
                            padding: '1px 5px',
                            borderRadius: '4px',
                            background: 'rgba(168, 85, 247, 0.2)',
                            border: `1px solid ${colors.border}`,
                            color: colors.badge,
                            fontWeight: 600,
                          }}
                        >
                          {laneCount} lanes
                        </span>
                      )}

                      <button
                        onClick={() => toggleTrackExpanded(track.id, isExpanded)}
                        title={
                          isExpanded
                            ? 'Collapse vertical track sub-lanes'
                            : `Expand track vertically (${laneCount} lane${laneCount > 1 ? 's' : ''})`
                        }
                        style={{
                          background: isExpanded ? 'rgba(56, 189, 248, 0.18)' : '#161f33',
                          border: isExpanded ? '1px solid #38bdf8' : '1px solid #283552',
                          borderRadius: '4px',
                          color: isExpanded ? '#38bdf8' : '#cbd5e1',
                          padding: '2px 4px',
                          display: 'inline-flex',
                          alignItems: 'center',
                          cursor: 'pointer',
                        }}
                      >
                        {isExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                      </button>

                      <button
                        onClick={() => handleToggleMute(track.id)}
                        title={track.muted ? 'Unmute Track' : 'Mute Track'}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: track.muted ? '#ef4444' : '#94a3b8',
                          padding: '2px',
                        }}
                      >
                        {track.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
                      </button>
                    </div>
                  </div>

                  {track.type !== 'video' && (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        fontSize: '11px',
                        color: '#94a3b8',
                      }}
                    >
                      <span>Vol</span>
                      <input
                        type="range"
                        min={0}
                        max={1.2}
                        step={0.05}
                        value={track.volume}
                        onChange={(e) =>
                          handleTrackVolumeChange(track.id, parseFloat(e.target.value))
                        }
                        style={{ width: '110px', accentColor: colors.badge }}
                      />
                      <span>{Math.round(track.volume * 100)}%</span>
                    </div>
                  )}
                </div>

                {/* Track Lane (with vertical scrollbar when expanded and many sub-lanes exist) */}
                <div
                  onClick={() => onSelectClip(null)}
                  style={{
                    width: `${timelineWidthPx}px`,
                    height: '100%',
                    overflowY: isExpanded && expandedInnerHeight > outerRowHeight ? 'auto' : 'hidden',
                    overflowX: 'hidden',
                    position: 'relative',
                    background: track.muted ? 'rgba(15, 23, 42, 0.45)' : '#090d16',
                  }}
                >
                  <div
                    style={{
                      width: '100%',
                      height: `${isExpanded ? expandedInnerHeight : baseHeight}px`,
                      position: 'relative',
                      backgroundImage: `repeating-linear-gradient(to right, rgba(30, 41, 59, 0.45) 0px, rgba(30, 41, 59, 0.45) 1px, transparent 1px, transparent ${pixelsPerSecond}px)`,
                    }}
                  >
                    {/* Clips */}
                    {track.clips.map((clip) => {
                      const dur = Math.max(0.15, clip.sourceOut - clip.sourceIn);
                      const leftPx = clip.timelineStart * pixelsPerSecond;
                      const widthPx = Math.max(18, dur * pixelsPerSecond);
                      const isSelected = clip.id === selectedClipId;
                      const asset = assetMap.get(clip.assetId);
                      const hasMultipleTakes =
                        clip.availableTakeAssetIds && clip.availableTakeAssetIds.length > 1;
                      const laneIdx = laneByClipId.get(clip.id) || 0;

                      // Compute vertical placement per sub-lane so overlapping SFX/audio clips NEVER hide each other
                      let clipTopPx = 6;
                      let clipHeightPx = baseHeight - 12;
                      if (isExpanded) {
                        clipTopPx = 6 + laneIdx * expandedSubLaneHeight;
                        clipHeightPx = expandedSubLaneHeight - 6;
                      } else if (laneCount > 1) {
                        const usableHeight = baseHeight - 8;
                        const compactLaneHeight = Math.max(18, Math.floor(usableHeight / laneCount));
                        clipTopPx = 4 + laneIdx * compactLaneHeight;
                        clipHeightPx = Math.max(16, compactLaneHeight - 2);
                      }

                      return (
                        <div
                          key={clip.id}
                          onMouseDown={(ev) => startClipInteraction(ev, clip, 'move')}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            onSelectClip(clip.id);
                          }}
                          style={{
                            position: 'absolute',
                            left: `${leftPx}px`,
                            width: `${widthPx}px`,
                            top: `${clipTopPx}px`,
                            height: `${clipHeightPx}px`,
                            background: colors.bg,
                            border: isSelected
                              ? '2px solid #facc15'
                              : `1px solid ${colors.border}`,
                            borderRadius: '6px',
                            overflow: 'hidden',
                            display: 'flex',
                            flexDirection: 'column',
                            justifyContent: 'space-between',
                            padding: clipHeightPx < 34 ? '1px 8px' : '4px 10px',
                            cursor: 'grab',
                            boxShadow: isSelected
                              ? '0 0 0 2px rgba(250, 204, 21, 0.35)'
                              : '0 2px 6px rgba(0,0,0,0.4)',
                            zIndex: isSelected ? 12 : 5 + laneIdx,
                          }}
                        >
                        {/* Left Trim Handle */}
                        <div
                          onMouseDown={(ev) => startClipInteraction(ev, clip, 'trim-left')}
                          title="Drag to trim clip In-point"
                          style={{
                            position: 'absolute',
                            left: 0,
                            top: 0,
                            bottom: 0,
                            width: '7px',
                            background: 'rgba(255,255,255,0.22)',
                            cursor: 'ew-resize',
                          }}
                        />

                        {/* Top Clip Label & Take Switcher */}
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: '6px',
                            fontSize: '11px',
                            fontWeight: 600,
                            color: '#f8fafc',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {clip.label}
                          </span>

                          {hasMultipleTakes && (
                            <select
                              value={clip.assetId}
                              onMouseDown={(ev) => ev.stopPropagation()}
                              onClick={(ev) => ev.stopPropagation()}
                              onChange={(ev) => handleTakeSwitch(clip.id, ev.target.value)}
                              title="Switch Scene Take (Scene Takes, Storyboard Takes, or First-Frame Poster)"
                              style={{
                                background: '#0f172a',
                                color: '#38bdf8',
                                border: '1px solid #38bdf8',
                                borderRadius: '4px',
                                fontSize: '10px',
                                padding: '1px 4px',
                                cursor: 'pointer',
                              }}
                            >
                              {clip.availableTakeAssetIds!.map((takeId, idx) => {
                                const takeAsset = assetMap.get(takeId);
                                return (
                                  <option key={takeId} value={takeId}>
                                    {takeAsset
                                      ? takeAsset.isPosterFallback
                                        ? 'Poster Frame'
                                        : `Take ${idx + 1}: ${takeAsset.label.slice(0, 24)}`
                                      : `Take ${idx + 1}`}
                                  </option>
                                );
                              })}
                            </select>
                          )}
                        </div>

                        {/* Visual Fade-In Slope Indicator (Topic 8) */}
                        {track.type !== 'video' && (clip.fadeIn || 0) > 0 && (
                          <div
                            title={`Fade In: ${clip.fadeIn}s`}
                            style={{
                              position: 'absolute',
                              left: 0,
                              top: 0,
                              bottom: 0,
                              width: `${Math.min(widthPx * 0.45, (clip.fadeIn || 0) * pixelsPerSecond)}px`,
                              background:
                                'linear-gradient(to bottom right, rgba(6, 9, 17, 0.72) 48%, transparent 52%)',
                              pointerEvents: 'none',
                            }}
                          />
                        )}

                        {/* Visual Fade-Out Slope Indicator (Topic 8) */}
                        {track.type !== 'video' && (clip.fadeOut || 0) > 0 && (
                          <div
                            title={`Fade Out: ${clip.fadeOut}s`}
                            style={{
                              position: 'absolute',
                              right: 0,
                              top: 0,
                              bottom: 0,
                              width: `${Math.min(widthPx * 0.45, (clip.fadeOut || 0) * pixelsPerSecond)}px`,
                              background:
                                'linear-gradient(to bottom left, rgba(6, 9, 17, 0.72) 48%, transparent 52%)',
                              pointerEvents: 'none',
                            }}
                          />
                        )}

                        {/* Bottom Clip Metadata / Trim Info */}
                        {clipHeightPx >= 32 && (
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              fontSize: '10px',
                              color: 'rgba(241, 245, 249, 0.75)',
                            }}
                          >
                            <span>
                              {dur.toFixed(1)}s (in: {clip.sourceIn.toFixed(1)}s →{' '}
                              {clip.sourceOut.toFixed(1)}s)
                            </span>
                            {track.type !== 'video' &&
                              ((clip.fadeIn || 0) > 0 || (clip.fadeOut || 0) > 0) && (
                                <span
                                  style={{ color: '#fde68a', fontSize: '9px' }}
                                  title={`Fade In: ${clip.fadeIn || 0}s | Fade Out: ${clip.fadeOut || 0}s`}
                                >
                                  ↗{clip.fadeIn || 0}s / {clip.fadeOut || 0}s↘
                                </span>
                              )}
                            {asset?.isPosterFallback && (
                              <span style={{ color: '#fbbf24' }}>● Still Poster</span>
                            )}
                            {clip.kenBurns && clip.kenBurns !== 'none' && (
                              <span
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '3px',
                                  color: '#38bdf8',
                                  fontWeight: 600,
                                }}
                                title={`Ken Burns Camera Motion: ${clip.kenBurns}`}
                              >
                                <Camera size={10} />
                                {clip.kenBurns}
                              </span>
                            )}
                            {hasMultipleTakes && (
                              <span
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '2px',
                                  color: '#93c5fd',
                                }}
                              >
                                <Layers size={10} />
                                {clip.availableTakeAssetIds!.length} takes
                              </span>
                            )}
                          </div>
                        )}

                        {/* Right Trim Handle */}
                        <div
                          onMouseDown={(ev) => startClipInteraction(ev, clip, 'trim-right')}
                          title="Drag to trim clip Out-point"
                          style={{
                            position: 'absolute',
                            right: 0,
                            top: 0,
                            bottom: 0,
                            width: '7px',
                            background: 'rgba(255,255,255,0.22)',
                            cursor: 'ew-resize',
                          }}
                        />
                      </div>
                    );
                  })}
                  </div>
                </div>
              </div>
            );
          })}

          {/* Vertical Playhead Line Spanning All Tracks (hidden when scrolled behind the sticky left Track Header column) */}
          {playhead * pixelsPerSecond >= scrollLeft - 1 && (
            <div
              style={{
                position: 'absolute',
                left: `${TRACK_HEADER_WIDTH + playhead * pixelsPerSecond}px`,
                top: 0,
                bottom: 0,
                width: '2px',
                background: '#ef4444',
                pointerEvents: 'none',
                zIndex: 25,
                boxShadow: '0 0 8px rgba(239, 68, 68, 0.8)',
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  left: '-6px',
                  width: '14px',
                  height: '14px',
                  background: '#ef4444',
                  clipPath: 'polygon(0 0, 100% 0, 50% 100%)',
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  top: '14px',
                  left: '4px',
                  background: '#ef4444',
                  color: '#fff',
                  fontSize: '9px',
                  fontWeight: 700,
                  padding: '1px 4px',
                  borderRadius: '3px',
                  whiteSpace: 'nowrap',
                }}
              >
                {formatTimecode(playhead)}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const toolBtnStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '5px',
  background: '#161f33',
  color: '#e2e8f0',
  border: '1px solid #283552',
  borderRadius: '4px',
  padding: '4px 10px',
  fontSize: '12px',
};
