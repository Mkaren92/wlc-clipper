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
};
const DIGIT = 556;
const WIDEST = 944;

// Measured on ffmpeg 4.4.2: at the caption style's size of 88, one em comes
// out as 77 px, and the 6 px outline adds 12 px in total. With these numbers
// the estimate was within 3 px of the rendered width on six test phrases.
const EM_PIXELS = 77;
const OUTLINE_PIXELS = 12;

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
