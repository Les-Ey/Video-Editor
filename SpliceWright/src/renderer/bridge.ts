import { SpliceWrightApi } from '../shared/types';

declare global {
  interface Window {
    spliceWright: SpliceWrightApi;
  }
}

export function buildMediaUrl(
  projectRoot: string,
  relativePath: string,
  cacheVersion?: number | string
): string {
  const cleanRel = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  const cleanRoot = projectRoot.replace(/\\/g, '/').replace(/\/$/, '');
  const fullPath = `${cleanRoot}/${cleanRel}`;
  const suffix = cacheVersion ? `&v=${encodeURIComponent(String(cacheVersion))}` : '';
  return `media://local?path=${encodeURIComponent(fullPath)}${suffix}`;
}

export function formatTimecode(seconds: number): string {
  const safe = Math.max(0, seconds || 0);
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  const tenths = Math.floor((safe - Math.floor(safe)) * 10);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${tenths}`;
}
