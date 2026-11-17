import React from 'react';
import { getClipTimelineDuration, TextOverlay, TimelineClip } from '../../shared/types';

export function TextOverlayInspector({
  clip, overlay, onChange,
}: {
  clip: TimelineClip;
  overlay: TextOverlay;
  onChange: (patch: Partial<TimelineClip>) => void;
}) {
  const updateStyle = (patch: Partial<TextOverlay>) => onChange({
    textOverlay: { ...overlay, ...patch },
    ...(patch.text !== undefined ? { label: patch.text.split('\n')[0].slice(0, 60) || 'Text' } : {}),
  });
  const background = overlay.background;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', color: '#cbd5e1', fontSize: '12px' }}>
      <label>
        Text
        <textarea
          autoFocus
          aria-label="Overlay text"
          value={overlay.text}
          onChange={(e) => updateStyle({ text: e.target.value })}
          rows={3}
          style={{ ...inputStyle, width: '100%', resize: 'vertical' }}
        />
      </label>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <label>Font
          <select aria-label="Text font" value={overlay.fontFamily} style={inputStyle}
            onChange={(e) => updateStyle({ fontFamily: e.target.value as TextOverlay['fontFamily'] })}>
            <option value="sans-serif">Sans Serif</option>
            <option value="serif">Serif</option>
            <option value="monospace">Monospace</option>
          </select>
        </label>
        <label>Size (px)
          <input aria-label="Text size" type="number" min={1} step={1} value={overlay.fontSize}
            style={{ ...inputStyle, width: '75px' }}
            onChange={(e) => {
              const value = e.target.valueAsNumber;
              if (Number.isFinite(value) && value >= 1) updateStyle({ fontSize: value });
            }} />
        </label>
        <label>Colour
          <input aria-label="Text colour" type="color" value={overlay.color} style={inputStyle}
            onChange={(e) => updateStyle({ color: e.target.value })} />
        </label>
        <label>Start (s)
          <input aria-label="Text start" type="number" min={0} step={0.1} value={clip.timelineStart}
            style={{ ...inputStyle, width: '80px' }}
            onChange={(e) => {
              const value = e.target.valueAsNumber;
              if (Number.isFinite(value) && value >= 0) onChange({ timelineStart: value });
            }} />
        </label>
        <label>Duration (s)
          <input aria-label="Text duration" type="number" min={0.25} step={0.1}
            value={getClipTimelineDuration(clip)} style={{ ...inputStyle, width: '80px' }}
            onChange={(e) => {
              const value = e.target.valueAsNumber;
              if (Number.isFinite(value) && value >= 0.25) onChange({ sourceOut: clip.sourceIn + value });
            }} />
        </label>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <input aria-label="Enable text background" type="checkbox" checked={!!overlay.background}
          onChange={(e) => updateStyle({
            background: e.target.checked ? { color: '#000000', opacity: 0.5 } : undefined,
          })} />
        Text background
      </label>
      {background && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <label>Background colour
            <input aria-label="Text background colour" type="color" value={background.color}
              style={inputStyle}
              onChange={(e) => updateStyle({
                background: { ...background, color: e.target.value },
              })} />
          </label>
          <label>
            Background transparency: {Math.round((1 - background.opacity) * 100)}%
            <input aria-label="Text background transparency" type="range" min={0} max={100} step={1}
              value={Math.round((1 - background.opacity) * 100)}
              style={{ display: 'block', marginTop: '3px' }}
              onChange={(e) => updateStyle({
                background: { ...background, opacity: 1 - e.target.valueAsNumber / 100 },
              })} />
          </label>
        </div>
      )}
      <span style={{ color: '#94a3b8', fontSize: '11px' }}>
        Drag the text in the Program Monitor to position it. Move or trim its Text Overlays clip
        to change timing. Text wraps to the frame width and is separate from captions/subtitles.
      </span>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  display: 'block', background: '#0b1322', color: '#f1f5f9', border: '1px solid #334155',
  borderRadius: '4px', padding: '4px 6px', marginTop: '3px', fontSize: '12px',
};
