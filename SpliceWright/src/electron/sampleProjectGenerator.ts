import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { AiMovieManifest } from '../shared/types';
import { getFfmpegPath } from './hardware';

function runFfmpegQuick(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(getFfmpegPath(), args);
    let err = '';
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Sample FFmpeg error (${code}): ${err.slice(-300)}`));
    });
    proc.on('error', reject);
  });
}

/**
 * Generates a complete, playable AI Movies sample project on disk (`sample-ai-movie/`)
 * matching the exact folder layout and `ai-movie.json` contract from `what-editor-app-needs-to-know.md`.
 */
export async function ensureSampleAiMovieProject(baseDir: string): Promise<string> {
  const sampleRoot = path.join(baseDir, 'sample-ai-movie');

  const dirs = [
    path.join(sampleRoot, 'scenes', 'scene-1', 'videos'),
    path.join(sampleRoot, 'scenes', 'scene-2', 'videos'),
    path.join(sampleRoot, 'scenes', 'scene-3', 'videos'),
    path.join(sampleRoot, 'audio', 'scene-1'),
    path.join(sampleRoot, 'audio', 'scene-2'),
    path.join(sampleRoot, 'audio', 'scene-3'),
    path.join(sampleRoot, 'storyboards', 'storyboard-1', 'videos'),
    path.join(sampleRoot, 'assets', 'audio'),
    path.join(sampleRoot, 'assets', 'video'),
    path.join(sampleRoot, 'exports'),
  ];

  for (const d of dirs) {
    fs.mkdirSync(d, { recursive: true });
  }

  const aiMoviePath = path.join(sampleRoot, 'ai-movie.json');
  if (fs.existsSync(aiMoviePath)) {
    return sampleRoot;
  }

  // 1. Scene 1 takes (2 video takes + first-frame.png)
  const s1Take1 = path.join(sampleRoot, 'scenes', 'scene-1', 'videos', 'video-1730001001.mp4');
  const s1Take2 = path.join(sampleRoot, 'scenes', 'scene-1', 'videos', 'video-1730002000.mp4');
  const s1Poster = path.join(sampleRoot, 'scenes', 'scene-1', 'first-frame.png');

  await runFfmpegQuick([
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=1280x720:r=30:d=5',
    '-vf',
    'hue=h=200:s=1.2,format=yuv420p',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-an',
    s1Take1,
  ]);

  await runFfmpegQuick([
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=1280x720:r=30:d=5',
    '-vf',
    'hue=h=25:s=1.4,format=yuv420p',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-an',
    s1Take2,
  ]);

  await runFfmpegQuick([
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=#1e293b:s=1280x720:d=1',
    '-frames:v',
    '1',
    s1Poster,
  ]);

  // 2. Scene 2 video take + poster
  const s2Take1 = path.join(sampleRoot, 'scenes', 'scene-2', 'videos', 'video-1730003000.mp4');
  const s2Poster = path.join(sampleRoot, 'scenes', 'scene-2', 'first-frame.png');

  await runFfmpegQuick([
    '-y',
    '-f',
    'lavfi',
    '-i',
    'smptebars=s=1280x720:r=30:d=5',
    '-vf',
    'format=yuv420p',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-an',
    s2Take1,
  ]);

  await runFfmpegQuick([
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=#0f172a:s=1280x720:d=1',
    '-frames:v',
    '1',
    s2Poster,
  ]);

  // 3. Scene 3 (Poster frame only — demonstrates fallback when video isn't generated yet!)
  const s3Poster = path.join(sampleRoot, 'scenes', 'scene-3', 'first-frame.png');
  await runFfmpegQuick([
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=#31102f:s=1280x720:d=1',
    '-frames:v',
    '1',
    s3Poster,
  ]);

  // 4. Storyboard video take (`storyboards/storyboard-1/videos/video-1730005000.mp4`)
  const sbVideo = path.join(sampleRoot, 'storyboards', 'storyboard-1', 'videos', 'video-1730005000.mp4');
  await runFfmpegQuick([
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=s=1280x720:r=30:d=6',
    '-vf',
    'format=yuv420p',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-an',
    sbVideo,
  ]);

  // 5. Dialogue Audio Lines (`audio/<scene-id>/...`)
  const a1_1 = path.join(sampleRoot, 'audio', 'scene-1', 'audio-1730001000-1.mp3');
  const a1_2 = path.join(sampleRoot, 'audio', 'scene-1', 'audio-1730001000-2.mp3');
  const a2_1 = path.join(sampleRoot, 'audio', 'scene-2', 'audio-1730002000-1.mp3');
  const a3_1 = path.join(sampleRoot, 'audio', 'scene-3', 'audio-1730003000-1.mp3');

  await runFfmpegQuick([
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=2.2',
    '-af',
    'volume=0.35,afade=t=in:st=0:d=0.1,afade=t=out:st=1.9:d=0.3',
    a1_1,
  ]);

  await runFfmpegQuick([
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=330:duration=1.8',
    '-af',
    'volume=0.35,afade=t=in:st=0:d=0.1,afade=t=out:st=1.5:d=0.3',
    a1_2,
  ]);

  await runFfmpegQuick([
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=523:duration=3.0',
    '-af',
    'volume=0.35,afade=t=in:st=0:d=0.1,afade=t=out:st=2.6:d=0.4',
    a2_1,
  ]);

  await runFfmpegQuick([
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=392:duration=2.6',
    '-af',
    'volume=0.35,afade=t=in:st=0:d=0.1,afade=t=out:st=2.2:d=0.4',
    a3_1,
  ]);

  // 6. Shared Backing Music & SFX (`assets/audio/`)
  const sharedBgm = path.join(sampleRoot, 'assets', 'audio', 'ambient_synth_theme.mp3');
  const sharedSfx = path.join(sampleRoot, 'assets', 'audio', 'sfx_thunder_rain.mp3');

  await runFfmpegQuick([
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=220:duration=16',
    '-af',
    'volume=0.25,afade=t=in:st=0:d=1.0,afade=t=out:st=14:d=2.0',
    sharedBgm,
  ]);

  await runFfmpegQuick([
    '-y',
    '-f',
    'lavfi',
    '-i',
    'anoisesrc=color=brown:duration=2.5',
    '-af',
    'volume=0.4,afade=t=in:st=0:d=0.2,afade=t=out:st=1.8:d=0.7',
    sharedSfx,
  ]);

  // 7. Write canonical `ai-movie.json`
  const manifest: AiMovieManifest = {
    schemaVersion: 1,
    projectVersion: 9,
    title: 'Neon Gate: Sample AI Movie',
    createdAt: new Date().toISOString(),
    options: {
      aspectRatio: '16:9',
      colorGrade: 'cinematic teal shadows, warm skin tones',
      accentColors: 'amber, cyan',
      mutedColors: 'greens',
      characterVaultPath: '',
    },
    characters: [
      { id: 'character-1', name: 'Maya', voice: 'Rachel' },
      { id: 'character-2', name: 'Kael', voice: 'Josh' },
    ],
    scenes: [
      {
        id: 'scene-1',
        title: 'Arrival at the Iron Gate',
        status: 'approved',
        summary: 'Maya and Kael approach the locked iron gate in the pouring rain.',
        dialogue: 'Maya: We should go before the gate locks.\nKael: Wait—listen to the static.',
        durationSeconds: 5,
        aspectRatio: '16:9',
        resolution: '1920x1080',
        characterIds: ['character-1', 'character-2'],
        audioAssets: [
          {
            id: 'audio-1730001000-1',
            kind: 'dialogue',
            fileName: 'audio/scene-1/audio-1730001000-1.mp3',
            source: 'elevenlabs',
            providerModel: 'eleven_multilingual_v2',
            dialogueLine: 'Maya: We should go before the gate locks.',
            characterId: 'character-1',
            durationSeconds: 2.2,
            status: 'approved',
          },
          {
            id: 'audio-1730001000-2',
            kind: 'dialogue',
            fileName: 'audio/scene-1/audio-1730001000-2.mp3',
            source: 'elevenlabs',
            providerModel: 'eleven_multilingual_v2',
            dialogueLine: 'Kael: Wait—listen to the static.',
            characterId: 'character-2',
            durationSeconds: 1.8,
            status: 'generated',
          },
        ],
        videos: [
          {
            id: 'video-1730001001',
            label: 'Seedance Take 1 (Cool Teal)',
            fileName: 'scenes/scene-1/videos/video-1730001001.mp4',
            source: 'fal.ai',
            providerModel: 'bytedance/seedance-2.0/reference-to-video',
            durationSeconds: 5,
            aspectRatio: '16:9',
            resolution: '1920x1080',
          },
          {
            id: 'video-1730002000',
            label: 'Seedance Take 2 (Warm Amber Hero)',
            fileName: 'scenes/scene-1/videos/video-1730002000.mp4',
            source: 'fal.ai',
            providerModel: 'bytedance/seedance-2.0/reference-to-video',
            durationSeconds: 5,
            aspectRatio: '16:9',
            resolution: '1920x1080',
          },
        ],
        properties: {
          firstFrameFileName: 'first-frame.png',
        },
      },
      {
        id: 'scene-2',
        title: 'Crossing the Courtyard',
        status: 'generated',
        summary: 'Searchlights sweep across the wet cobblestones as Maya sprints ahead.',
        dialogue: 'Maya: Stay in the shadows until the tower beacon passes!',
        durationSeconds: 5,
        aspectRatio: '16:9',
        resolution: '1920x1080',
        characterIds: ['character-1'],
        audioAssets: [
          {
            id: 'audio-1730002000-1',
            kind: 'dialogue',
            fileName: 'audio/scene-2/audio-1730002000-1.mp3',
            source: 'elevenlabs',
            providerModel: 'eleven_multilingual_v2',
            dialogueLine: 'Maya: Stay in the shadows until the tower beacon passes!',
            characterId: 'character-1',
            durationSeconds: 3.0,
            status: 'generated',
          },
        ],
        videos: [
          {
            id: 'video-1730003000',
            label: 'Seedance Courtyard Run',
            fileName: 'scenes/scene-2/videos/video-1730003000.mp4',
            source: 'fal.ai',
            providerModel: 'bytedance/seedance-2.0/reference-to-video',
            durationSeconds: 5,
            aspectRatio: '16:9',
            resolution: '1920x1080',
          },
        ],
        properties: {
          firstFrameFileName: 'first-frame.png',
        },
      },
      {
        id: 'scene-3',
        title: 'Inside the Vault (First-Frame Only)',
        status: 'draft',
        summary: 'Scene 3 has a first-frame poster and voiceover, awaiting video generation.',
        dialogue: 'Kael: The terminal is still online.',
        durationSeconds: 4,
        aspectRatio: '16:9',
        resolution: '1920x1080',
        characterIds: ['character-2'],
        audioAssets: [
          {
            id: 'audio-1730003000-1',
            kind: 'dialogue',
            fileName: 'audio/scene-3/audio-1730003000-1.mp3',
            source: 'elevenlabs',
            providerModel: 'eleven_multilingual_v2',
            dialogueLine: 'Kael: The terminal is still online.',
            characterId: 'character-2',
            durationSeconds: 2.6,
            status: 'generated',
          },
        ],
        videos: [],
        properties: {
          firstFrameFileName: 'first-frame.png',
        },
      },
    ],
    storyboards: [
      {
        id: 'storyboard-1',
        title: 'Gate Opening Sequence',
        sceneIds: ['scene-1', 'scene-2'],
        panels: [
          {
            id: 'panel-1',
            title: 'Wide Iron Gate',
            cameraDirection: 'WS, slow push-in through rain',
            sceneId: 'scene-1',
            dialogue: 'We should go before the gate locks.',
            soundEffects: 'Rain on iron gate, distant thunder',
            dialogueTags: ['urgent', 'whispered'],
          },
          {
            id: 'panel-2',
            title: 'Searchlight Sweep',
            cameraDirection: 'Tracking low-angle pan',
            sceneId: 'scene-2',
            dialogue: 'Stay in the shadows until the tower beacon passes!',
            soundEffects: 'Heavy footsteps on wet stone, hum of spotlight',
            dialogueTags: ['tense'],
          },
        ],
        videos: [
          {
            id: 'video-1730005000',
            fileName: 'videos/video-1730005000.mp4',
            durationSeconds: 6,
            aspectRatio: '16:9',
            resolution: '720p',
          },
        ],
      },
    ],
    editorState: {
      hasUnsavedChanges: false,
      dirtyFormKeys: [],
      pendingOperations: [],
      dirtySince: null,
    },
  };

  fs.writeFileSync(aiMoviePath, JSON.stringify(manifest, null, 2), 'utf-8');
  return sampleRoot;
}
