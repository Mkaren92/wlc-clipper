// The small pieces every card is drawn from: the colours, a line of text, the
// picture's frame. The card kinds (templates.js) and the extra layouts
// (layouts.js) both use them, so a name is escaped and a colour checked in one place.
import { isIcon } from './config.js';
import { fitSize } from './measure.js';

/** Name the page and the PNG export give the bundled font. */
export const CARD_FONT = 'Clipper Card';

export const BACKGROUND = '#12151b';
export const PANEL = '#1c212b';
export const TEXT = '#f4f5f7';
export const MUTED = '#a7afbd';
export const RED = '#d0202f';
// The end of the one rectangle that fills a card. renderCard swaps it for a see-through one.
export const SOLID_BACKGROUND = `fill="${BACKGROUND}"/>`;

export function frame(c, parts) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${c.w} ${c.h}" width="${c.w}" height="${c.h}" font-family="'${CARD_FONT}', 'Liberation Sans', Arial, sans-serif" font-weight="bold">`,
    `<rect width="${c.w}" height="${c.h}" ${SOLID_BACKGROUND}`,
    ...parts.filter(Boolean),
    '</svg>',
  ].join('');
}

/** A centred line of text, made smaller if it would not fit. */
export function line(c, value, { x = c.w / 2, y, size, fill, anchor = 'middle', maxWidth = c.w - 2 * c.margin, opacity }) {
  if (!value) return '';
  return text(value, { x, y, size: fitSize(value, size, maxWidth), anchor, fill, opacity });
}

/** One line of text. `opacity` is written only when given, so the other cards are drawn as before. */
export function text(value, { x, y, size, anchor, fill, opacity }) {
  const faint = opacity === undefined ? '' : ` fill-opacity="${opacity}"`;
  return `<text x="${round(x)}" y="${round(y)}" font-size="${round(size)}" text-anchor="${anchor}" fill="${fill}"${faint}>${escapeXml(value)}</text>`;
}

/**
 * A team's icon in a square of `size` centred on x, y. Without an icon, a
 * disc of the team's colour with the first letter of its name stands in, so
 * the card is whole either way.
 */
export function icon(c, match, side, { x, y, size }) {
  const picture = match.icons?.[side];
  if (isIcon(picture)) {
    return `<image href="${picture}" x="${round(x - size / 2)}" y="${round(y - size / 2)}" width="${round(size)}" height="${round(size)}" preserveAspectRatio="xMidYMid meet"/>`;
  }
  const fill = safeColour(match.colours[side]);
  const letter = teamName(match, side).trim().charAt(0).toUpperCase();
  return [
    `<circle cx="${round(x)}" cy="${round(y)}" r="${round(size / 2)}" fill="${fill}"/>`,
    text(letter, { x, y: y + size * 0.18, size: size * 0.5, anchor: 'middle', fill: readableOn(fill) }),
  ].join('');
}

// --- Small helpers --------------------------------------------------------------

export const teamName = (match, side) => (side === 'away' ? match.away : match.home) || (side === 'away' ? 'Away' : 'Home');
export const round = (n) => Math.round(n * 10) / 10;

/** Names are typed by a person, so anything with a meaning in SVG is escaped. */
export function escapeXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** A colour is used only if it is a plain #rrggbb value. */
export function safeColour(colour) {
  return /^#[0-9a-fA-F]{6}$/.test(colour ?? '') ? colour : '#5b6475';
}

/** Black or white, whichever is easier to read on `colour`. */
export function readableOn(colour) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(colour.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#101216' : '#ffffff';
}
