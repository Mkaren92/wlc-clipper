import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../run.js';

/** @typedef {import('../types.js').Transcript} Transcript */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = path.join(ROOT, 'scripts', 'transcribe.py');
const MODEL = 'small';

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
  const { stdout } = await run(pythonPath(), [SCRIPT, audioFile, lang, MODEL, ...(batched ? ['batched'] : [])]);
  return JSON.parse(stdout);
}

export const fasterWhisper = { name: 'faster-whisper', isInstalled, transcribe };
