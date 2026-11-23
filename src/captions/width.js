// Width estimate for caption text, used to shrink a group that would not fit.
//
// Advance widths of the bundled font (Liberation Sans Bold) in thousandths of
// an em. Captions are upper case, so only capitals, digits and a few signs
// are listed; anything else counts as the widest letter.
const ADVANCE = {
  A: 722, B: 722, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278,
  J: 556, K: 722, L: 611, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722,
  S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  ' ': 278, "'": 238, '’': 278, '-': 333, '$': 556, '%': 889, '&': 722,
  '+': 584, '#': 556, '@': 975, '/': 278,
  // The star of a covered swear word (mask.js); read from the font file on 2026-11-23.
  '*': 389,
};
const DIGIT = 556;
const WIDEST = 944;

// The caption size. It was 88; the owner asked for a little smaller on 2026-11-21.
export const CAPTION_SIZE = 76;

// Measured on ffmpeg 4.4.2: at size 88 one em came out as 77 px; at 76, re-measured on
// the same six phrases (2026-11-21), 66.5 px. The 6 px outline adds 12 px in total.
// With these numbers the estimate is within 10 px of the rendered width on all six.
const EM_PIXELS = 66.5;
const OUTLINE_PIXELS = 12;

// The channel tag: smaller than the captions, with a thinner outline.
export const TAG_SIZE = 60;
export const TAG_OUTLINE = 5;

/**
 * Estimated width of a channel tag (in capitals) on the 1080 px wide frame.
 * One em scales with the size from the caption's measured 66.5 px at 76.
 *
 * @param {string} text   upper-case tag text
 * @returns {number} pixels
 */
export function tagWidth(text) {
  return Math.round((units(text) * EM_PIXELS * TAG_SIZE) / CAPTION_SIZE / 1000) + 2 * TAG_OUTLINE;
}

// Handles often hold a dot or an underscore. Only the tag counts them at their real
// width, so a caption is shrunk exactly as it was before the tag existed.
const TAG_ADVANCE = { ...ADVANCE, '.': 278, _: 556 };

function units(text) {
  let total = 0;
  for (const char of text) total += TAG_ADVANCE[char] ?? (char >= '0' && char <= '9' ? DIGIT : WIDEST);
  return total;
}

/**
 * Estimated width of a caption line on the 1080 px wide frame.
 *
 * @param {string} text   upper-case caption text
 * @returns {number} pixels
 */
export function captionWidth(text) {
  let units = 0;
  for (const char of text) {
    units += ADVANCE[char] ?? (char >= '0' && char <= '9' ? DIGIT : WIDEST);
  }
  return Math.round((units * EM_PIXELS) / 1000) + OUTLINE_PIXELS;
}
