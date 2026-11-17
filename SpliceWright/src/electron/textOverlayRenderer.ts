import { BrowserWindow } from 'electron';
import { rasterizeTextOverlay, TextOverlayBitmap } from '../shared/textOverlay';
import { TextOverlay } from '../shared/types';

export async function renderTextOverlayBitmaps(
  overlays: TextOverlay[], width: number, height: number
): Promise<TextOverlayBitmap[]> {
  const renderer = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, offscreen: true },
  });
  try {
    await renderer.loadURL('data:text/html;charset=utf-8,<html><body></body></html>');
    const result: unknown = await renderer.webContents.executeJavaScript(
      `(() => { try { return { bitmaps: (${JSON.stringify(overlays)}).map(overlay => ` +
      `(${rasterizeTextOverlay.toString()})(overlay, ${width}, ${height})) }; } ` +
      `catch (error) { return { error: error instanceof Error ? error.message : String(error) }; } })()`
    );
    if (typeof result === 'object' && result !== null && 'error' in result) {
      throw new Error(`Text overlay rendering failed: ${String(result.error)}`);
    }
    const isBitmap = (value: unknown): value is TextOverlayBitmap =>
      typeof value === 'object' && value !== null &&
      'dataUrl' in value && typeof value.dataUrl === 'string' &&
      value.dataUrl.startsWith('data:image/png;base64,') &&
      'width' in value && typeof value.width === 'number' && value.width > 0 &&
      'height' in value && typeof value.height === 'number' && value.height > 0;
    if (typeof result !== 'object' || result === null || !('bitmaps' in result) ||
      !Array.isArray(result.bitmaps) || result.bitmaps.length !== overlays.length ||
      !result.bitmaps.every(isBitmap)) {
      throw new Error('The text renderer returned invalid overlay images.');
    }
    return result.bitmaps;
  } finally {
    renderer.destroy();
  }
}
