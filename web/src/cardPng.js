// Turns a card's SVG into a PNG, in the browser.
//
// A picture drawn from SVG cannot load a font from outside itself, so the
// bundled font is written into the SVG first. Without that the PNG would be
// drawn in whatever font the machine happens to have, and would not match
// the preview.
import fontUrl from '../../assets/fonts/LiberationSans-Bold.ttf?url';
import { ICON_PIXELS, isIcon } from '../../src/cards/config.js';
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

/**
 * Turn a picture the owner chose into a club icon: drawn small onto a square
 * with a clear background, and kept as a PNG written out as text. Whatever
 * kind of picture went in, only that plain PNG comes out.
 *
 * @param {File} file
 * @returns {Promise<string>} the icon, ready to store with a match or a club
 */
export async function iconFromFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error(`${file.name} is not a picture this browser can read.`));
      image.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = ICON_PIXELS;
    canvas.height = ICON_PIXELS;
    // Fitted inside the square, never stretched. A picture with no size of its own (some SVG files) fills it.
    const [w, h] = [image.naturalWidth || ICON_PIXELS, image.naturalHeight || ICON_PIXELS];
    const scale = Math.min(ICON_PIXELS / w, ICON_PIXELS / h);
    canvas.getContext('2d').drawImage(image, (ICON_PIXELS - w * scale) / 2, (ICON_PIXELS - h * scale) / 2, w * scale, h * scale);
    const picture = canvas.toDataURL('image/png');
    if (!isIcon(picture)) throw new Error(`${file.name} is too detailed to keep as an icon. Try a simpler picture.`);
    return picture;
  } finally {
    URL.revokeObjectURL(url);
  }
}
