// Turns a card's SVG into a PNG, in the browser.
//
// A picture drawn from SVG cannot load a font from outside itself, so the
// bundled font is written into the SVG first. Without that the PNG would be
// drawn in whatever font the machine happens to have, and would not match
// the preview.
import fontUrl from '../../assets/fonts/LiberationSans-Bold.ttf?url';
import { CARD_FONT } from '../../src/cards/templates.js';

let fontData = null;

async function fontAsBase64() {
  if (fontData) return fontData;
  const bytes = new Uint8Array(await (await fetch(fontUrl)).arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  fontData = btoa(binary);
  return fontData;
}

/** Make the bundled font available to the page, for the preview. */
export async function loadCardFont() {
  const face = new FontFace(CARD_FONT, `url(${fontUrl})`, { weight: 'bold' });
  document.fonts.add(await face.load());
}

/**
 * @param {string} svg   from src/cards/templates.js
 * @param {number} width
 * @param {number} height
 * @returns {Promise<Blob>} a PNG
 */
export async function cardPng(svg, width, height) {
  const face = `<style>@font-face{font-family:'${CARD_FONT}';font-weight:bold;src:url(data:font/ttf;base64,${await fontAsBase64()}) format('truetype');}</style>`;
  const url = URL.createObjectURL(new Blob([svg.replace(/^(<svg[^>]*>)/, `$1${face}`)], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('The card could not be drawn.'));
      image.src = url;
    });
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(image, 0, 0, width, height);
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Hand a file to the browser to save. */
export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
