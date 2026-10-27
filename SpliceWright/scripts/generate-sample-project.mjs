import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { ensureSampleAiMovieProject } = require('../dist-electron/electron/sampleProjectGenerator.js');
const { loadProjectFromFolder } = require('../dist-electron/electron/projectManager.js');
const { detectHardwareProfile } = require('../dist-electron/electron/hardware.js');
const { renderProjectWithFfmpeg } = require('../dist-electron/electron/ffmpegEngine.js');

async function main() {
  const workspaceRoot = path.resolve(__dirname, '..', '..');
  console.log('[SpliceWright] 1. Detecting hardware profile...');
  const hw = await detectHardwareProfile();
  console.log('   Hardware Profile:', JSON.stringify(hw));

  console.log('[SpliceWright] 2. Generating sample AI Movie project...');
  const sampleRoot = await ensureSampleAiMovieProject(workspaceRoot);
  console.log('   Sample AI Movie folder:', sampleRoot);

  console.log('[SpliceWright] 3. Loading project & building exports/video-project.json...');
  const bundle = await loadProjectFromFolder(sampleRoot);
  console.log(
    `   Loaded "${bundle.project.title}" with ${bundle.project.assets.length} assets, ${bundle.project.timeline.tracks.length} tracks, and ${bundle.project.timeline.markers.length} cues.`
  );

  console.log('[SpliceWright] 4. Running test FFmpeg export render...');
  const exportRes = await renderProjectWithFfmpeg(
    sampleRoot,
    bundle.project,
    {
      outputFileName: 'sample-rendered-preview.mp4',
      preset: 'fast-draft',
      encoder: hw.preferredEncoder,
      burnSubtitles: false,
      exportSrtFile: true,
    },
    (prog) => {
      console.log(`   [${prog.percent}%] ${prog.message}`);
    }
  );
  console.log('[SpliceWright] Export verified successfully:', exportRes);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
