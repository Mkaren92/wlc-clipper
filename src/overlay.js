// The overlay image of a clip: a campaign's logo in a corner, or a full-frame
// picture with transparency, shown for the whole clip. Added on 2026-11-21 from
// a brief the owner supplied ("some campaigns require their logo to be visible
// for the entire clip").
//
// This file reads the image and checks the settings; where the overlay goes and
// how it is drawn are worked out in src/layout.js (overlayBox, overlaySteps), so
// the page can show the same box.
import path from 'node:path';
import { OVERLAY_DEFAULTS, OVERLAY_LIMITS, OVERLAY_POSITIONS, overlayKind } from './layout.js';
import { run } from './run.js';

/**
 * @typedef {object} Overlay
 * @property {string} image   absolute path of the PNG
 * @property {number} imageWidth
 * @property {number} imageHeight
 * @property {'logo' | 'full'} kind   a full-frame picture has the clip's 9:16 shape
 * @property {number} width    the logo's width in the clip, in pixels
 * @property {'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'} position
 * @property {number} margin   from the corner's edges, in pixels
 * @property {number} offsetY  added to the logo's height on screen, in pixels (down is positive)
 */

/** The width and height of an image file, read by ffprobe. */
export async function imageSize(file) {
  let stdout;
  try {
    ({ stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file]));
  } catch {
    throw new Error(`The overlay image cannot be read: ${file}`);
  }
  const stream = JSON.parse(stdout).streams?.[0];
  if (!(stream?.width > 0) || !(stream?.height > 0)) throw new Error(`The overlay image cannot be read: ${file}`);
  return { width: stream.width, height: stream.height };
}

/**
 * Check an overlay's settings, fill in the defaults, and read its image.
 *
 * @param {{ image: string, width?: number, position?: string, margin?: number, offsetY?: number }} given
 * @returns {Promise<Overlay>}
 */
export async function describeOverlay(given) {
  const image = path.resolve(String(given?.image ?? ''));
  // PNG or WebP: both can have a see-through background. (The owner's first logo was a WebP.)
  if (!['.png', '.webp'].includes(path.extname(image).toLowerCase())) throw new Error('The overlay must be a PNG or WebP image (with transparency).');
  const settings = { ...OVERLAY_DEFAULTS, ...Object.fromEntries(Object.entries(given).filter(([, value]) => value !== undefined)) };
  if (!OVERLAY_POSITIONS.includes(settings.position)) throw new Error(`The overlay position must be one of: ${OVERLAY_POSITIONS.join(', ')}.`);
  for (const [name, [low, high]] of Object.entries(OVERLAY_LIMITS)) {
    if (!Number.isInteger(settings[name]) || settings[name] < low || settings[name] > high) {
      throw new Error(`The overlay ${name === 'offsetY' ? 'vertical offset' : name} must be a whole number from ${low} to ${high}.`);
    }
  }
  const size = await imageSize(image);
  return {
    image, imageWidth: size.width, imageHeight: size.height, kind: overlayKind(size.width, size.height),
    width: settings.width, position: settings.position, margin: settings.margin, offsetY: settings.offsetY,
  };
}
