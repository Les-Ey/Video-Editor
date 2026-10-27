import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import {
  ExportOptions,
  ExportProgressEvent,
  KenBurnsPreset,
  ProjectMediaAsset,
  StitchChaptersOptions,
  TimelineClip,
  VideoProjectManifest,
  VisualLookPreset,
} from '../shared/types';
import { getFfmpegPath } from './hardware';

function buildVisualLookVideoFilter(preset: VisualLookPreset | undefined): string {
  switch (preset) {
    case 'cinematic':
      return 'eq=contrast=1.08:saturation=1.12,colorbalance=rs=-0.04:bs=0.06:rh=0.06:bh=-0.04';
    case 'monochrome':
      return 'hue=s=0,eq=contrast=1.18:brightness=-0.02,vignette=PI/4';
    case 'vintage-film':
    case 'vintage-film-crackle':
      return 'hue=s=0.32,colorbalance=rs=0.12:gs=0.05:bs=-0.12,eq=contrast=1.12,noise=c0s=11:c0f=t+u,vignette=PI/4';
    case 'muted':
      return 'hue=s=0.58,eq=contrast=1.06';
    case 'none':
    default:
      return '';
  }
}

function buildImageKenBurnsFilter(
  preset: KenBurnsPreset | undefined,
  durationSec: number,
  width: number,
  height: number,
  fps: number,
  fallbackScalePadFilter: string
): { useZoomPan: boolean; vf: string } {
  if (!preset || preset === 'none') {
    return { useZoomPan: false, vf: fallbackScalePadFilter };
  }

  const totalFrames = Math.max(2, Math.round(durationSec * fps));
  const denom = Math.max(1, totalFrames - 1);
  // Pre-scale to 2x canvas for sub-pixel smooth zoompan coordinates
  const upW = width * 2;
  const upH = height * 2;
  const preScale = `scale=${upW}:${upH}:force_original_aspect_ratio=decrease,pad=${upW}:${upH}:(ow-iw)/2:(oh-ih)/2:color=black`;

  let zExpr = `'1+0.18*(on/${denom})'`;
  let xExpr = `'(iw-iw/zoom)/2'`;
  let yExpr = `'(ih-ih/zoom)/2'`;

  switch (preset) {
    case 'zoom-in':
      zExpr = `'1+0.18*(on/${denom})'`;
      xExpr = `'(iw-iw/zoom)/2'`;
      yExpr = `'(ih-ih/zoom)/2'`;
      break;
    case 'zoom-out':
      zExpr = `'1.18-0.18*(on/${denom})'`;
      xExpr = `'(iw-iw/zoom)/2'`;
      yExpr = `'(ih-ih/zoom)/2'`;
      break;
    case 'pan-top-to-bottom':
      zExpr = `'1.24'`;
      xExpr = `'(iw-iw/zoom)/2'`;
      yExpr = `'(ih-ih/zoom)*(on/${denom})'`;
      break;
    case 'pan-bottom-to-top':
      zExpr = `'1.24'`;
      xExpr = `'(iw-iw/zoom)/2'`;
      yExpr = `'(ih-ih/zoom)*(1-(on/${denom}))'`;
      break;
    case 'pan-left-to-right':
      zExpr = `'1.22'`;
      xExpr = `'(iw-iw/zoom)*(on/${denom})'`;
      yExpr = `'(ih-ih/zoom)/2'`;
      break;
    case 'pan-right-to-left':
      zExpr = `'1.22'`;
      xExpr = `'(iw-iw/zoom)*(1-(on/${denom}))'`;
      yExpr = `'(ih-ih/zoom)/2'`;
      break;
    case 'zoom-in-top-left':
      zExpr = `'1+0.24*(on/${denom})'`;
      xExpr = `'(iw-iw/zoom)*0.15'`;
      yExpr = `'(ih-ih/zoom)*0.15'`;
      break;
    case 'zoom-in-top-right':
      zExpr = `'1+0.24*(on/${denom})'`;
      xExpr = `'(iw-iw/zoom)*0.85'`;
      yExpr = `'(ih-ih/zoom)*0.15'`;
      break;
    case 'zoom-in-bottom':
      zExpr = `'1+0.24*(on/${denom})'`;
      xExpr = `'(iw-iw/zoom)/2'`;
      yExpr = `'(ih-ih/zoom)*0.85'`;
      break;
  }

  const zoompan = `zoompan=z=${zExpr}:x=${xExpr}:y=${yExpr}:d=${totalFrames}:s=${width}x${height}:fps=${fps}`;
  return {
    useZoomPan: true,
    vf: `${preScale},${zoompan},format=yuv420p`,
  };
}

function formatSrtTimestamp(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const hrs = Math.floor(clamped / 3600);
  const mins = Math.floor((clamped % 3600) / 60);
  const secs = Math.floor(clamped % 60);
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(
    2,
    '0'
  )},${String(Math.min(999, ms)).padStart(3, '0')}`;
}

export function generateSrtContent(project: VideoProjectManifest): string {
  const assetMap = new Map<string, ProjectMediaAsset>(project.assets.map((a) => [a.id, a]));
  const dialogueTrack = project.timeline.tracks.find((t) => t.type === 'dialogue');
  if (!dialogueTrack || dialogueTrack.muted) return '';

  const sortedClips = [...dialogueTrack.clips].sort((a, b) => a.timelineStart - b.timelineStart);
  const blocks: string[] = [];
  let idx = 1;

  for (const clip of sortedClips) {
    const asset = assetMap.get(clip.assetId);
    const text = asset?.dialogueText || clip.label;
    if (!text) continue;

    const start = clip.timelineStart;
    const duration = Math.max(0.2, clip.sourceOut - clip.sourceIn);
    const end = start + duration;
    const speakerPrefix = asset?.speaker ? `${asset.speaker}: ` : '';
    blocks.push(
      `${idx}\n${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}\n${speakerPrefix}${text}\n`
    );
    idx++;
  }

  return blocks.join('\n');
}

function runFfmpeg(args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = getFfmpegPath();
    const proc = spawn(ffmpeg, args, { cwd });
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-600)}`));
      }
    });
    proc.on('error', (err) => reject(err));
  });
}

