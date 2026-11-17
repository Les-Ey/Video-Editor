import React, { useMemo, useState } from 'react';
import { createMottledBackgroundBmp, getStillCamera } from '../../shared/imageBackground';
import { getClipTimelineDuration, ImageBackground, TimelineClip } from '../../shared/types';

export function StillImageBackdrop({
  background, src,
}: { background: ImageBackground; src: string }) {
  const mottledUrl = useMemo(() => {
    const bytes = createMottledBackgroundBmp();
    return `data:image/bmp;base64,${btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))}`;
  }, []);
  if (background === 'black') return null;
  return (
    <img
      aria-hidden="true"
      alt=""
      src={background === 'mottled' ? mottledUrl : src}
      style={background === 'mottled' ? {
        position: 'absolute', inset: 0, width: '100%', height: '100%',
        objectFit: 'fill', pointerEvents: 'none',
      } : {
        position: 'absolute', left: '-10%', top: '-10%', width: '120%', height: '120%',
        objectFit: 'cover', filter: 'blur(3cqw) brightness(0.55)', pointerEvents: 'none',
      }}
    />
  );
}

export function StillImageForeground({
  src, label, clip, progress, width, height, fps,
}: {
  src: string;
  label: string;
  clip: TimelineClip;
  progress: number;
  width: number;
  height: number;
  fps: number;
}) {
  const [dimensions, setDimensions] = useState<{ src: string; width: number; height: number } | null>(null);
  const duration = getClipTimelineDuration(clip);
  const motionProgress = Math.min(1,
    Math.floor(progress * duration * fps) / Math.max(1, Math.round(duration * fps) - 1)
  );
  const camera = getStillCamera(clip.kenBurns, motionProgress, clip.fitMode);
  const fit = clip.fitMode || 'contain';
  let imageStyle: React.CSSProperties = {
    position: 'absolute', width: '100%', height: '100%', objectFit: 'contain',
  };
  if (dimensions?.src === src) {
    const relativeRatio = (dimensions.width / dimensions.height) / (width / height);
    let w = 100;
    let h = 100;
    if (fit === 'fill-width') h = 100 / relativeRatio;
    else if (fit === 'fill-height') w = 100 * relativeRatio;
    else if (fit !== 'stretch-fill') {
      const cover = fit === 'cover-crop';
      if ((relativeRatio > 1) === cover) w = 100 * relativeRatio;
      else h = 100 / relativeRatio;
    }
    let x = (100 - w) / 2;
    let y = (100 - h) / 2;
    if (fit === 'fill-width' && h > 100) {
      const scroll = clip.kenBurns === 'pan-top-to-bottom' ? progress :
        clip.kenBurns === 'pan-bottom-to-top' ? 1 - progress : 0;
      y = (100 - h) * scroll;
    }
    if (fit === 'fill-height' && w > 100) {
      const scroll = clip.kenBurns === 'pan-left-to-right' ? progress :
        clip.kenBurns === 'pan-right-to-left' ? 1 - progress : 0;
      x = (100 - w) * scroll;
    }
    imageStyle = {
      position: 'absolute', left: `${x}%`, top: `${y}%`,
      width: `${w}%`, height: `${h}%`,
    };
  }
  return (
    <div style={{
      position: 'absolute', inset: 0, overflow: 'hidden', transformOrigin: '0 0',
      transform: `translate(${-100 * (camera.zoom - 1) * camera.x}%, ${-100 * (camera.zoom - 1) * camera.y}%) scale(${camera.zoom})`,
    }}>
      <img
        src={src}
        alt={label}
        onLoad={(e) => setDimensions({
          src, width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight,
        })}
        style={imageStyle}
      />
    </div>
  );
}
