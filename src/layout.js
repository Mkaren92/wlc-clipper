/** @typedef {import('./types.js').VideoInfo} VideoInfo */

export const OUT_WIDTH = 1080;
export const OUT_HEIGHT = 1920;
export const OUT_FPS = 30;
export const LAYOUTS = ['center', 'blur', 'facecam'];

// Names used inside the clip folder. ffmpeg runs there, so the filter graph
// can refer to both by bare name and nothing needs escaping.
export const SUBTITLE_FILE = 'captions.ass';
export const FONTS_LINK = 'fonts';

// Background of the end card, behind the image if there is one.
export const CARD_COLOUR = '0x111111';

// The facecam layout: webcam panel on top, gameplay panel below.
export const CAM_HEIGHT = 640;
const GAME_HEIGHT = OUT_HEIGHT - CAM_HEIGHT;

// A source this close to the wanted shape is scaled without cropping.
const ASPECT_TOLERANCE = 0.005;
// Every graph starts by converting to the output frame rate. Doing it here,
// and not with ffmpeg's `-r` output option, keeps picture and sound aligned:
// on ffmpeg 4.4.2, `-r 30` on a 60 fps source put the picture two frames late.
const INPUT = `[0:v]fps=${OUT_FPS}`;
// --trim is for a thin frame baked into a recording, not for cutting content
// away, so it is limited to this share of the shorter side.
const MAX_TRIM_SHARE = 0.05;

/**
 * Build the ffmpeg filter graph that turns the source into a 1080x1920
 * picture. The graph reads `[0:v]` and ends in `[v]`.
 *
 * @param {object} options
 * @param {string} options.layout
 * @param {VideoInfo} options.source
 * @param {number} [options.cropX]   left edge of the crop, center layout only
 * @param {number} [options.trim]    pixels cut off every edge of the source first
 * @param {{ x: number, y: number, width: number, height: number }} [options.cam]
 *   webcam rectangle in source pixels, facecam layout only
 * @param {boolean} [options.subtitles]   burn in the clip folder's subtitle file
 * @param {{ at: number, seconds: number, image?: boolean }} [options.endCard]
 *   show the card for `seconds` after the footage ends at `at`. The card's
 *   plain background is ffmpeg's second input; with `image`, a picture is the
 *   third input and is centred on that background.
 * @returns {{ graph: string, cropX: number | null, audioLabel: string | null }}
 *   `cropX` is the left edge that was used, or null when the layout does not
 *   crop sideways. `audioLabel` names the sound output when the graph makes
 *   one; otherwise the source's sound is used as it is.
 */
export function buildFilter({ layout, source, cropX, trim = 0, cam, subtitles = false, endCard }) {
  if (!LAYOUTS.includes(layout)) {
    throw new Error(`Unknown layout "${layout}". Use one of: ${LAYOUTS.join(', ')}.`);
  }
  if (cropX !== undefined && layout !== 'center') {
    throw new Error('--crop-x only applies to the center layout.');
  }
  if (cam && layout !== 'facecam') {
    throw new Error('--cam only applies to the facecam layout.');
  }

  const area = usableArea(source, trim);
  const end = pictureEnd({ subtitles, endCard });

  let picture;
  if (layout === 'center') picture = centerFilter(area, cropX, end);
  else if (layout === 'blur') picture = { graph: blurGraph(area, end), cropX: null };
  else picture = { graph: facecamGraph(source, area, cam, end), cropX: null };

  // The card adds time after the footage, so the sound needs silence to match.
  if (endCard && source.audioStreams > 0) {
    return { ...picture, graph: `${picture.graph};[0:a:0]apad=pad_dur=${endCard.seconds}[a]`, audioLabel: '[a]' };
  }
  return { ...picture, audioLabel: null };
}

/**
 * The last steps of every layout: square pixels, then the end card, then the
 * subtitles on top of everything.
 */
function pictureEnd({ subtitles, endCard }) {
  let steps = 'setsar=1';
  if (endCard) {
    const size = `${OUT_WIDTH}:${OUT_HEIGHT}`;
    const cover = `overlay=0:0:enable='gte(t,${endCard.at})'`;
    // Hold the last frame for the length of the card, then cover it.
    const hold = `${steps},tpad=stop_mode=clone:stop_duration=${endCard.seconds}[base]`;
    steps = endCard.image
      ? [
          hold,
          // The picture goes onto the plain background first, so a logo with
          // a transparent background does not let the footage show through.
          `[2:v]scale=${size}:force_original_aspect_ratio=decrease[picture]`,
          '[1:v][picture]overlay=(W-w)/2:(H-h)/2[card]',
          `[base][card]${cover}`,
        ].join(';')
      : `${hold};[base][1:v]${cover}`;
  }
  if (subtitles) steps += `,subtitles=${SUBTITLE_FILE}:fontsdir=${FONTS_LINK}`;
  return `${steps}[v]`;
}

/**
 * Describe, in source pixels, the windows the layouts take from a video, so
 * a screen can draw them over the picture. Uses the same arithmetic as the
 * filter graphs.
 *
 * @param {VideoInfo} source
 * @param {number} [trim]
 * @returns {{
 *   area: { x: number, y: number, width: number, height: number },
 *   center: CropWindow,
 *   game: CropWindow,
 *   camAspect: number,
 * }} `center` is the 9:16 window of the center layout, `game` the lower
 *   panel of the facecam layout, `camAspect` the shape of its webcam panel.
 */
