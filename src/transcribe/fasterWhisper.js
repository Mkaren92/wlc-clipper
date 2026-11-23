import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, STOPPED } from '../run.js';
import { fillGaps, quietGaps } from './fill.js';

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
 * @param {{ lang: string, batched?: boolean, seconds?: number }} options   `batched` for a whole
 *   video's transcript: several pieces of speech at once, much faster on a long file
 *   (scripts/transcribe.py). `seconds` is the length of the sound, so a silence at its end is seen too.
 * @returns {Promise<Transcript>}
 */
async function transcribe(audioFile, { lang, batched = false, seconds }) {
  const pass = async (mode) => JSON.parse((await run(pythonPath(), [SCRIPT, audioFile, lang, MODEL, ...(mode ? [mode] : [])])).stdout);
  if (batched) return pass('batched');
  const transcript = await pass(null);
  // Where the plain pass heard nothing for a long stretch, a second pass with the voice filter
  // is asked, and its words are used there and nowhere else (fill.js).
  if (quietGaps(transcript.words, seconds).length === 0) return transcript;
  let others;
  try {
    others = (await pass('filtered')).words;
  } catch (error) {
    // The second pass is an extra: if it fails, the first pass's words are still good. A stop is a stop.
    if (error.message === STOPPED) throw error;
    return transcript;
  }
  return { ...transcript, words: fillGaps(transcript.words, others, seconds) };
}

export const fasterWhisper = { name: 'faster-whisper', isInstalled, transcribe };
