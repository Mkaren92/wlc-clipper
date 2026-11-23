import { run } from '../run.js';

/** @typedef {import('../types.js').Word} Word */

// The voice's own band, so game sound and music under it count for less.
export const VOICE_BAND = 'highpass=f=300,lowpass=f=3000';
// Levels are read in steps of this many seconds.
export const LEVEL_STEP = 0.05;
// Only a word longer than this is looked at. A spoken word is rarely longer, and the
// transcriber's fault is a word stretched back over the gap before it (2026-11-22:
// "What" given 1.4 s when it was shouted in the last 0.2 s of that).
const LONG_WORD_SECONDS = 0.5;
// Inside a word, a step is loud when it is within this much of the word's loudest moment.
const ONSET_BELOW_PEAK_DB = 10;
// Loud steps closer together than this are one stretch of voice; a quieter gap at least
// this long inside a word means what came before it was something else (the tail of the
// word before, or game sound). Syllables of one word are much closer together.
const GAP_SECONDS = 0.2;
// A word quieter than this throughout is left alone: there is nothing to go by.
const QUIETEST_PEAK_DB = -60;
const MIN_WORD_SECONDS = 0.05;

/**
 * Read the level of the voice band of an audio file, every LEVEL_STEP seconds.
 *
 * @param {string} audioFile   16 kHz mono WAV
 * @returns {Promise<{ t: number, db: number }[]>}
 */
export async function findVoiceLevels(audioFile) {
  const samples = Math.round(16000 * LEVEL_STEP);
  const filter = `aresample=16000,${VOICE_BAND},asetnsamples=n=${samples}:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level`;
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', audioFile, '-af', filter, '-f', 'null', '-']);
  return readVoiceLevels(stderr);
}

/**
 * Read ffmpeg's ametadata log: a time line, then the level for that step.
 * Digital silence is logged as "-inf".
 *
 * @param {string} log
 * @returns {{ t: number, db: number }[]}
 */
export function readVoiceLevels(log) {
  const levels = [];
  let time = null;
  for (const line of log.split('\n')) {
    const pts = /pts_time:(-?[\d.]+)/.exec(line);
    if (pts) {
      time = Number(pts[1]);
      continue;
    }
    const level = /RMS_level=(-?inf|-?[\d.]+)/.exec(line);
    if (level && time !== null) {
      levels.push({ t: time, db: level[1].endsWith('inf') ? -Infinity : Number(level[1]) });
      time = null;
    }
  }
  return levels;
}

/**
 * Move the start of a stretched word to where the voice begins in it.
 *
 * The transcriber often starts a word where the word before it ended, so after a gap
 * the caption shows before the word is said. `snapToSpeech` fixes that only where the
 * gap is quiet; under game sound or music there is no quiet gap. This looks inside each
 * long word instead. Its ends are where the transcriber is right (measured on 2026-11-22
 * within 0.1 s of the shouts), so the word is taken to be the last stretch of loud voice
 * before its end: loud meaning within ONSET_BELOW_PEAK_DB of the word's loudest moment,
 * and a stretch ending at a quieter gap of GAP_SECONDS or more. A start only ever moves
 * later, and the end is never moved.
 *
 * @param {Word[]} words
 * @param {{ t: number, db: number }[]} levels   from findVoiceLevels
 * @returns {Word[]}
 */
export function snapToVoice(words, levels) {
  if (levels.length === 0) return words;
  return words.map((word) => {
    if (word.end - word.start <= LONG_WORD_SECONDS) return word;
    // Only steps that lie mostly inside the word: the last one may be mostly the next word.
    const inside = levels.filter((level) => level.t + LEVEL_STEP / 2 > word.start && level.t + LEVEL_STEP / 2 < word.end);
    if (inside.length === 0) return word;
    const peak = Math.max(...inside.map((level) => level.db));
    if (!(peak > QUIETEST_PEAK_DB)) return word;
    let onset = null;
    let lastLoud = -Infinity;
    for (const level of inside) {
      if (level.db < peak - ONSET_BELOW_PEAK_DB) continue;
      if (onset === null || level.t - (lastLoud + LEVEL_STEP) >= GAP_SECONDS - 1e-9) onset = level.t;
      lastLoud = level.t;
    }
    const start = Math.min(Math.max(word.start, onset), word.end - MIN_WORD_SECONDS);
    return start === word.start ? word : { ...word, start: round(start) };
  });
}

function round(n) {
  return Math.round(n * 100) / 100;
}
