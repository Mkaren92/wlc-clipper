import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../run.js';

/** @typedef {import('../types.js').Transcript} Transcript */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = path.join(ROOT, 'scripts', 'transcribe.py');
// A whole video's transcript, which is only read ("Suggested moments", hooks), uses the small model.
const MODEL = 'small';
// A clip's captions use the larger one (about 1.6 GB, downloaded the first time). The owner chose it
// on 2026-11-24: under loud game sound the small model lost the streamer's voice. On 60 s of such a
// stream it heard 66 words and nothing in three loud stretches; this one 104, with words in all three,
// in 17 s against 7 s. CLIPPER_CAPTION_MODEL=small goes back, for a PC with little room or patience.
// The script gives it the sound in pieces of about 10 seconds; given a whole clip it skips stretches.
// There is no second pass over what it left silent: that was tried and removed (docs/decisions.md).
const captionModel = () => process.env.CLIPPER_CAPTION_MODEL || 'large-v3-turbo';

/** The Python that has faster-whisper installed. `npm run setup` creates it. */
function pythonPath() {
  return process.env.CLIPPER_PYTHON ?? path.join(ROOT, '.venv', 'bin', 'python');
}

/**
 * Whether the transcriber can run: the Python exists and can import
 * faster-whisper. A folder that exists but has nothing installed does not count.
 *
 * @returns {Promise<boolean>}
 */
async function isInstalled() {
  const python = pythonPath();
  try {
    await access(python);
    await run(python, ['-c', 'import faster_whisper']);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} audioFile   16 kHz mono WAV
 * @param {{ lang: string, batched?: boolean }} options   `batched` for a whole video's transcript:
 *   several pieces of speech at once, much faster on a long file (scripts/transcribe.py)
 * @returns {Promise<Transcript>}
 */
async function transcribe(audioFile, { lang, batched = false }) {
  const args = batched ? [MODEL, 'batched'] : [captionModel()];
  return JSON.parse((await run(pythonPath(), [SCRIPT, audioFile, lang, ...args])).stdout);
}

export const fasterWhisper = { name: 'faster-whisper', isInstalled, transcribe };
