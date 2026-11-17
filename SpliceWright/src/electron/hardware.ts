import fs from 'fs';
import os from 'os';
import { spawn } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { HardwareProfile } from '../shared/types';

function resolveBinaryWithPermissions(bundledPath: string | null | undefined, fallbackCmd: string): string {
  if (bundledPath) {
    const unpacked = bundledPath.replace('app.asar', 'app.asar.unpacked');
    if (fs.existsSync(unpacked)) {
      if (process.platform !== 'win32') {
        try {
          fs.chmodSync(unpacked, 0o755);
        } catch {
          // Ignore if read-only filesystem
        }
      }
      return unpacked;
    }
  }
  // macOS Homebrew fallback paths when launched from Finder (where /opt/homebrew/bin may not be in PATH)
  if (process.platform === 'darwin') {
    for (const candidate of [`/opt/homebrew/bin/${fallbackCmd}`, `/usr/local/bin/${fallbackCmd}`]) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return fallbackCmd;
}

export function getFfmpegPath(): string {
  return resolveBinaryWithPermissions(ffmpegStatic, 'ffmpeg');
}

export function getFfprobePath(): string {
  return resolveBinaryWithPermissions(ffprobeStatic?.path, 'ffprobe');
}

export function hasAudioStream(filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ffprobe = getFfprobePath();
    const proc = spawn(ffprobe, [
      '-v',
      'error',
      '-select_streams',
      'a',
      '-show_entries',
      'stream=index',
      '-of',
      'csv=p=0',
      filePath,
    ]);
    let out = '';
    proc.stdout.on('data', (chunk) => {
      out += chunk.toString();
    });
    proc.on('close', () => {
      resolve(out.trim().length > 0);
    });
    proc.on('error', () => resolve(false));
  });
}

export async function probeMediaDuration(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    const ffprobe = getFfprobePath();
    const proc = spawn(ffprobe, [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);

    let output = '';
    proc.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    proc.on('close', () => {
      const parsed = parseFloat(output.trim());
      resolve(Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) / 100 : 5.0);
    });
    proc.on('error', () => {
      resolve(5.0);
    });
  });
}

export interface ProbedChapterMarker {
  id: string;
  title: string;
  startTimeSeconds: number;
  endTimeSeconds: number;
}

/**
 * Scenario 1 (Section 8): Losslessly remuxes an OBS `.mkv` recording to `.mp4` (`-map 0 -c copy`)
 * so HTML5 `<video>` preview and FFmpeg sub-clipping work seamlessly without re-encoding.
 */
/**
 * Extracts a single PNG frame from a video file at `timestampSec` (used when converting
 * a Standalone / OBS project into a SpliceWright Studio project with `scenes/<id>/first-frame.png`).
 */
export async function extractVideoFrameToPng(
  inputVideoPath: string,
  timestampSec: number,
  outputPngPath: string
): Promise<boolean> {
  return new Promise((resolve) => {
    const ffmpeg = getFfmpegPath();
    const safeSeek = Math.max(0, Math.round((timestampSec || 0) * 100) / 100);
    const proc = spawn(ffmpeg, [
      '-y',
      '-ss',
      String(safeSeek),
      '-i',
      inputVideoPath,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      outputPngPath,
    ]);
    proc.on('close', (code) => resolve(code === 0 && fs.existsSync(outputPngPath)));
    proc.on('error', () => resolve(false));
  });
}

export async function remuxMkvToMp4(inputMkvPath: string, outputMp4Path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = getFfmpegPath();
    const proc = spawn(ffmpeg, [
      '-y',
      '-i',
      inputMkvPath,
      '-map',
      '0',
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      outputMp4Path,
    ]);
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg MKV remux failed (${code}): ${stderr.slice(-400)}`));
      }
    });
    proc.on('error', (err) => reject(err));
  });
}

/**
 * Scenario 1 (Section 8): Inspects embedded OBS / MP4 / MKV chapter markers via `ffprobe -show_chapters`.
 */
export async function probeMediaChapters(filePath: string): Promise<ProbedChapterMarker[]> {
  return new Promise((resolve) => {
    const ffprobe = getFfprobePath();
    const proc = spawn(ffprobe, [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_chapters',
      filePath,
    ]);
    let output = '';
    proc.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    proc.on('close', () => {
      try {
        const parsed = JSON.parse(output) as {
          chapters?: Array<{
            id?: number | string;
            start_time?: string | number;
            end_time?: string | number;
            tags?: { title?: string };
          }>;
        };
        const rawChapters = parsed.chapters || [];
        const results: ProbedChapterMarker[] = [];
        rawChapters.forEach((ch, idx) => {
          const start = Math.round((parseFloat(String(ch.start_time ?? 0)) || 0) * 100) / 100;
          const end = Math.round((parseFloat(String(ch.end_time ?? 0)) || 0) * 100) / 100;
          if (end > start + 0.2) {
            results.push({
              id: String(ch.id ?? idx + 1),
              title: ch.tags?.title?.trim() || `Chapter ${idx + 1}`,
              startTimeSeconds: start,
              endTimeSeconds: end,
            });
          }
        });
        resolve(results);
      } catch {
        resolve([]);
      }
    });
    proc.on('error', () => resolve([]));
  });
}

let cachedHardwareProfile: HardwareProfile | null = null;

export async function detectHardwareProfile(): Promise<HardwareProfile> {
  if (cachedHardwareProfile) {
    return cachedHardwareProfile;
  }

  const cpuCores = os.cpus().length;
  const totalMemoryGb = Math.round((os.totalmem() / (1024 ** 3)) * 10) / 10;

  let tier: HardwareProfile['tier'] = 'mid-spec';
  let recommendedVideoPoolSize = 3;

  if (totalMemoryGb <= 10 || cpuCores <= 4) {
    tier = 'low-spec';
    recommendedVideoPoolSize = 2; // Active clip + 1 immediate next clip for $680 integrated-GPU laptops
  } else if (totalMemoryGb >= 24 && cpuCores >= 8) {
    tier = 'high-spec';
    recommendedVideoPoolSize = 4; // Deeper preload window for high-end rigs
  }

  const encodersOutput = await new Promise<string>((resolve) => {
    const proc = spawn(getFfmpegPath(), ['-hide_banner', '-encoders']);
    let out = '';
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.on('close', () => resolve(out));
    proc.on('error', () => resolve(''));
  });

  const candidateEncoders = [
    'h264_nvenc',
    'h264_videotoolbox',
    'h264_qsv',
    'h264_amf',
    'h264_mf',
    'libx264',
  ];
  const availableEncoders = candidateEncoders.filter((enc) => encodersOutput.includes(enc));
  if (!availableEncoders.includes('libx264')) {
    availableEncoders.push('libx264');
  }

  // Test which hardware encoder actually initializes on this machine
  let preferredEncoder = 'libx264';
  for (const enc of ['h264_nvenc', 'h264_videotoolbox', 'h264_qsv', 'h264_amf', 'h264_mf']) {
    if (availableEncoders.includes(enc)) {
      const works = await testEncoderWorks(enc);
      if (works) {
        preferredEncoder = enc;
        break;
      }
    }
  }

  cachedHardwareProfile = {
    cpuCores,
    totalMemoryGb,
    tier,
    recommendedVideoPoolSize,
    availableEncoders,
    preferredEncoder,
  };
  return cachedHardwareProfile;
}

async function testEncoderWorks(encoder: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(getFfmpegPath(), [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=256x144:d=0.1',
      '-c:v',
      encoder,
      '-f',
      'null',
      '-',
    ]);
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}
