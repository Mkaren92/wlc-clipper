// Filling the stretches where the recogniser heard nothing.
//
// Captions are transcribed without the recogniser's voice filter, because
// under loud game sound the filter drops whole sentences (2026-11-22). But
// without it the recogniser sometimes skips a sentence itself: on a clip of
// 2026-11-23 it heard nothing in the first 5.5 seconds, where the streamer
// says a whole sentence that the filtered pass hears. Neither way is right
// alone. So the unfiltered words stay as they are, and only where they leave
// a long silence are words taken from a second, filtered pass.

/** @typedef {import('../types.js').Word} Word */

// A silence shorter than this is an ordinary pause and is left alone.
export const GAP_SECONDS = 1.5;
// A word from the second pass must sit this far inside the silence, so it is
// not the same word the first pass already has at the silence's edge.
const CLEAR = 0.15;
// And the recogniser must be this sure of it, and give it some length. The
// second pass is unsure exactly where the first heard nothing: on the clip
// above, run three times, it wrote "What the fuck? Who's shaking", "You
// should" and "What the fuck?! Who's taking" before the same three words,
// "the fucking car", each time. The changing words had a sureness of 0.03 to
// 0.24 or no length at all; the three steady ones 0.7 to 0.97.
const SURE = 0.4;
const SHORTEST = 0.05;

/**
 * The long silences in a transcript: before the first word, between words,
 * and after the last one.
 *
 * @param {Word[]} words
 * @param {number} [seconds]   the length of the sound; without it the end is not looked at
 * @returns {{ start: number, end: number }[]}
 */
export function quietGaps(words, seconds) {
  const gaps = [];
  let from = 0;
  for (const word of words) {
    if (word.start - from >= GAP_SECONDS) gaps.push({ start: from, end: word.start });
    from = Math.max(from, word.end);
  }
  if (seconds !== undefined && seconds - from >= GAP_SECONDS) gaps.push({ start: from, end: seconds });
  return gaps;
}

/**
 * The first pass's words, with words of the second pass added where the
 * first left a long silence. Nothing of the first pass is changed or removed.
 *
 * @param {Word[]} words     the unfiltered pass
 * @param {(Word & { p?: number })[]} others    the filtered pass; `p` is how sure the recogniser is of the word
 * @param {number} [seconds]
 * @returns {Word[]}
 */
export function fillGaps(words, others, seconds) {
  const gaps = quietGaps(words, seconds);
  const inside = (word) => gaps.some((gap) => {
    // No clearance is needed at the very start or end of the sound: there is no neighbour there.
    const from = gap.start === 0 ? 0 : gap.start + CLEAR;
    const to = gap.end === seconds ? gap.end : gap.end - CLEAR;
    return word.start >= from && word.end <= to;
  });
  const steady = (word) => (word.p === undefined || word.p >= SURE) && word.end - word.start >= SHORTEST;
  const added = others.filter((word) => steady(word) && inside(word)).map(({ text, start, end }) => ({ text, start, end }));
  if (added.length === 0) return words;
  return [...words, ...added].sort((a, b) => a.start - b.start);
}
