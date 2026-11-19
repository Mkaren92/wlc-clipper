// Text widths for the bundled card font (Liberation Sans Bold), so a long
// name can be made smaller to fit. Worked out from the font's advance widths
// and not by asking a browser, so the same card comes out the same in the
// page, in a test and on any machine.

// Advance widths in thousandths of an em.
const WIDTHS = {
  ' ': 278, '!': 333, '"': 474, '#': 556, $: 556, '%': 889, '&': 722, "'": 238, '(': 333, ')': 333, '*': 389,
  '+': 584, ',': 278, '-': 333, '.': 278, '/': 278, ':': 333, ';': 333, '<': 584, '=': 584, '>': 584, '?': 611,
  '@': 975, '[': 333, ']': 333, _: 556, '–': 556, '—': 1000, '’': 278, '‘': 278, '·': 278, '•': 350,
  A: 722, B: 722, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 556, K: 722, L: 611, M: 833,
  N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  a: 556, b: 611, c: 556, d: 611, e: 556, f: 333, g: 611, h: 611, i: 278, j: 278, k: 556, l: 278, m: 889,
  n: 611, o: 611, p: 611, q: 611, r: 389, s: 556, t: 333, u: 611, v: 556, w: 778, x: 556, y: 556, z: 500,
};
const DIGIT = 556;
// A letter this table does not know is counted as a wide one, so text is
// made a little too small and never too big.
const UNKNOWN = 778;

/**
 * Width of a line of text in pixels at a font size.
 *
 * @param {string} text
 * @param {number} fontSize
 */
export function textWidth(text, fontSize) {
  let units = 0;
  // An accented letter is as wide as the plain one: é like e.
  for (const char of text.normalize('NFD').replace(/\p{M}/gu, '')) {
    units += WIDTHS[char] ?? (char >= '0' && char <= '9' ? DIGIT : UNKNOWN);
  }
  return (units * fontSize) / 1000;
}

/**
 * The largest font size, up to `size`, at which `text` is no wider than `maxWidth`.
 *
 * @param {string} text
 * @param {number} size
 * @param {number} maxWidth
 */
export function fitSize(text, size, maxWidth) {
  const width = textWidth(text, size);
  return width <= maxWidth ? size : Math.floor((size * maxWidth) / width);
}
