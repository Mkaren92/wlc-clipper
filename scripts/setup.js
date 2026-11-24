// Installs the transcriber and the downloader: a Python virtual environment
// in .venv with faster-whisper and yt-dlp inside it. Run with: npm run setup
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const venv = path.join(root, '.venv');
const python = path.join(venv, 'bin', 'python');

function step(label, command, args) {
  console.log(`\n${label}`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  return result.status === 0;
}

if (!existsSync(path.join(venv, 'bin', 'pip'))) {
  if (!step('Creating .venv', 'python3', ['-m', 'venv', '--clear', venv])) {
    // A failed attempt leaves a folder with Python but no pip; remove it.
    rmSync(venv, { recursive: true, force: true });
    console.error(
      '\nCould not create the virtual environment. On Ubuntu or Debian this usually means the venv ' +
        'package is missing. Install it, then run "npm run setup" again:\n\n  sudo apt install python3-venv\n',
    );
    process.exit(1);
  }
}

// faster-whisper turns speech into text for captions. It is left at the
// version already installed, so running this again does not change captions.
// yt-dlp is the downloader behind "fetch"; it is brought up to date every
// time, because YouTube changes often and old versions stop working.
const installed =
  step('Installing faster-whisper into .venv', python, ['-m', 'pip', 'install', 'faster-whisper']) &&
  step('Installing or updating yt-dlp in .venv', python, ['-m', 'pip', 'install', '--upgrade', 'yt-dlp']);
if (!installed) {
  console.error('\nThe install failed. Fix the error above, then run "npm run setup" again.');
  process.exit(1);
}

// NVIDIA's libraries let a whole video's transcript (for "Suggested moments") run on the
// graphics card: on the owner's GTX 1660 Ti, 5 minutes took 6 s instead of 33 s (2026-11-23).
// About 2 GB, so only on a PC where nvidia-smi finds a card. Pinned to the versions measured,
// so running this again changes nothing. Captions use it too since 2026-11-24. Without the libraries,
// or if the card fails, the transcript is made on the processor as before.
const card = spawnSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { encoding: 'utf8' });
if (card.status === 0 && card.stdout.trim()) {
  const ok = step(`Found ${card.stdout.trim().split('\n')[0]}: installing NVIDIA's libraries into .venv (about 2 GB)`, python, [
    '-m', 'pip', 'install', 'nvidia-cublas-cu12==12.9.3.13', 'nvidia-cudnn-cu12==9.28.1.4',
  ]);
  if (!ok) console.warn('\nThe graphics card libraries did not install; transcripts will use the processor. Everything else is installed.');
} else {
  console.log('\nNo NVIDIA graphics card found: transcripts use the processor.');
}

console.log('\nDone. The speech model itself is downloaded the first time a clip is transcribed.');
