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
