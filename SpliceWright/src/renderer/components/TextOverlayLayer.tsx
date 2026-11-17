import React, { useMemo, useRef } from 'react';
import { getTextClips, getTextPosition, rasterizeTextOverlay } from '../../shared/textOverlay';
import { getClipTimelineDuration, TextOverlay, TimelineClip, VideoProjectManifest } from '../../shared/types';

export interface TextOverlayEditingProps {
  selectedClipId?: string | null;
  onSelectClip?: (id: string | null) => void;
  onUpdateProject?: (
    updater: (prev: VideoProjectManifest) => VideoProjectManifest,
    options?: { recordUndo?: boolean }
  ) => void;
  onCommitUndoSnapshot?: (snapshot: VideoProjectManifest) => void;
}

export function TextOverlayLayer(props: TextOverlayEditingProps & {
  project: VideoProjectManifest;
  playhead: number;
  onStartDrag: () => void;
}) {
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 8 }}>
      {getTextClips(props.project).filter((clip) =>
        props.playhead >= clip.timelineStart &&
        props.playhead < clip.timelineStart + getClipTimelineDuration(clip)
      ).map((clip) => <OverlayImage key={clip.id} {...props} clip={clip} />)}
    </div>
  );
}

function OverlayImage({
  project, clip, selectedClipId, onSelectClip, onUpdateProject, onCommitUndoSnapshot, onStartDrag,
}: TextOverlayEditingProps & {
  project: VideoProjectManifest;
  clip: TimelineClip & { textOverlay: TextOverlay };
  onStartDrag: () => void;
}) {
  const { width, height } = project.format;
  const overlay = clip.textOverlay;
  const bitmap = useMemo(() => rasterizeTextOverlay(overlay, width, height),
    [overlay.text, overlay.fontFamily, overlay.fontSize, overlay.color,
      overlay.background?.color, overlay.background?.opacity, width, height]);
  const position = getTextPosition(overlay, bitmap, width, height);
  const drag = useRef<{
    x: number; y: number; left: number; top: number; width: number; height: number;
    snapshot: VideoProjectManifest; moved: boolean;
  } | null>(null);
  const finishDrag = () => {
    const current = drag.current;
    drag.current = null;
    if (current?.moved) onCommitUndoSnapshot?.(current.snapshot);
  };
  return (
    <img
      src={bitmap.dataUrl}
      alt={overlay.text}
      draggable={false}
      data-text-overlay-id={clip.id}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => {
        if (!onUpdateProject || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const bounds = e.currentTarget.parentElement!.getBoundingClientRect();
        drag.current = {
          x: e.clientX, y: e.clientY, left: position.x / width, top: position.y / height,
          width: bounds.width, height: bounds.height,
          snapshot: structuredClone(project), moved: false,
        };
        e.currentTarget.setPointerCapture(e.pointerId);
        onSelectClip?.(clip.id);
        onStartDrag();
      }}
      onPointerMove={(e) => {
        const current = drag.current;
        if (!current || !onUpdateProject) return;
        const dx = e.clientX - current.x;
        const dy = e.clientY - current.y;
        if (!current.moved && Math.abs(dx) + Math.abs(dy) < 2) return;
        current.moved = true;
        const nextPosition = getTextPosition({
          ...overlay, x: current.left + dx / current.width, y: current.top + dy / current.height,
        }, bitmap, width, height);
        onUpdateProject((prev) => ({
          ...prev,
          timeline: {
            ...prev.timeline,
            tracks: prev.timeline.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((item) => item.id === clip.id && item.textOverlay ? {
                ...item, textOverlay: {
                  ...item.textOverlay, x: nextPosition.x / width, y: nextPosition.y / height,
                },
              } : item),
            })),
          },
        }), { recordUndo: false });
      }}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onLostPointerCapture={finishDrag}
      style={{
        position: 'absolute', left: `${100 * position.x / width}%`, top: `${100 * position.y / height}%`,
        width: `${100 * bitmap.width / width}%`, height: `${100 * bitmap.height / height}%`,
        pointerEvents: onUpdateProject ? 'auto' : 'none', touchAction: 'none',
        cursor: onUpdateProject ? 'move' : undefined,
        outline: selectedClipId === clip.id ? '1px dashed #f0abfc' : undefined,
      }}
    />
  );
}
