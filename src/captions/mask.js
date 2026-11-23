// Swear words in the text drawn on a clip, with a letter covered: F*CK, SH*T.
//
// Asked for on 2026-11-23, for YouTube. Its advertiser guidelines count a
// written word "covered with symbols" as obscured profanity, which keeps
// full ads; see docs/decisions.md for what the page says and does not say.
//
// Only what is drawn is changed. The transcript and the saved hook keep the
// real words, so the brief's checks still judge what was really said.
//
// One letter becomes one star, so the text keeps its length and the
// captions are grouped exactly as they would be without this.
// Nothing here is imported from Node, so a page could use it too.

// Roots that are masked wherever they stand in a word (MOTHERF*CKER, BULLSH*T).
// Only roots that do not turn up inside innocent words; `at` is the letter to cover.
const INSIDE = [
  { root: 'fuck', at: [1] },
  { root: 'shit', at: [2] },
  { root: 'bitch', at: [1] },
];

// Words masked only as whole words, with a plain ending (-s, -es, -ed, -ing, -y).
// Whole words, because of names: Scunthorpe, Hancock, Dickens. "Dick" and
// "cock" alone are left out for the same reason; "damn" and "hell" because
// YouTube does not count them as profanity. Written with doubled letters
// taken out, which is how a word is compared (see `runsOf`).
const WHOLE = [
  { root: 'cunt', at: [1] },
  { root: 'ashole', at: [1] }, // asshole: A**HOLE
  { root: 'arsehole', at: [1, 2] },
  { root: 'bastard', at: [1] },
  { root: 'dickhead', at: [1] },
  { root: 'cocksucker', at: [1] },
  { root: 'douche', at: [1] },
  { root: 'douchebag', at: [1] },
  { root: 'wanker', at: [1] },
  { root: 'twat', at: [2] },
  { root: 'prick', at: [2] },
  { root: 'pusy', at: [1] }, // pussy
  { root: 'pusies', at: [1] },
  { root: 'whore', at: [2] },
  { root: 'slut', at: [2] },
  { root: 'bolocks', at: [1] }, // bollocks
];
const ENDINGS = ['', 's', 'es', 'ed', 'ing', 'y'];

// Hateful words: everything after the first letter is covered. Compared as
// written, not with doubled letters taken out, which would make one of them
// the name of a country.
const SLUR = /^(nigger|nigga|faggot|retard)(s|ed)?$/;

/**
 * Cover the swear words in a line of text. Everything else, and the length
 * of the text, stays as it is.
 *
 * @param {string} text   a caption line or a hook, in any case
 * @returns {string}
 */
export function maskProfanity(text) {
  return text.split(/(\s+)/).map((piece) => (/^\s*$/.test(piece) ? piece : maskWord(piece))).join('');
}

function maskWord(word) {
  // The word itself, without the punctuation around it.
  const found = /[\p{L}].*[\p{L}]/u.exec(word);
  if (!found) return word;
  const core = found[0];
  const [before, after] = [word.slice(0, found.index), word.slice(found.index + core.length)];

  if (SLUR.test(core.toLowerCase())) return before + core[0] + '*'.repeat(core.length - 1) + after;

  // A shouted word is written with its letters stretched ("fuuuck"), so the
  // word is compared as runs of the same letter, each counted once.
  const runs = runsOf(core);
  const bare = runs.map((run) => run.letter).join('');
  const cover = new Set(); // which runs to cover

  for (const { root, at } of INSIDE) {
    for (let from = bare.indexOf(root); from !== -1; from = bare.indexOf(root, from + 1)) at.forEach((i) => cover.add(from + i));
  }
  for (const { root, at } of WHOLE) {
    if (ENDINGS.some((ending) => bare === root + ending)) at.forEach((i) => cover.add(i));
  }
  if (cover.size === 0) return word;

  const masked = runs.map((run, i) => (cover.has(i) ? '*'.repeat(run.text.length) : run.text)).join('');
  return before + masked + after;
}

/**
 * Whether a spoken word is one that gets covered. A word the recogniser
 * wrote with stars already ("f***") counts too.
 *
 * @param {string} text
 */
export function isSwear(text) {
  return text.includes('*') || maskProfanity(text) !== text;
}

// The muffle starts a little before the word and ends a little after it: word
// times are good to about a tenth of a second, and a word's end is often early.
const BEFORE = 0.08;
const AFTER = 0.12;

/**
 * When the swear words are spoken, for muffling the sound: one window per
 * word, a little wider than the word, kept inside the clip, with windows
 * that touch joined into one.
 *
 * @param {{ text: string, start: number, end: number }[]} words   times in seconds from the start of the clip
 * @param {number} clipSeconds
 * @returns {{ start: number, end: number }[]}
 */
export function swearWindows(words, clipSeconds) {
  const windows = [];
  for (const word of words) {
    if (!isSwear(word.text)) continue;
    const start = Math.max(0, word.start - BEFORE);
    const end = Math.min(clipSeconds, word.end + AFTER);
    if (!(end > start)) continue;
    const last = windows.at(-1);
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else windows.push({ start, end });
  }
  return windows.map((one) => ({ start: Math.round(one.start * 1000) / 1000, end: Math.round(one.end * 1000) / 1000 }));
}

/** A word as runs of one letter: "FUUUCK" is F, UUU, C, K. Case is ignored for comparing and kept in `text`. */
function runsOf(word) {
  const runs = [];
  for (const char of word) {
    const letter = char.toLowerCase();
    const last = runs.at(-1);
    if (last && last.letter === letter) last.text += char;
    else runs.push({ letter, text: char });
  }
  return runs;
}
