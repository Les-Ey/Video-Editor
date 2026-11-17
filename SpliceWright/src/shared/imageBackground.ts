import { ClipFitMode, KenBurnsPreset } from './types';

export function createMottledBackgroundBmp(): Uint8Array {
  const size = 192;
  const pixels = size * size * 3;
  const bytes = new Uint8Array(54 + pixels);
  const header = new DataView(bytes.buffer);
  bytes[0] = 66;
  bytes[1] = 77;
  header.setUint32(2, bytes.length, true);
  header.setUint32(10, 54, true);
  header.setUint32(14, 40, true);
  header.setInt32(18, size, true);
  header.setInt32(22, -size, true);
  header.setUint16(26, 1, true);
  header.setUint16(28, 24, true);
  header.setUint32(34, pixels, true);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tone = Math.round(
        29 + 5 * Math.sin(x / 23 + Math.sin(y / 31)) +
        4 * Math.cos(y / 19 - x / 43) + 2 * Math.sin((x + y) / 9)
      );
      const offset = 54 + (y * size + x) * 3;
      bytes[offset] = tone + 4;
      bytes[offset + 1] = tone + 1;
      bytes[offset + 2] = tone;
    }
  }
  return bytes;
}

/** Matches the padded-canvas zoompan coordinates used by the image exporter. */
export function getStillCamera(
  preset: KenBurnsPreset | undefined,
  progress: number,
  fitMode: ClipFitMode | undefined
): { zoom: number; x: number; y: number } {
  const p = Math.max(0, Math.min(1, progress));
  const loop =
    !preset || preset === 'none' ||
    (fitMode === 'fill-width' &&
      (preset === 'pan-top-to-bottom' || preset === 'pan-bottom-to-top')) ||
    (fitMode === 'fill-height' &&
      (preset === 'pan-left-to-right' || preset === 'pan-right-to-left'));
  if (loop) {
    return { zoom: 1, x: 0.5, y: 0.5 };
  }
  switch (preset) {
    case 'zoom-out': return { zoom: 1.18 - 0.18 * p, x: 0.5, y: 0.5 };
    case 'pan-top-to-bottom': return { zoom: 1.24, x: 0.5, y: p };
    case 'pan-bottom-to-top': return { zoom: 1.24, x: 0.5, y: 1 - p };
    case 'pan-left-to-right': return { zoom: 1.22, x: p, y: 0.5 };
    case 'pan-right-to-left': return { zoom: 1.22, x: 1 - p, y: 0.5 };
    case 'zoom-in-top-left': return { zoom: 1 + 0.24 * p, x: 0.15, y: 0.15 };
    case 'zoom-in-top-right': return { zoom: 1 + 0.24 * p, x: 0.85, y: 0.15 };
    case 'zoom-in-bottom': return { zoom: 1 + 0.24 * p, x: 0.5, y: 0.85 };
    default: return { zoom: 1 + 0.18 * p, x: 0.5, y: 0.5 };
  }
}