function getEncoderArgs(encoder: string, preset: ExportOptions['preset']): string[] {
  if (encoder === 'h264_nvenc') {
    const p = preset === 'fast-draft' ? 'p1' : preset === 'high-quality' ? 'p6' : 'p4';
    return ['-c:v', 'h264_nvenc', '-preset', p, '-cq', preset === 'high-quality' ? '19' : '23'];
  }
  if (encoder === 'h264_videotoolbox') {
    const bitrate = preset === 'high-quality' ? '10M' : preset === 'fast-draft' ? '4M' : '6M';
    return ['-c:v', 'h264_videotoolbox', '-b:v', bitrate];
  }
  if (encoder === 'h264_qsv') {
    const p = preset === 'fast-draft' ? 'veryfast' : preset === 'high-quality' ? 'slow' : 'medium';
    return ['-c:v', 'h264_qsv', '-preset', p];
  }
  if (encoder === 'h264_amf') {
    return ['-c:v', 'h264_amf', '-quality', preset === 'fast-draft' ? 'speed' : 'balanced'];
  }
  if (encoder === 'h264_mf') {
    return ['-c:v', 'h264_mf', '-b:v', preset === 'high-quality' ? '8M' : '5M'];
  }
  const cpuPreset =
    preset === 'fast-draft' ? 'ultrafast' : preset === 'high-quality' ? 'medium' : 'veryfast';
  const crf = preset === 'fast-draft' ? '26' : preset === 'high-quality' ? '18' : '22';
  return ['-c:v', 'libx264', '-preset', cpuPreset, '-crf', crf];
}

/**
 * Renders the full timeline to `exports/<outputFileName>` using a portable scratch directory
 * on the project drive (`exports/.temp/`) so an internal C: drive is never filled up.
 */
