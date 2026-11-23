import { fasterWhisper } from './fasterWhisper.js';

/** @typedef {import('../types.js').Transcript} Transcript */

/**
 * Everything the pipeline needs from a speech-to-text engine. Another engine
 * (whisper.cpp, a hosted API) only has to provide these three members.
 *
 * @typedef {object} Transcriber
 * @property {string} name
 * @property {() => Promise<boolean>} isInstalled
 * @property {(audioFile: string, options: { lang: string, seconds?: number }) => Promise<Transcript>} transcribe
 *   `seconds` is the length of the sound
 */

/** @returns {Transcriber} */
export function getTranscriber() {
  return fasterWhisper;
}

/**
 * Check a transcript read from disk. People edit transcript.json by hand to
 * fix words, so a mistake there should be named clearly.
 *
 * @param {unknown} data
 * @returns {Transcript}
 */
export function checkTranscript(data) {
  const words = /** @type {any} */ (data)?.words;
  if (!Array.isArray(words)) throw new Error('transcript.json needs a "words" list.');
  words.forEach((word, index) => {
    const ok =
      typeof word?.text === 'string' &&
      Number.isFinite(word.start) &&
      Number.isFinite(word.end) &&
      word.end >= word.start;
    if (!ok) {
      throw new Error(
        `transcript.json: word ${index + 1} must look like { "text": "He", "start": 0.32, "end": 0.48 }.`,
      );
    }
  });
  return /** @type {Transcript} */ (data);
}
