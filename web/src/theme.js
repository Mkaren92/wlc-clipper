// The dashboard's colours.
//
// The palette is five colours. Every other colour on the pages (borders, muted
// text, hover fills, the text on a button) is worked out from those five in
// buildTokens, so changing the look means changing five values in PALETTE and
// nothing else. The pages never name a colour; they use the tokens.
//
// There is one palette. Two light ones (Lagoon, Clay) and the chooser in the
// side column were removed on 2026-11-24, at the owner's word.
//
// Not themed, on purpose: the match cards (their colours are the teams'), and
// the crop window drawn over the video, which has to show on any footage.

/**
 * @typedef {object} Palette
 * @property {string} background  the page behind everything
 * @property {string} surface     a tint for the side column, chosen rows and quiet fills.
 *   A strong colour is fine here: it is thinned with the background until text reads on it.
 * @property {string} highlight   a fill that draws the eye: step numbers, counts, "this one"
 * @property {string} primary     buttons, links, the outline of what is chosen
 * @property {string} ink         text
 */

/** @type {Palette} */
export const PALETTE = { background: '#0d1b24', surface: '#16303d', highlight: '#bbeb95', primary: '#6fd3e6', ink: '#e9f8f8' };

// --- Colour arithmetic --------------------------------------------------------

/** @returns {[number, number, number]} */
function rgb(hex) {
  const value = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!value) throw new Error(`A palette colour must look like #rrggbb, not "${hex}".`);
  return [0, 2, 4].map((at) => parseInt(value[1].slice(at, at + 2), 16));
}
const hex = (parts) => `#${parts.map((part) => Math.round(part).toString(16).padStart(2, '0')).join('')}`;

/** `share` of `b` mixed into `a`: 0 gives a, 1 gives b. */
export function mix(a, b, share) {
  const from = rgb(a);
  const to = rgb(b);
  return hex(from.map((part, i) => part + (to[i] - part) * share));
}

/** How light a colour is, 0 to 1, as the contrast rules define it. */
export function luminance(colour) {
  const [r, g, b] = rgb(colour).map((part) => {
    const v = part / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast between two colours, from 1 (none) to 21. Text needs 4.5, an outline 3. */
export function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** Move `colour` towards `end` in small steps until it stands out from every `against` by `ratio`. */
function standOut(colour, against, ratio, end) {
  let result = colour;
  for (let step = 0; step <= 20; step++) {
    result = mix(colour, end, step / 20);
    if (against.every((other) => contrast(result, other) >= ratio)) break;
  }
  return result;
}

/**
 * A tint has text on it. One too strong for that is thinned with the page's
 * colour, a little at a time, until the palette's own ink reads on it with
 * room to spare for quieter text. A tint that is already pale is left as it is.
 */
function thin(tint, page, ink) {
  let result = tint;
  for (let step = 0; step <= 18; step++) {
    result = mix(tint, page, step / 20);
    if (contrast(ink, result) >= 6) break;
  }
  return result;
}

/** The first of the candidates that reads on `fill`; when none does, the one that reads best. */
function readableOn(fill, candidates) {
  return candidates.find((colour) => contrast(colour, fill) >= 4.5)
    ?? [...candidates].sort((a, b) => contrast(b, fill) - contrast(a, fill))[0];
}

// --- Tokens -------------------------------------------------------------------

/**
 * Work out every colour the pages use from one palette.
 *
 * @param {Palette} palette
 * @returns {Record<string, string>} CSS custom properties and their values
 */
export function buildTokens(palette) {
  const { background, highlight, primary, ink } = palette;
  const dark = luminance(background) < 0.3;
  const far = dark ? '#ffffff' : '#000000'; // the end a colour moves towards to gain contrast

  const panel = dark ? mix(background, '#ffffff', 0.05) : mix(background, '#ffffff', 0.75);
  // Text reads easily on the page and its panels. The tint is thinned against
  // that text, which may already be darker than the palette's ink.
  const onPage = standOut(ink, [background, panel], 7, far);
  const surface = thin(palette.surface, background, onPage);
  const fills = [background, panel, surface];

  const text = standOut(onPage, fills, 4.5, far);
  const muted = standOut(mix(ink, background, 0.35), fills, 4.5, text);
  const accent = standOut(primary, fills, 4.5, far);
  // Text on a coloured fill: the page's own light or dark first, then whatever reads.
  const on = (fill) => readableOn(fill, [dark ? background : '#ffffff', text, background, '#000000', '#ffffff']);
  // Status colours are not in a palette. Each starts from a fixed hue and is
  // moved until it reads on this palette's fills and on its own pale notice.
  const status = (start) => {
    const first = standOut(start, fills, 4.5, far);
    const pale = mix(panel, first, 0.14);
    return [standOut(first, [...fills, pale], 4.5, far), pale];
  };
  const [good, goodBg] = status(dark ? '#7bd88f' : '#1a6e37');
  const [bad, badBg] = status(dark ? '#ff8a80' : '#b3261e');
  const [warn, warnBg] = status(dark ? '#f2b84b' : '#a85d00');

  return {
    '--scheme': dark ? 'dark' : 'light',
    '--bg': background,
    '--panel': panel,
    '--soft': surface,
    '--soft-strong': mix(surface, primary, 0.14),
    // A divider may be faint. The edge of a box you type in must stand out by 3.
    // Both take the palette's tint at full strength, so a strong one still shows in them.
    '--line': mix(surface, mix(palette.surface, primary, 0.5), dark ? 0.3 : 0.25),
    '--line-strong': standOut(mix(palette.surface, primary, 0.4), fills, 3, far),
    '--text': text,
    '--muted': muted,
    '--accent': accent,
    '--accent-hover': mix(accent, far, 0.18),
    '--accent-text': on(accent),
    '--accent-tint': mix(panel, accent, 0.1),
    '--highlight': highlight,
    '--highlight-text': readableOn(highlight, [text, background, '#000000', '#ffffff']),
    '--good': good,
    '--good-bg': goodBg,
    '--bad': bad,
    '--bad-text': on(bad),
    '--bad-bg': badBg,
    '--warn': warn,
    '--warn-bg': warnBg,
    '--shadow': dark ? 'rgba(0, 0, 0, 0.45)' : `${mix(ink, primary, 0.5)}1f`,
  };
}

// --- In the page --------------------------------------------------------------

/** The little picture in the browser tab: a play mark in the palette's colours. Nothing is fetched for it. */
function tabIcon(fill, mark) {
  const picture = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${fill}"/><path d="M11 8v16l13-8z" fill="${mark}"/></svg>`;
  let link = document.querySelector('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.append(link);
  }
  link.href = `data:image/svg+xml,${encodeURIComponent(picture)}`;
}

/** Put the palette's colours on the page. */
export function applyPalette() {
  const { '--scheme': scheme, ...tokens } = buildTokens(PALETTE);
  const root = document.documentElement;
  for (const [name, value] of Object.entries(tokens)) root.style.setProperty(name, value);
  // Tells the browser which colours to use for its own parts: scroll bars, date pickers, the file button.
  root.style.colorScheme = scheme;
  tabIcon(tokens['--accent'], tokens['--highlight']);
}