export function describeLayouts(source, trim = 0) {
  const area = usableArea(source, trim);
  return {
    area: { x: area.x, y: area.y, width: area.width, height: area.height },
    center: cropWindow(area, OUT_WIDTH / OUT_HEIGHT),
    game: cropWindow(area, OUT_WIDTH / GAME_HEIGHT),
    camAspect: OUT_WIDTH / CAM_HEIGHT,
  };
}

/**
 * @typedef {object} CropWindow
 * @property {number} x        left edge when centred
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {number | null} minX   smallest and largest left edge --crop-x
 * @property {number | null} maxX   can take; null when it cannot move sideways
 */

/** @returns {CropWindow} */
function cropWindow(area, aspect) {
  const sourceAspect = area.width / area.height;
  if (sourceAspect > aspect + ASPECT_TOLERANCE) {
    const width = toEven(area.height * aspect);
    const maxX = area.x + area.width - width;
    return { x: area.x + Math.floor((maxX - area.x) / 2), y: area.y, width, height: area.height, minX: area.x, maxX };
  }
  if (sourceAspect < aspect - ASPECT_TOLERANCE) {
    const height = toEven(area.width / aspect);
    return { x: area.x, y: area.y + Math.floor((area.height - height) / 2), width: area.width, height, minX: null, maxX: null };
  }
  return { x: area.x, y: area.y, width: area.width, height: area.height, minX: null, maxX: null };
}

/**
 * The part of the source frame the layouts work with, in source pixels.
 *
 * @returns {{ x: number, y: number, width: number, height: number, trimmed: boolean }}
 */
function usableArea(source, trim) {
  const limit = Math.floor(Math.min(source.width, source.height) * MAX_TRIM_SHARE);
  if (trim > limit) {
    throw new Error(`--trim can be at most ${limit} pixels for a ${source.width}x${source.height} video.`);
  }
  return {
    x: trim,
    y: trim,
    width: source.width - 2 * trim,
    height: source.height - 2 * trim,
    trimmed: trim > 0,
  };
}

/** Crop a 9:16 window out of the source, then scale it to the output size. */
function centerFilter(area, cropX, end) {
  const fit = fitCrop(area, OUT_WIDTH / OUT_HEIGHT, cropX);
  if (cropX !== undefined && fit.cropX === null) {
    throw new Error('--crop-x needs a source wider than 9:16; this one has nothing to crop sideways.');
  }
  return {
    graph: `${INPUT},${fit.step}scale=${OUT_WIDTH}:${OUT_HEIGHT},${end}`,
    cropX: fit.cropX,
  };
}

/** The whole frame in the middle, over a blurred copy that fills the screen. */
function blurGraph(area, end) {
  const size = `${OUT_WIDTH}:${OUT_HEIGHT}`;
  const trim = area.trimmed ? `,${cropStep(area)}` : '';
  return [
    `${INPUT}${trim},split=2[a][b]`,
    `[a]scale=${size}:force_original_aspect_ratio=increase,crop=${size},boxblur=20:5[bg]`,
    `[b]scale=${size}:force_original_aspect_ratio=decrease:force_divisible_by=2[fg]`,
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,${end}`,
  ].join(';');
}

/** The webcam rectangle on top, the middle of the gameplay below it. */
function facecamGraph(source, area, cam, end) {
  if (!cam) throw new Error('The facecam layout needs --cam x,y,w,h: the webcam rectangle in source pixels.');
  if (cam.width <= 0 || cam.height <= 0 || cam.x + cam.width > source.width || cam.y + cam.height > source.height) {
    throw new Error(`The --cam rectangle does not fit inside the ${source.width}x${source.height} video.`);
  }
  const camSize = `${OUT_WIDTH}:${CAM_HEIGHT}`;
  const game = fitCrop(area, OUT_WIDTH / GAME_HEIGHT);
  return [
    `${INPUT},split=2[a][b]`,
    `[a]${cropStep(cam)},scale=${camSize}:force_original_aspect_ratio=increase,crop=${camSize}[cam]`,
    `[b]${game.step}scale=${OUT_WIDTH}:${GAME_HEIGHT}[game]`,
    `[cam][game]vstack=inputs=2,${end}`,
  ].join(';');
}

/**
 * Find the largest window of the wanted shape inside `area`.
 *
 * @param {{ x: number, y: number, width: number, height: number, trimmed: boolean }} area
 * @param {number} aspect   wanted width divided by height
 * @param {number} [cropX]  left edge in source pixels; centred when missing
 * @returns {{ step: string, cropX: number | null }} `step` is a crop filter
 *   followed by a comma, or empty when no crop is needed.
 */
function fitCrop(area, aspect, cropX) {
  const window = cropWindow(area, aspect);
  if (window.minX !== null) {
    const x = clamp(cropX ?? window.x, window.minX, window.maxX);
    return { step: `${cropStep({ ...window, x })},`, cropX: x };
  }
  // Nothing to move sideways. Crop only if the window is smaller than the frame.
  const cropped = window.height !== area.height || area.trimmed;
  return { step: cropped ? `${cropStep(window)},` : '', cropX: null };
}

function cropStep({ x, y, width, height }) {
  return `crop=${width}:${height}:${x}:${y}`;
}

/** H.264 with 4:2:0 colour needs even sizes. */
function toEven(n) {
  return Math.max(2, Math.floor(n / 2) * 2);
}

function clamp(n, low, high) {
  return Math.min(Math.max(n, low), high);
}
