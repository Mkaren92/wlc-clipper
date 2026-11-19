import { run } from '../run.js';

/** @typedef {import('../types.js').Word} Word */

// A stretch counts as a pause when it is this much quieter than the clip's
// average level, for at least this long. A relative level means background
// music or game sound simply yields no pauses, and the times stay as they were.
const QUIETER_BY_DB = 15;
const MIN_PAUSE_SECONDS = 0.25;
// Ignore overlaps shorter than this between a word and a pause.
const MIN_OVERLAP_SECONDS = 0.2;
const MIN_WORD_SECONDS = 0.05;

/**
 * Find the pauses in an audio file.
 *
 * @param {string} audioFile
 * @returns {Promise<{ start: number, end: number }[]>} seconds from the start
 */
export async function findPauses(audioFile) {
  const levels = await analyse(audioFile, 'volumedetect');
  const mean = Number(/mean_volume: (-?[\d.]+) dB/.exec(levels)?.[1]);
  if (!Number.isFinite(mean)) return [];

  const threshold = (mean - QUIETER_BY_DB).toFixed(1);
  const log = await analyse(audioFile, `silencedetect=n=${threshold}dB:d=${MIN_PAUSE_SECONDS}`);
  return readPauses(log);
}

/**
 * Read ffmpeg's silencedetect log. A pause still open when the audio ends
 * has no end line and runs to the end.
 *
 * @param {string} log
 * @returns {{ start: number, end: number }[]}
 */
export function readPauses(log) {
  const pauses = [];
  for (const match of log.matchAll(/silence_(start|end): (-?[\d.]+)/g)) {
    const time = Math.max(0, Number(match[2]));
    if (match[1] === 'start') pauses.push({ start: time, end: Infinity });
    else if (pauses.length > 0) pauses.at(-1).end = time;
  }
  return pauses;
}

/**
 * Move word times off the pauses.
 *
 * The transcriber often stretches a word across the silence next to it,
 * usually by starting the first word after a pause when the previous word
 * ended. Its caption then appears during the silence, up to half a second
 * before the word is spoken. When a word overlaps a pause, the word is taken
 * to be on the side where more of it lies, and the other side is cut off.
 *
 * @param {Word[]} words
 * @param {{ start: number, end: number }[]} pauses
 * @returns {Word[]}
 */
export function snapToSpeech(words, pauses) {
  return words.map((word) => {
    let { start, end } = word;
    for (const pause of pauses) {
      const overlap = Math.min(end, pause.end) - Math.max(start, pause.start);
      if (overlap < MIN_OVERLAP_SECONDS) continue;
      const before = pause.start - start; // part of the word ahead of the pause
      const after = end - pause.end; // part of the word behind it
      if (before <= 0 && after <= 0) continue; // the pause covers the whole word: leave it
      if (after >= before) start = Math.min(pause.end, end - MIN_WORD_SECONDS);
      else end = Math.max(pause.start, start + MIN_WORD_SECONDS);
    }
    return { ...word, start: round(start), end: round(end) };
  });
}

async function analyse(audioFile, filter) {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', audioFile, '-af', filter, '-f', 'null', '-']);
  return stderr;
}

function round(n) {
  return Math.round(n * 100) / 100;
}
