/** @typedef {import('../types.js').Word} Word */

export const MAX_WORDS = 3;
export const MAX_CHARS = 18;
// A silence longer than this starts a new group.
const PAUSE_SECONDS = 0.4;
// A group stays on screen this long after its last word, unless the next
// group starts sooner.
const LINGER_SECONDS = 0.15;

/**
 * Turn timed words into short caption groups.
 *
 * @param {Word[]} words          times in seconds from the start of the clip
 * @param {number} clipSeconds    groups never run past the end of the clip
 * @returns {{ text: string, start: number, end: number }[]}
 */
export function groupWords(words, clipSeconds) {
  const groups = [];
  let current = [];
  let previous = null;

  for (const word of words) {
    const text = displayText(word.text);
    if (!text || word.start >= clipSeconds) continue;

    const startsNewGroup =
      current.length > 0 &&
      (current.length >= MAX_WORDS ||
        joined(current).length + 1 + text.length > MAX_CHARS ||
        word.start - previous.end > PAUSE_SECONDS ||
        endsSentence(previous.text));

    if (startsNewGroup) {
      groups.push(current);
      current = [];
    }
    current.push({ text, start: word.start, end: word.end });
    previous = word;
  }
  if (current.length > 0) groups.push(current);

  return groups
    .map((group, index) => {
      const start = Math.max(0, group[0].start);
      const nextStart = groups[index + 1]?.[0].start ?? Infinity;
      const end = Math.min(group.at(-1).end + LINGER_SECONDS, nextStart, clipSeconds);
      return { text: joined(group), start, end };
    })
    .filter((group) => group.end > group.start);
}

/**
 * Upper case, with punctuation and subtitle control characters removed.
 * Apostrophes and hyphens inside a word stay ("DON'T", "CO-OP").
 *
 * @param {string} text
 * @returns {string}
 */
export function displayText(text) {
  return text
    .replace(/[{}\\.,!?;:"“”()[\]…–—]/g, '')
    .replace(/^['’\-\s]+|['’\-\s]+$/g, '')
    .toUpperCase();
}

function joined(group) {
  return group.map((word) => word.text).join(' ');
}

function endsSentence(text) {
  return /[.!?]["'”’)\]]*$/.test(text.trim());
}
