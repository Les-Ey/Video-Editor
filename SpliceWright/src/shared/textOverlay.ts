import { getClipTimelineDuration, TextOverlay, TimelineClip, VideoProjectManifest } from './types';

export interface TextOverlayBitmap {
  dataUrl: string;
  width: number;
  height: number;
}

export function createDefaultTextOverlay(text: string, frameHeight: number): TextOverlay {
  return {
    text, fontFamily: 'sans-serif', fontSize: Math.max(1, Math.round(frameHeight * 0.055)),
    color: '#ffffff', x: 0.1, y: 0.1,
  };
}

export function getTextClips(project: VideoProjectManifest): Array<TimelineClip & { textOverlay: TextOverlay }> {
  return project.timeline.tracks.filter((track) => track.type === 'text' && !track.muted)
    .flatMap((track) => track.clips.map((clip) => {
      if (!clip.textOverlay) throw new Error(`Text clip "${clip.label}" has no text overlay data.`);
      return { ...clip, textOverlay: clip.textOverlay };
    }));
}

export function addTextClip(project: VideoProjectManifest, start: number, id: string): VideoProjectManifest {
  const existing = project.timeline.tracks.find((track) => track.type === 'text');
  const visual = project.timeline.tracks.find((track) => track.type === 'video')?.clips.find(
    (clip) => start >= clip.timelineStart && start < clip.timelineStart + getClipTimelineDuration(clip)
  );
  const duration = visual ? Math.min(5, visual.timelineStart + getClipTimelineDuration(visual) - start) : 5;
  const trackId = existing?.id || 'track_text';
  const clip: TimelineClip = {
    id, assetId: '', trackId, label: 'Your text', timelineStart: start,
    sourceIn: 0, sourceOut: Math.max(0.25, Math.round(duration * 100) / 100), volume: 1,
    textOverlay: createDefaultTextOverlay('Your text', project.format.height),
  };
  return {
    ...project,
    timeline: {
      ...project.timeline,
      tracks: existing
        ? project.timeline.tracks.map((track) => track.id === trackId
          ? { ...track, muted: false, clips: [...track.clips, clip] } : track)
        : [...project.timeline.tracks, {
          id: trackId, name: 'Text Overlays', type: 'text', volume: 1, muted: false, clips: [clip],
        }],
    },
  };
}

export function getTextPosition(
  overlay: TextOverlay, bitmap: Pick<TextOverlayBitmap, 'width' | 'height'>,
  frameWidth: number, frameHeight: number
): { x: number; y: number } {
  return {
    x: Math.round(Math.max(0, Math.min(1 - bitmap.width / frameWidth, overlay.x)) * frameWidth),
    y: Math.round(Math.max(0, Math.min(1 - bitmap.height / frameHeight, overlay.y)) * frameHeight),
  };
}

// Keep this browser-only function self-contained: the export renderer executes the
// same function in an isolated Chromium window so preview and MP4 use identical glyphs.
export function rasterizeTextOverlay(overlay: TextOverlay, width: number, height: number): TextOverlayBitmap {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 ||
    !Number.isFinite(overlay.fontSize) || overlay.fontSize < 1 ||
    !Number.isFinite(overlay.x) || !Number.isFinite(overlay.y) ||
    !['sans-serif', 'serif', 'monospace'].includes(overlay.fontFamily) ||
    !/^#[0-9a-f]{6}$/i.test(overlay.color) || typeof overlay.text !== 'string' ||
    (overlay.background !== undefined &&
      (!overlay.background || !/^#[0-9a-f]{6}$/i.test(overlay.background.color) ||
        !Number.isFinite(overlay.background.opacity) ||
        overlay.background.opacity < 0 || overlay.background.opacity > 1))) {
    throw new Error('Invalid text overlay style or output dimensions.');
  }
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Cannot create a canvas to render text.');
  const font = `700 ${overlay.fontSize}px ${overlay.fontFamily}`;
  context.font = font;
  const padding = Math.ceil(Math.max(3, overlay.fontSize * 0.15));
  const maxWidth = Math.max(1, width * 0.9 - padding * 2);
  const lines: string[] = [];
  for (const paragraph of overlay.text.split(/\r\n|\r|\n/)) {
    let line = '';
    for (const character of paragraph) {
      if (line && context.measureText(line + character).width > maxWidth) {
        const space = line.lastIndexOf(' ');
        lines.push(space > 0 ? line.slice(0, space) : line);
        line = space > 0 ? line.slice(space + 1) : '';
      }
      line += character;
    }
    lines.push(line);
  }
  const lineHeight = Math.ceil(overlay.fontSize * 1.25);
  canvas.width = Math.max(1, Math.min(width,
    Math.ceil(lines.reduce((max, line) => Math.max(max, context.measureText(line).width), 0)) + padding * 2));
  canvas.height = Math.max(1, Math.min(height, lines.length * lineHeight + padding * 2));
  if (overlay.background) {
    context.globalAlpha = overlay.background.opacity;
    context.fillStyle = overlay.background.color;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.globalAlpha = 1;
  }
  context.font = font;
  context.textBaseline = 'top';
  context.lineJoin = 'round';
  context.lineWidth = Math.max(2, overlay.fontSize * 0.08);
  context.strokeStyle = '#000000';
  context.fillStyle = overlay.color;
  lines.forEach((line, index) => {
    const y = padding + index * lineHeight;
    context.strokeText(line, padding, y);
    context.fillText(line, padding, y);
  });
  return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
}