export async function renderProjectWithFfmpeg(
  projectRoot: string,
  project: VideoProjectManifest,
  options: ExportOptions,
  onProgress: (ev: ExportProgressEvent) => void
): Promise<{ outputPath: string; srtPath?: string; fcpxmlPath?: string }> {
  const exportsDir = path.join(projectRoot, 'exports');
  const tempDir = path.join(exportsDir, '.temp');
  fs.mkdirSync(exportsDir, { recursive: true });
  fs.mkdirSync(tempDir, { recursive: true });

  const cleanFileName = options.outputFileName.endsWith('.mp4')
    ? options.outputFileName
    : `${options.outputFileName}.mp4`;
  const finalOutputPath = path.join(exportsDir, cleanFileName);

  const { width, height, fps } = project.format;
  const assetMap = new Map<string, ProjectMediaAsset>(project.assets.map((a) => [a.id, a]));

  try {
    onProgress({
      phase: 'preparing',
      percent: 5,
      message: 'Preparing timeline segments and scratch directory on project drive...',
    });

    // 1. Export .srt file if requested
    let srtPath: string | undefined;
    const srtContent = generateSrtContent(project);
    if ((options.exportSrtFile || options.burnSubtitles) && srtContent.trim().length > 0) {
      srtPath = finalOutputPath.replace(/\.mp4$/i, '.srt');
      fs.writeFileSync(srtPath, srtContent, 'utf-8');
    }

    // 1b. Export FCPXML (.fcpxml) for DaVinci Resolve / Premiere Pro / Final Cut Pro if requested
    let fcpxmlPath: string | undefined;
    if (options.exportFcpxml) {
      fcpxmlPath = finalOutputPath.replace(/\.mp4$/i, '.fcpxml');
      const fcpxmlContent = generateFcpxmlContent(projectRoot, project);
      fs.writeFileSync(fcpxmlPath, fcpxmlContent, 'utf-8');
    }

    // 2. Calculate total timeline duration across all unmuted tracks
    let totalDuration = 0;
    for (const track of project.timeline.tracks) {
      if (track.muted) continue;
      for (const clip of track.clips) {
        const end = clip.timelineStart + Math.max(0.1, clip.sourceOut - clip.sourceIn);
        if (end > totalDuration) totalDuration = end;
      }
    }
    totalDuration = Math.max(1, Math.round(totalDuration * 100) / 100);

    // 3. Build normalized video segments (with black gap fillers if there are timeline gaps)
    const videoTrack = project.timeline.tracks.find((t) => t.type === 'video');
    const sortedVideoClips: TimelineClip[] =
      videoTrack && !videoTrack.muted
        ? [...videoTrack.clips].sort((a, b) => a.timelineStart - b.timelineStart)
        : [];

    interface VideoSegmentSpec {
      kind: 'black' | 'clip';
      duration: number;
      clip?: TimelineClip;
      asset?: ProjectMediaAsset;
    }

    const segments: VideoSegmentSpec[] = [];
    let cursor = 0;

    for (const clip of sortedVideoClips) {
      const asset = assetMap.get(clip.assetId);
      const fullPath = asset ? path.join(projectRoot, asset.relativePath) : '';
      const clipDuration = Math.max(0.1, Math.round((clip.sourceOut - clip.sourceIn) * 100) / 100);

      if (clip.timelineStart > cursor + 0.05) {
        segments.push({
          kind: 'black',
          duration: Math.round((clip.timelineStart - cursor) * 100) / 100,
        });
        cursor = clip.timelineStart;
      }

      if (asset && fs.existsSync(fullPath)) {
        segments.push({
          kind: 'clip',
          duration: clipDuration,
          clip,
          asset,
        });
      } else {
        segments.push({
          kind: 'black',
          duration: clipDuration,
        });
      }
      cursor = Math.round((cursor + clipDuration) * 100) / 100;
    }

    if (cursor < totalDuration - 0.05 || segments.length === 0) {
      segments.push({
        kind: 'black',
        duration: Math.max(0.5, Math.round((totalDuration - cursor) * 100) / 100),
      });
    }

    // Render each video segment to uniform resolution/fps/pixel-format in `exports/.temp/`
    const segmentFiles: string[] = [];
    const lookVf = buildVisualLookVideoFilter(project.lookPreset);
    const scalePadFilter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${fps}${
      lookVf ? `,${lookVf}` : ''
    },format=yuv420p`;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const segFile = path.join(tempDir, `seg_${String(i).padStart(4, '0')}.mp4`);
      const pct = 10 + Math.round(((i + 1) / segments.length) * 50);

      onProgress({
        phase: 'rendering-video',
        percent: pct,
        message: `Rendering video segment ${i + 1} of ${segments.length}...`,
      });

      if (seg.kind === 'black' || !seg.asset || !seg.clip) {
        await runFfmpeg([
          '-y',
          '-f',
          'lavfi',
          '-i',
          `color=c=black:s=${width}x${height}:r=${fps}:d=${seg.duration}`,
          '-vf',
          'format=yuv420p',
          ...getEncoderArgs(options.encoder, options.preset),
          '-an',
          segFile,
        ]);
      } else {
        const assetFullPath = path.join(projectRoot, seg.asset.relativePath);
        if (seg.asset.kind === 'image' || seg.asset.isPosterFallback) {
          const kb = buildImageKenBurnsFilter(
            seg.clip.kenBurns,
            seg.duration,
            width,
            height,
            fps,
            scalePadFilter
          );
          if (kb.useZoomPan) {
            const kbWithLook = lookVf
              ? kb.vf.replace(/,format=yuv420p$/, `,${lookVf},format=yuv420p`)
              : kb.vf;
            await runFfmpeg([
              '-y',
              '-i',
              assetFullPath,
              '-vf',
              kbWithLook,
              '-t',
              String(seg.duration),
              ...getEncoderArgs(options.encoder, options.preset),
              '-an',
              segFile,
            ]);
          } else {
            await runFfmpeg([
              '-y',
              '-loop',
              '1',
              '-i',
              assetFullPath,
              '-t',
              String(seg.duration),
              '-vf',
              scalePadFilter,
              ...getEncoderArgs(options.encoder, options.preset),
              '-an',
              segFile,
            ]);
          }
        } else {
          await runFfmpeg([
            '-y',
            '-ss',
            String(seg.clip.sourceIn),
            '-t',
            String(seg.duration),
            '-i',
            assetFullPath,
            '-vf',
            scalePadFilter,
            ...getEncoderArgs(options.encoder, options.preset),
            '-an',
            segFile,
          ]);
        }
      }
      segmentFiles.push(segFile);
    }

    // Concatenate normalized video segments
    const concatListPath = path.join(tempDir, 'concat_list.txt');
    const concatLines = segmentFiles.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
    fs.writeFileSync(concatListPath, concatLines.join('\n'), 'utf-8');

    const stitchedVideoPath = path.join(tempDir, 'stitched_video.mp4');
    await runFfmpeg([
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      concatListPath,
      '-c',
      'copy',
      stitchedVideoPath,
    ]);

    // 4. Mix all audio tracks (Dialogue, SFX, and BGM with optional auto-ducking)
    onProgress({
      phase: 'mixing-audio',
      percent: 72,
      message: 'Mixing multi-track audio (Dialogue, SFX, Backing Music & Auto-Ducking)...',
    });

    interface AudioInputEntry {
      filePath: string;
      clip: TimelineClip;
      trackVolume: number;
      trackType: string;
      isNormalized: boolean;
    }

    const audioEntries: AudioInputEntry[] = [];
    const dialogueIntervals: Array<{ start: number; end: number }> = [];

    for (const track of project.timeline.tracks) {
      if (track.type === 'video' || track.muted) continue;
      for (const clip of track.clips) {
        const asset = assetMap.get(clip.assetId);
        if (!asset) continue;
        const fullPath = path.join(projectRoot, asset.relativePath);
        if (!fs.existsSync(fullPath)) continue;

        const dur = Math.max(0.1, clip.sourceOut - clip.sourceIn);
        if (track.type === 'dialogue') {
          dialogueIntervals.push({
            start: clip.timelineStart,
            end: clip.timelineStart + dur,
          });
        }
        audioEntries.push({
          filePath: fullPath,
          clip,
          trackVolume: track.volume,
          trackType: track.type,
          isNormalized: Boolean(asset.isNormalized),
        });
      }
    }

    const mixedAudioPath = path.join(tempDir, 'mixed_audio.aac');

    if (audioEntries.length === 0) {
      await runFfmpeg([
        '-y',
        '-f',
        'lavfi',
        '-i',
        `anullsrc=channel_layout=stereo:sample_rate=44100`,
        '-t',
        String(totalDuration),
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        mixedAudioPath,
      ]);
    } else {
      // Sort and merge overlapping dialogue intervals so auto-duck expressions stay compact on 1–10+ min movies
      const sortedIntervals = [...dialogueIntervals].sort((a, b) => a.start - b.start);
      const mergedDialogueIntervals: Array<{ start: number; end: number }> = [];
      for (const iv of sortedIntervals) {
        const last = mergedDialogueIntervals[mergedDialogueIntervals.length - 1];
        if (last && iv.start <= last.end + 0.35) {
          last.end = Math.max(last.end, iv.end);
        } else {
          mergedDialogueIntervals.push({ ...iv });
        }
      }

      // Render audio in chunks of up to 16 inputs using `-filter_complex_script` so multi-minute movies
      // with 50+ clips never hit Windows command-line limits or FFmpeg amix bottlenecks.
      const CHUNK_SIZE = 16;
      const chunkStemFiles: string[] = [];

      for (let cIdx = 0; cIdx < audioEntries.length; cIdx += CHUNK_SIZE) {
        const chunk = audioEntries.slice(cIdx, cIdx + CHUNK_SIZE);
        const isSingleChunk = audioEntries.length <= CHUNK_SIZE;
        const chunkOutPath = isSingleChunk
          ? mixedAudioPath
          : path.join(tempDir, `audio_stem_${Math.floor(cIdx / CHUNK_SIZE)}.wav`);

        const ffmpegAudioArgs: string[] = [
          '-y',
          '-f',
          'lavfi',
          '-t',
          String(totalDuration),
          '-i',
          'anullsrc=channel_layout=stereo:sample_rate=44100',
        ];

        for (const entry of chunk) {
          ffmpegAudioArgs.push('-i', entry.filePath);
        }

        const filterParts: string[] = [];
        const mixLabels: string[] = ['[0:a]'];

        chunk.forEach((entry, index) => {
          const inputIdx = index + 1;
          const clip = entry.clip;
          const clipDur = Math.max(0.1, Math.round((clip.sourceOut - clip.sourceIn) * 100) / 100);
          const clipEnd = clip.timelineStart + clipDur;
          const delayMs = Math.max(0, Math.round(clip.timelineStart * 1000));
          const baseGain = Math.max(0, Math.min(2, entry.trackVolume * (clip.volume ?? 1.0)));

          const chain: string[] = [
            `atrim=start=${clip.sourceIn}:end=${clip.sourceOut}`,
            `asetpts=PTS-STARTPTS`,
          ];

          // Topic 12: Vintage Projector / Old Radio band-pass + dynamic range compression
          if (project.lookPreset === 'vintage-film-crackle') {
            chain.push('highpass=f=320,lowpass=f=3200,acompressor=threshold=-18dB:ratio=3:makeup=2');
          }

          // Dynamic narration/dialogue leveling: fixes ElevenLabs clips that trail off soft or jump in loud
          if (
            entry.trackType === 'dialogue' &&
            project.normalizeDialogueAudio !== false &&
            !entry.isNormalized
          ) {
            chain.push(`dynaudnorm=f=150:g=11:p=0.92:m=6`);
          }

          // Auto-duck music under active dialogue intervals that overlap this music clip
          const overlappingIntervals = mergedDialogueIntervals.filter(
            (iv) => iv.end >= clip.timelineStart && iv.start <= clipEnd
          );

          if (
            entry.trackType === 'music' &&
            project.autoDuckMusicUnderDialogue &&
            overlappingIntervals.length > 0
          ) {
            const betweenChecks = overlappingIntervals
              .map((iv) => {
                const localStart = Math.max(
                  0,
                  Math.round((iv.start - clip.timelineStart - 0.15) * 100) / 100
                );
                const localEnd = Math.max(
                  0,
                  Math.round((iv.end - clip.timelineStart + 0.25) * 100) / 100
                );
                return `between(t,${localStart},${localEnd})`;
              })
              .join('+');
            const duckedGain =
              Math.round(baseGain * (project.duckingVolumeRatio || 0.25) * 1000) / 1000;
            const normalGain = Math.round(baseGain * 1000) / 1000;
            chain.push(`volume='if(gt(${betweenChecks},0),${duckedGain},${normalGain})':eval=frame`);
          } else {
            chain.push(`volume=${Math.round(baseGain * 1000) / 1000}`);
          }

          if (clip.fadeIn && clip.fadeIn > 0) {
            chain.push(`afade=t=in:st=0:d=${Math.min(clip.fadeIn, clipDur)}`);
          }
          if (clip.fadeOut && clip.fadeOut > 0) {
            const fadeOutStart = Math.max(0, clipDur - clip.fadeOut);
            chain.push(`afade=t=out:st=${fadeOutStart}:d=${Math.min(clip.fadeOut, clipDur)}`);
          }

          chain.push(`adelay=${delayMs}|${delayMs}`);
          const label = `[aud${inputIdx}]`;
          filterParts.push(`[${inputIdx}:a]${chain.join(',')}${label}`);
          mixLabels.push(label);
        });

        filterParts.push(
          `${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=first:dropout_transition=0:normalize=0[aout]`
        );

        const filterScriptPath = path.join(
          tempDir,
          `audio_filter_${Math.floor(cIdx / CHUNK_SIZE)}.txt`
        );
        fs.writeFileSync(filterScriptPath, filterParts.join(';\n'), 'utf-8');

        if (isSingleChunk) {
          ffmpegAudioArgs.push(
            '-filter_complex_script',
            filterScriptPath,
            '-map',
            '[aout]',
            '-t',
            String(totalDuration),
            '-c:a',
            'aac',
            '-b:a',
            '192k',
            chunkOutPath
          );
        } else {
          ffmpegAudioArgs.push(
            '-filter_complex_script',
            filterScriptPath,
            '-map',
            '[aout]',
            '-t',
            String(totalDuration),
            '-c:a',
            'pcm_s16le',
            chunkOutPath
          );
          chunkStemFiles.push(chunkOutPath);
        }

        await runFfmpeg(ffmpegAudioArgs);
      }

      // If multiple chunk stems were rendered, mix them into the final AAC master
      if (chunkStemFiles.length > 0) {
        const finalMixArgs: string[] = ['-y'];
        const stemLabels: string[] = [];
        chunkStemFiles.forEach((stemPath, idx) => {
          finalMixArgs.push('-i', stemPath);
          stemLabels.push(`[${idx}:a]`);
        });
        finalMixArgs.push(
          '-filter_complex',
          `${stemLabels.join('')}amix=inputs=${chunkStemFiles.length}:duration=longest:dropout_transition=0:normalize=0[aout]`,
          '-map',
          '[aout]',
          '-t',
          String(totalDuration),
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          mixedAudioPath
        );
        await runFfmpeg(finalMixArgs);
      }
    }

    // 5. Multiplex stitched video + mixed audio into final `.mp4` in `exports/`
    onProgress({
      phase: 'finalizing',
      percent: 90,
      message: 'Finalizing MP4 container into exports/ folder...',
    });

    await runFfmpeg([
      '-y',
      '-i',
      stitchedVideoPath,
      '-i',
      mixedAudioPath,
      '-c:v',
      'copy',
      '-c:a',
      'copy',
      '-movflags',
      '+faststart',
      '-shortest',
      finalOutputPath,
    ]);

    onProgress({
      phase: 'complete',
      percent: 100,
      message: `Export complete: ${cleanFileName}`,
      outputPath: finalOutputPath,
      srtPath,
      fcpxmlPath,
    });

    return { outputPath: finalOutputPath, srtPath, fcpxmlPath };
  } finally {
    // Clean up temporary render files on the project drive
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Computes a deterministic signature of all audio tracks, clips, volumes, fades, and auto-ducking
 * settings so the editor knows whether `exports/.cache/preview-audio-mix.mp3` is still up-to-date.
 */
export function computeAudioTimelineSignature(project: VideoProjectManifest): string {
  const parts: string[] = [
    `duck:${project.autoDuckMusicUnderDialogue ? project.duckingVolumeRatio : 0}`,
    `norm:${project.normalizeDialogueAudio !== false ? 1 : 0}`,
  ];
  const assetMap = new Map<string, ProjectMediaAsset>(project.assets.map((a) => [a.id, a]));
  for (const track of project.timeline.tracks) {
    if (track.type === 'video') continue;
    parts.push(`tr:${track.id}:${track.muted ? 'M' : track.volume}`);
    for (const c of track.clips) {
      const asset = assetMap.get(c.assetId);
      parts.push(
        `c:${c.id}:${asset?.relativePath || c.assetId}:${c.timelineStart}:${c.sourceIn}:${
          c.sourceOut
        }:${c.volume}:${c.fadeIn || 0}:${c.fadeOut || 0}`
      );
    }
  }
  return parts.join('|');
}

/**
 * Topic 6: Pre-mixes all audio tracks (Dialogue, SFX, BGM + Auto-Ducking + Fades + Normalization)
 * into a single invisible master `.mp3` (`exports/.cache/preview-audio-mix.mp3`) for ultra-smooth
 * live preview playback on projects with many audio clips.
 */
export async function renderPreviewAudioMixToMp3(
  projectRoot: string,
  project: VideoProjectManifest
): Promise<{ project: VideoProjectManifest; mixRelativePath: string }> {
  const cacheDir = path.join(projectRoot, 'exports', '.cache');
  const tempDir = path.join(cacheDir, '.temp');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(tempDir, { recursive: true });

  const mixRelPath = 'exports/.cache/preview-audio-mix.mp3';
  const mixFullPath = path.join(projectRoot, 'exports', '.cache', 'preview-audio-mix.mp3');
  const assetMap = new Map<string, ProjectMediaAsset>(project.assets.map((a) => [a.id, a]));

  let totalDuration = 5;
  for (const track of project.timeline.tracks) {
    if (track.muted) continue;
    for (const clip of track.clips) {
      const end = clip.timelineStart + Math.max(0.1, clip.sourceOut - clip.sourceIn);
      if (end > totalDuration) totalDuration = end;
    }
  }
  totalDuration = Math.max(1, Math.round(totalDuration * 100) / 100);

  interface AudioEntry {
    filePath: string;
    clip: TimelineClip;
    trackVolume: number;
    trackType: string;
    isNormalized: boolean;
  }

  const audioEntries: AudioEntry[] = [];
  const dialogueIntervals: Array<{ start: number; end: number }> = [];

  for (const track of project.timeline.tracks) {
    if (track.type === 'video' || track.muted) continue;
    for (const clip of track.clips) {
      const asset = assetMap.get(clip.assetId);
      if (!asset) continue;
      const fullPath = path.join(projectRoot, asset.relativePath);
      if (!fs.existsSync(fullPath)) continue;

      const dur = Math.max(0.1, clip.sourceOut - clip.sourceIn);
      if (track.type === 'dialogue') {
        dialogueIntervals.push({ start: clip.timelineStart, end: clip.timelineStart + dur });
      }
      audioEntries.push({
        filePath: fullPath,
        clip,
        trackVolume: track.volume,
        trackType: track.type,
        isNormalized: Boolean(asset.isNormalized),
      });
    }
  }

  try {
    if (audioEntries.length === 0) {
      await runFfmpeg([
        '-y',
        '-f',
        'lavfi',
        '-i',
        'anullsrc=channel_layout=stereo:sample_rate=44100',
        '-t',
        String(totalDuration),
        '-c:a',
        'libmp3lame',
        '-b:a',
        '192k',
        mixFullPath,
      ]);
    } else {
      const sortedIntervals = [...dialogueIntervals].sort((a, b) => a.start - b.start);
      const mergedDialogueIntervals: Array<{ start: number; end: number }> = [];
      for (const iv of sortedIntervals) {
        const last = mergedDialogueIntervals[mergedDialogueIntervals.length - 1];
        if (last && iv.start <= last.end + 0.35) {
          last.end = Math.max(last.end, iv.end);
        } else {
          mergedDialogueIntervals.push({ ...iv });
        }
      }

      const CHUNK_SIZE = 16;
      const chunkStemFiles: string[] = [];

      for (let cIdx = 0; cIdx < audioEntries.length; cIdx += CHUNK_SIZE) {
        const chunk = audioEntries.slice(cIdx, cIdx + CHUNK_SIZE);
        const isSingleChunk = audioEntries.length <= CHUNK_SIZE;
        const chunkOutPath = isSingleChunk
          ? mixFullPath
          : path.join(tempDir, `premix_stem_${Math.floor(cIdx / CHUNK_SIZE)}.wav`);

        const args: string[] = [
          '-y',
          '-f',
          'lavfi',
          '-t',
          String(totalDuration),
          '-i',
          'anullsrc=channel_layout=stereo:sample_rate=44100',
        ];
        for (const entry of chunk) {
          args.push('-i', entry.filePath);
        }

        const filterParts: string[] = [];
        const mixLabels: string[] = ['[0:a]'];

        chunk.forEach((entry, index) => {
          const inputIdx = index + 1;
          const clip = entry.clip;
          const clipDur = Math.max(0.1, Math.round((clip.sourceOut - clip.sourceIn) * 100) / 100);
          const clipEnd = clip.timelineStart + clipDur;
          const delayMs = Math.max(0, Math.round(clip.timelineStart * 1000));
          const baseGain = Math.max(0, Math.min(2, entry.trackVolume * (clip.volume ?? 1.0)));

          const chain: string[] = [
            `atrim=start=${clip.sourceIn}:end=${clip.sourceOut}`,
            `asetpts=PTS-STARTPTS`,
          ];

          if (
            entry.trackType === 'dialogue' &&
            project.normalizeDialogueAudio !== false &&
            !entry.isNormalized
          ) {
            chain.push(`dynaudnorm=f=150:g=11:p=0.92:m=6`);
          }

          const overlappingIntervals = mergedDialogueIntervals.filter(
            (iv) => iv.end >= clip.timelineStart && iv.start <= clipEnd
          );

          if (
            entry.trackType === 'music' &&
            project.autoDuckMusicUnderDialogue &&
            overlappingIntervals.length > 0
          ) {
            const betweenChecks = overlappingIntervals
              .map((iv) => {
                const localStart = Math.max(
                  0,
                  Math.round((iv.start - clip.timelineStart - 0.15) * 100) / 100
                );
                const localEnd = Math.max(
                  0,
                  Math.round((iv.end - clip.timelineStart + 0.25) * 100) / 100
                );
                return `between(t,${localStart},${localEnd})`;
              })
              .join('+');
            const duckedGain =
              Math.round(baseGain * (project.duckingVolumeRatio || 0.25) * 1000) / 1000;
            const normalGain = Math.round(baseGain * 1000) / 1000;
            chain.push(`volume='if(gt(${betweenChecks},0),${duckedGain},${normalGain})':eval=frame`);
          } else {
            chain.push(`volume=${Math.round(baseGain * 1000) / 1000}`);
          }

          if (clip.fadeIn && clip.fadeIn > 0) {
            chain.push(`afade=t=in:st=0:d=${Math.min(clip.fadeIn, clipDur)}`);
          }
          if (clip.fadeOut && clip.fadeOut > 0) {
            const fadeOutStart = Math.max(0, clipDur - clip.fadeOut);
            chain.push(`afade=t=out:st=${fadeOutStart}:d=${Math.min(clip.fadeOut, clipDur)}`);
          }

          chain.push(`adelay=${delayMs}|${delayMs}`);
          const label = `[aud${inputIdx}]`;
          filterParts.push(`[${inputIdx}:a]${chain.join(',')}${label}`);
          mixLabels.push(label);
        });

        filterParts.push(
          `${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=first:dropout_transition=0:normalize=0[aout]`
        );

        const filterScriptPath = path.join(
          tempDir,
          `premix_filter_${Math.floor(cIdx / CHUNK_SIZE)}.txt`
        );
        fs.writeFileSync(filterScriptPath, filterParts.join(';\n'), 'utf-8');

        if (isSingleChunk) {
          args.push(
            '-filter_complex_script',
            filterScriptPath,
            '-map',
            '[aout]',
            '-t',
            String(totalDuration),
            '-c:a',
            'libmp3lame',
            '-b:a',
            '192k',
            chunkOutPath
          );
        } else {
          args.push(
            '-filter_complex_script',
            filterScriptPath,
            '-map',
            '[aout]',
            '-t',
            String(totalDuration),
            '-c:a',
            'pcm_s16le',
            chunkOutPath
          );
          chunkStemFiles.push(chunkOutPath);
        }

        await runFfmpeg(args);
      }

      if (chunkStemFiles.length > 0) {
        const finalMixArgs: string[] = ['-y'];
        const stemLabels: string[] = [];
        chunkStemFiles.forEach((stemPath, idx) => {
          finalMixArgs.push('-i', stemPath);
          stemLabels.push(`[${idx}:a]`);
        });
        finalMixArgs.push(
          '-filter_complex',
          `${stemLabels.join('')}amix=inputs=${chunkStemFiles.length}:duration=longest:dropout_transition=0:normalize=0[aout]`,
          '-map',
          '[aout]',
          '-t',
          String(totalDuration),
          '-c:a',
          'libmp3lame',
          '-b:a',
          '192k',
          mixFullPath
        );
        await runFfmpeg(finalMixArgs);
      }
    }
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }

  const updated: VideoProjectManifest = JSON.parse(JSON.stringify(project));
  updated.preMixedAudioRelativePath = mixRelPath;
  updated.preMixedAudioSignature = computeAudioTimelineSignature(updated);
  return { project: updated, mixRelativePath: mixRelPath };
}

/**
 * Normalises audio clips in the project, writing leveled files into
 * `assets/audio/normalized/` while keeping the original files strictly Read-Only.
 *
 * - Dialogue / Narration: `dynaudnorm=f=125:g=7:p=0.90:m=6` (lifts soft sentence endings & tames jumps)
 * - SFX (when `includeSfxAndMusic` is true): `dynaudnorm=f=200:g=5:p=0.92:m=4` (balances peak SFX loudness)
 * - Music / BGM (when `includeSfxAndMusic` is true): `loudnorm=I=-16:TP=-1.5:LRA=11` (EBU R128 integrated loudness matching so songs match in volume without flattening musical dynamics)
 */
export async function normalizeDialogueClipsInProject(
  projectRoot: string,
  project: VideoProjectManifest,
  includeSfxAndMusic: boolean = false
): Promise<{ project: VideoProjectManifest; normalizedCount: number }> {
  const updated: VideoProjectManifest = JSON.parse(JSON.stringify(project));
  const normDir = path.join(projectRoot, 'assets', 'audio', 'normalized');
  fs.mkdirSync(normDir, { recursive: true });

  let normalizedCount = 0;

  for (const asset of updated.assets) {
    const isTarget =
      asset.kind === 'dialogue' ||
      (includeSfxAndMusic && (asset.kind === 'sfx' || asset.kind === 'music'));
    if (!isTarget) continue;

    const sourceRel = asset.originalRelativePath || asset.relativePath;
    const sourceFull = path.join(projectRoot, sourceRel);
    if (!fs.existsSync(sourceFull)) continue;

    const safeId = asset.id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const outFileName = `${safeId}_norm.mp3`;
    const outFull = path.join(normDir, outFileName);
    const outRel = `assets/audio/normalized/${outFileName}`;

    const audioFilter =
      asset.kind === 'dialogue'
        ? 'dynaudnorm=f=125:g=7:p=0.90:m=6'
        : asset.kind === 'sfx'
        ? 'dynaudnorm=f=200:g=5:p=0.92:m=4'
        : 'loudnorm=I=-16:TP=-1.5:LRA=11';

    await runFfmpeg([
      '-y',
      '-i',
      sourceFull,
      '-af',
      audioFilter,
      '-c:a',
      'libmp3lame',
      '-b:a',
      '192k',
      outFull,
    ]);

    asset.originalRelativePath = sourceRel;
    asset.relativePath = outRel;
    asset.isNormalized = true;
    if (!asset.label.includes('[Norm]')) {
      asset.label = `[Norm] ${asset.label}`;
    }
    normalizedCount++;
  }

  // Ensure dialogue track clips use unity 1.0 volume and enable project-wide normalization flag
  const dlgTrack = updated.timeline.tracks.find((t) => t.type === 'dialogue');
  if (dlgTrack) {
    for (const clip of dlgTrack.clips) {
      clip.volume = 1.0;
    }
  }
  updated.normalizeDialogueAudio = true;

  return { project: updated, normalizedCount };
}

/**
 * Topic 7: Generates a standard Final Cut Pro XML (`.fcpxml` v1.9) timeline file that opens
 * directly in DaVinci Resolve, Adobe Premiere Pro, or Final Cut Pro for pro color grading / finishing.
 */
export function generateFcpxmlContent(projectRoot: string, project: VideoProjectManifest): string {
  const { width, height, fps } = project.format;
  const assetMap = new Map<string, ProjectMediaAsset>(project.assets.map((a) => [a.id, a]));
  const esc = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  let totalDuration = 5;
  for (const tr of project.timeline.tracks) {
    for (const c of tr.clips) {
      const end = c.timelineStart + Math.max(0.1, c.sourceOut - c.sourceIn);
      if (end > totalDuration) totalDuration = end;
    }
  }

  const toRational = (sec: number) => `${Math.round(sec * fps * 100)}/${fps * 100}s`;

  const resourceLines: string[] = [
    `    <format id="r1" name="FFVideoFormat${height}p${fps}" frameDuration="100/${fps * 100}s" width="${width}" height="${height}"/>`,
  ];

  const assetResIdMap = new Map<string, string>();
  let resIdx = 2;
  for (const asset of project.assets) {
    if (asset.isPlaceholderSlate) continue;
    const fullPath = path.resolve(projectRoot, asset.relativePath).replace(/\\/g, '/');
    const fileUrl = `file:///${fullPath.replace(/^\/+/, '')}`;
    const rId = `r${resIdx++}`;
    assetResIdMap.set(asset.id, rId);
    const hasVideo = asset.kind === 'video' || asset.kind === 'image' ? '1' : '0';
    const hasAudio = asset.kind !== 'image' ? '1' : '0';
    resourceLines.push(
      `    <asset id="${rId}" name="${esc(asset.label)}" src="${esc(fileUrl)}" start="0s" duration="${toRational(
        Math.max(1, asset.durationSeconds)
      )}" hasVideo="${hasVideo}" hasAudio="${hasAudio}" format="r1"/>`
    );
  }

  const spineClips: string[] = [];
  const videoTrack = project.timeline.tracks.find((t) => t.type === 'video');
  const sortedVidClips = videoTrack
    ? [...videoTrack.clips].sort((a, b) => a.timelineStart - b.timelineStart)
    : [];

  for (const clip of sortedVidClips) {
    const rId = assetResIdMap.get(clip.assetId);
    if (!rId) continue;
    const dur = Math.max(0.1, clip.sourceOut - clip.sourceIn);
    spineClips.push(
      `            <asset-clip name="${esc(clip.label)}" ref="${rId}" offset="${toRational(
        clip.timelineStart
      )}" start="${toRational(clip.sourceIn)}" duration="${toRational(dur)}"/>`
    );
  }

  // Attach audio clips as lane items
  let laneCounter = 1;
  for (const track of project.timeline.tracks) {
    if (track.type === 'video' || track.muted) continue;
    for (const clip of track.clips) {
      const rId = assetResIdMap.get(clip.assetId);
      if (!rId) continue;
      const dur = Math.max(0.1, clip.sourceOut - clip.sourceIn);
      spineClips.push(
        `            <asset-clip name="${esc(clip.label)}" ref="${rId}" lane="-${laneCounter}" offset="${toRational(
          clip.timelineStart
        )}" start="${toRational(clip.sourceIn)}" duration="${toRational(dur)}" role="${esc(track.type)}"/>`
      );
    }
    laneCounter++;
  }

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE fcpxml>`,
    `<fcpxml version="1.9">`,
    `  <resources>`,
    ...resourceLines,
    `  </resources>`,
    `  <library>`,
    `    <event name="${esc(project.title)}">`,
    `      <project name="${esc(project.title)}">`,
    `        <sequence format="r1" duration="${toRational(totalDuration)}" tcStart="0s" tcFormat="NDF">`,
    `          <spine>`,
    ...spineClips,
    `          </spine>`,
    `        </sequence>`,
    `      </project>`,
    `    </event>`,
    `  </library>`,
    `</fcpxml>`,
  ].join('\n');
}

function parseSrtTimeToSeconds(tc: string): number {
  const m = tc.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return 0;
  return (
    parseInt(m[1], 10) * 3600 +
    parseInt(m[2], 10) * 60 +
    parseInt(m[3], 10) +
    parseInt(m[4].padEnd(3, '0').slice(0, 3), 10) / 1000
  );
}

/**
 * Topic 11: Stitches multiple rendered chapter/reel `.mp4` files into a single long-form movie
 * (e.g. 20 minutes to 1+ hour) using fast lossless stream copy (`-c copy`) when possible,
 * with optional black transition spacers and automatic `.srt` subtitle timecode shifting & merging.
 */
export async function stitchVideoChaptersWithFfmpeg(
  options: StitchChaptersOptions,
  onProgress: (ev: ExportProgressEvent) => void
): Promise<{ outputPath: string; srtPath?: string; totalDurationSeconds: number }> {
  const validItems = options.items.filter((i) => fs.existsSync(i.filePath));
  if (validItems.length === 0) {
    throw new Error('No valid MP4 chapter files selected to stitch.');
  }

  const outFull = options.outputFilePath.endsWith('.mp4')
    ? options.outputFilePath
    : `${options.outputFilePath}.mp4`;
  const outDir = path.dirname(outFull);
  const tempDir = path.join(outDir, '.stitch-temp');
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(tempDir, { recursive: true });

  const spacerSec = Math.max(0, options.spacerSeconds || 0);
  let cumulativeDuration = 0;
  const mergedSrtBlocks: string[] = [];
  let srtCueIndex = 1;

  try {
    onProgress({
      phase: 'preparing',
      percent: 10,
      message: `Preparing ${validItems.length} chapter video(s) for stitching...`,
    });

    const concatFiles: string[] = [];
    let spacerFilePath: string | null = null;

    if (spacerSec > 0 && validItems.length > 1) {
      spacerFilePath = path.join(tempDir, 'chapter_spacer.mp4');
      await runFfmpeg([
        '-y',
        '-f',
        'lavfi',
        '-i',
        `color=c=black:s=1920x1080:r=30:d=${spacerSec}`,
        '-f',
        'lavfi',
        '-i',
        `anullsrc=channel_layout=stereo:sample_rate=44100`,
        '-t',
        String(spacerSec),
        '-vf',
        'format=yuv420p',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '22',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-shortest',
        spacerFilePath,
      ]);
    }

    for (let i = 0; i < validItems.length; i++) {
      const item = validItems[i];
      concatFiles.push(item.filePath);

      // Merge companion .srt subtitle file if present and requested
      if (options.mergeSubtitles) {
        const candidateSrt = item.filePath.replace(/\.[^.]+$/, '.srt');
        if (fs.existsSync(candidateSrt)) {
          const rawSrt = fs.readFileSync(candidateSrt, 'utf-8');
          const rawBlocks = rawSrt.split(/\r?\n\r?\n/).map((b) => b.trim()).filter(Boolean);
          for (const block of rawBlocks) {
            const lines = block.split(/\r?\n/);
            const tcLineIdx = lines.findIndex((l) => l.includes('-->'));
            if (tcLineIdx === -1) continue;
            const [startRaw, endRaw] = lines[tcLineIdx].split('-->');
            const newStart = parseSrtTimeToSeconds(startRaw) + cumulativeDuration;
            const newEnd = parseSrtTimeToSeconds(endRaw) + cumulativeDuration;
            const textLines = lines.slice(tcLineIdx + 1).join('\n');
            if (textLines.trim()) {
              mergedSrtBlocks.push(
                `${srtCueIndex++}\n${formatSrtTimestamp(newStart)} --> ${formatSrtTimestamp(
                  newEnd
                )}\n${textLines}\n`
              );
            }
          }
        }
      }

      cumulativeDuration += item.durationSeconds || 0;
      if (spacerFilePath && i < validItems.length - 1) {
        concatFiles.push(spacerFilePath);
        cumulativeDuration += spacerSec;
      }
    }

    const concatListPath = path.join(tempDir, 'stitch_concat_list.txt');
    const concatContent = concatFiles
      .map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
      .join('\n');
    fs.writeFileSync(concatListPath, concatContent, 'utf-8');

    onProgress({
      phase: 'rendering-video',
      percent: 55,
      message:
        spacerSec > 0
          ? 'Stitching chapters with black transitions...'
          : 'Fast stream-copy stitching chapters (-c copy)...',
    });

    try {
      // Fast lossless stream-copy first (completes in seconds for uniform SpliceWright chapter exports)
      await runFfmpeg([
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        concatListPath,
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        outFull,
      ]);
    } catch {
      // Automatic fallback if any chapter had a different codec/resolution
      onProgress({
        phase: 'rendering-video',
        percent: 70,
        message: 'Normalizing mixed chapter formats and stitching...',
      });
      await runFfmpeg([
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        concatListPath,
        '-vf',
        'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,fps=30,format=yuv420p',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '21',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-movflags',
        '+faststart',
        outFull,
      ]);
    }

    let srtPath: string | undefined;
    if (options.mergeSubtitles && mergedSrtBlocks.length > 0) {
      srtPath = outFull.replace(/\.mp4$/i, '.srt');
      fs.writeFileSync(srtPath, mergedSrtBlocks.join('\n'), 'utf-8');
    }

    onProgress({
      phase: 'complete',
      percent: 100,
      message: `Stitched ${validItems.length} chapters (${Math.round(cumulativeDuration)}s total) -> ${path.basename(
        outFull
      )}`,
      outputPath: outFull,
      srtPath,
    });

    return {
      outputPath: outFull,
      srtPath,
      totalDurationSeconds: Math.round(cumulativeDuration * 100) / 100,
    };
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

