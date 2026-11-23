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

// The facecam layout: webcam panel on top, gameplay panel below. The webcam panel
// follows the shape of the webcam box (asked for on 2026-11-21: "not all cams are
// 16:9"): full width, as tall as that shape makes it, within these limits so the
// gameplay always keeps at least 40% of the screen and the cam at least a quarter.
// CAM_HEIGHT is the fixed panel of clips made before, which keep it.
export const CAM_HEIGHT = 640;
export const CAM_MIN_HEIGHT = 480;
export const CAM_MAX_HEIGHT = 1152;
const GAME_HEIGHT = OUT_HEIGHT - CAM_HEIGHT;

/**
 * How tall the webcam panel is for a webcam box of this shape: the full width
 * of the clip, and the height that keeps the box's shape, within the limits.
 * A box wider than 1080:480 or taller than 1080:1152 has its edges cropped.
 *
 * @param {{ width: number, height: number } | null | undefined} cam
 * @returns {number} an even number of pixels
 */
export function camPanelHeight(cam) {
  if (!cam || !(cam.width > 0) || !(cam.height > 0)) return CAM_HEIGHT;
  const fitting = toEven((OUT_WIDTH * cam.height) / cam.width);
  return Math.min(CAM_MAX_HEIGHT, Math.max(CAM_MIN_HEIGHT, fitting));
}

/**
 * How a content box the owner drew sits in the lower panel: whole, filling the
 * panel when it has the panel's shape, otherwise with a blurred copy of itself
 * behind it at the sides or above and below.
 *
 * @param {{ width: number, height: number }} game
 * @param {number} camHeight
 * @returns {{ fills: boolean, blurred: 'sides' | 'top and bottom' | null }}
 */
export function gameFit(game, camHeight = CAM_HEIGHT) {
  const panel = OUT_WIDTH / (OUT_HEIGHT - camHeight);
  const shape = game.width / game.height;
  if (Math.abs(shape - panel) <= ASPECT_TOLERANCE * 4) return { fills: true, blurred: null };
  return { fills: false, blurred: shape < panel ? 'sides' : 'top and bottom' };
}

/**
 * A content box of the lower panel's shape, as large as fits inside `game`'s
 * place and centred on it: what "Fit to the panel" makes of the owner's box.
 *
 * @param {{ x: number, y: number, width: number, height: number }} game
 * @param {number} camHeight
 */
export function fitGameToPanel(game, camHeight = CAM_HEIGHT) {
  const window = cropWindow(game, OUT_WIDTH / (OUT_HEIGHT - camHeight));
  return { x: window.x, y: window.y, width: window.width, height: window.height };
}

/**
 * The gameplay window of the facecam layout under a webcam panel this tall:
 * the largest window of the lower panel's shape. The page draws it from this.
 *
 * @param {{ x: number, y: number, width: number, height: number }} area   the usable area (describeLayouts)
 * @param {number} camHeight
 */
export function facecamGameWindow(area, camHeight = CAM_HEIGHT) {
  return cropWindow(area, OUT_WIDTH / (OUT_HEIGHT - camHeight));
}

// --- The overlay: a logo in a corner, or a full-frame picture, for the whole clip ---
export const OVERLAY_POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
export const OVERLAY_DEFAULTS = { width: 220, position: 'top-left', margin: 40, offsetY: 0 };
export const OVERLAY_LIMITS = { width: [20, OUT_WIDTH], margin: [0, 400], offsetY: [-OUT_HEIGHT, OUT_HEIGHT] };
// Where a line of captions is drawn: it ends 520 px above the bottom (CAPTION_MARGIN in
// captions/ass.js) and one line at size 76 with its outline is about 110 px tall. A test
// holds these to the subtitle file's numbers.
export const CAPTION_AREA = { top: OUT_HEIGHT - 520 - 110, bottom: OUT_HEIGHT - 520 };
// The bottom 15% of the frame, where the apps put their own text and buttons.
export const BOTTOM_AREA_TOP = Math.round(OUT_HEIGHT * 0.85);
// A picture this close to 9:16 is a full-frame overlay; anything else is a logo.
const FULL_FRAME_TOLERANCE = 0.01;

/** Whether an image of this size is a full-frame overlay (the clip's 9:16 shape) or a logo. */
export function overlayKind(imageWidth, imageHeight) {
  return Math.abs(imageWidth / imageHeight - OUT_WIDTH / OUT_HEIGHT) <= FULL_FRAME_TOLERANCE ? 'full' : 'logo';
}

/**
 * Where the overlay lands in the clip, in output pixels: the whole frame for a
 * full-frame picture, else the logo at its width in its corner, moved by the offset.
 *
 * @param {{ imageWidth: number, imageHeight: number, kind?: string, width: number, position: string, margin: number, offsetY: number }} overlay
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
export function overlayBox(overlay) {
  if ((overlay.kind ?? overlayKind(overlay.imageWidth, overlay.imageHeight)) === 'full') return { x: 0, y: 0, width: OUT_WIDTH, height: OUT_HEIGHT };
  const width = overlay.width;
  const height = Math.round((width * overlay.imageHeight) / overlay.imageWidth);
  const right = overlay.position.endsWith('right');
  const bottom = overlay.position.startsWith('bottom');
  const x = right ? OUT_WIDTH - width - overlay.margin : overlay.margin;
  const y = (bottom ? OUT_HEIGHT - height - overlay.margin : overlay.margin) + overlay.offsetY;
  return { x, y, width, height };
}

/**
 * What the preview warns about: a logo over the captions, in the bottom 15% the apps
 * cover, or partly off the frame. A full-frame picture is meant to cover everything.
 *
 * @param {Parameters<typeof overlayBox>[0]} overlay
 * @returns {string[]}
 */
export function overlayWarnings(overlay) {
  if ((overlay.kind ?? overlayKind(overlay.imageWidth, overlay.imageHeight)) === 'full') return [];
  const box = overlayBox(overlay);
  const warnings = [];
  if (box.y < CAPTION_AREA.bottom && box.y + box.height > CAPTION_AREA.top) warnings.push('The logo overlaps the captions.');
  if (box.y + box.height > BOTTOM_AREA_TOP) warnings.push('The logo reaches into the bottom 15% of the frame, which the apps cover with their own text and buttons.');
  if (box.x < 0 || box.y < 0 || box.x + box.width > OUT_WIDTH || box.y + box.height > OUT_HEIGHT) warnings.push('Part of the logo is outside the frame.');
  return warnings;
}

/**
 * The filter steps that put the overlay over the laid-out picture. `[pre]` is the
 * picture before the captions; the image is ffmpeg input number `input`. The
 * position expressions are those of the brief: the logo's own size (w, h) is
 * ffmpeg's to work out, from the width and the image's shape.
 */
function overlaySteps(overlay, input) {
  if (overlay.kind === 'full') return `[${input}:v]scale=${OUT_WIDTH}:${OUT_HEIGHT}[lg];[pre][lg]overlay=0:0`;
  const m = overlay.margin;
  const x = overlay.position.endsWith('right') ? `W-w-${m}` : String(m);
  const yBase = overlay.position.startsWith('bottom') ? `H-h-${m}` : String(m);
  const y = overlay.offsetY === 0 ? yBase : `${yBase}${overlay.offsetY > 0 ? '+' : ''}${overlay.offsetY}`;
  return `[${input}:v]scale=${overlay.width}:-1[lg];[pre][lg]overlay=${x}:${y}`;
}

/** ffmpeg's input number for the overlay image: after the source and the end card's one or two. */
export function overlayInput(endCard) {
  return 1 + (endCard ? (endCard.image ? 2 : 1) : 0);
}

// --- Blur boxes: hide part of the picture for part of the clip ---
// Asked for by the owner on 2026-11-21: game footage can show nudity that the apps take
// down (TikTok and Instagram treat a game's like a real one), so a part of the frame is
// blurred or blacked out for a few seconds rather than the whole clip being lost.

export const BLUR_STYLES = ['blur', 'black'];
export const MAX_BLURS = 20;
// Smaller than this and a blur has too little room to hide anything.
export const BLUR_MIN_SIZE = 16;

/**
 * @typedef {object} BlurBox
 * @property {number} x        left edge in source pixels (the whole frame, before any trim)
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {number} start    seconds from the clip's start
 * @property {number} end
 * @property {'blur' | 'black'} style
 */

/**
 * Check blur boxes against the source and the clip's length, and tidy them: even
 * pixels (the picture's colour is stored at half size) and times to the hundredth.
 *
 * @param {Partial<BlurBox>[]} blurs
 * @param {{ width: number, height: number }} source
 * @param {number} length   the clip's footage, in seconds
 * @returns {BlurBox[]}
 */
export function checkBlurs(blurs, source, length) {
  if (!Array.isArray(blurs)) throw new Error('The blur boxes must be a list.');
  if (blurs.length > MAX_BLURS) throw new Error(`A clip can have at most ${MAX_BLURS} blur boxes.`);
  return blurs.map((given, index) => {
    const n = index + 1;
    const style = given.style ?? 'blur';
    if (!BLUR_STYLES.includes(style)) throw new Error(`Blur box ${n}: the style must be one of: ${BLUR_STYLES.join(', ')}.`);
    for (const key of ['x', 'y', 'width', 'height']) {
      if (!Number.isInteger(given[key]) || given[key] < 0) throw new Error(`Blur box ${n}: ${key} must be a whole number of pixels, 0 or more.`);
    }
    const x = given.x - (given.x % 2);
    const y = given.y - (given.y % 2);
    const width = given.width - (given.width % 2);
    const height = given.height - (given.height % 2);
    if (given.x + given.width > source.width || given.y + given.height > source.height) {
      throw new Error(`Blur box ${n} does not fit inside the ${source.width}x${source.height} video.`);
    }
    if (width < BLUR_MIN_SIZE || height < BLUR_MIN_SIZE) throw new Error(`Blur box ${n} must be at least ${BLUR_MIN_SIZE}×${BLUR_MIN_SIZE} pixels.`);
    const start = Math.round(Number(given.start) * 100) / 100;
    const end = Math.round(Number(given.end) * 100) / 100;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      throw new Error(`Blur box ${n}: it must start at 0 s or later and end after it starts.`);
    }
    if (start >= length) throw new Error(`Blur box ${n} starts after the clip ends (${length.toFixed(2)} s).`);
    return { x, y, width, height, start, end: Math.min(end, Math.round(length * 100) / 100), style };
  });
}

/**
 * The first steps of a graph with blur boxes: each box is covered on the source frames,
 * before any layout, so it stays over the same thing wherever the layout puts it. A blur is
 * a crop of the box, blurred hard and laid back where it was; black is a filled box. Both
 * are on only between their start and end. Ends in a stream the layout goes on from.
 *
 * @param {BlurBox[]} blurs   already checked
 */
function coverSteps(blurs) {
  const steps = [];
  let from = INPUT;
  blurs.forEach((box, i) => {
    const when = `enable='between(t,${box.start},${box.end})'`;
    if (box.style === 'black') {
      from = `${from},drawbox=x=${box.x}:y=${box.y}:w=${box.width}:h=${box.height}:color=black:t=fill:${when}`;
      return;
    }
    // A plain blur of a big box still showed shapes (2026-11-21, on game footage), so the box
    // is first shrunk to about a sixteenth of its size and grown back, which keeps only its
    // colours, and then blurred. The blur's reach is held to what the box allows: half its
    // shorter side, and half that again for the colour, which is stored at half size.
    const small = (n) => Math.max(4, 2 * Math.floor(n / 32));
    const side = Math.min(box.width, box.height);
    const luma = Math.max(1, Math.min(40, Math.floor(side / 2) - 1));
    const chroma = Math.max(1, Math.min(20, Math.floor(side / 4) - 1));
    steps.push(`${from},split=2[bv${i}][bc${i}]`);
    steps.push(`[bc${i}]crop=${box.width}:${box.height}:${box.x}:${box.y},scale=${small(box.width)}:${small(box.height)},scale=${box.width}:${box.height}:flags=bicubic,boxblur=${luma}:3:${chroma}:3[bz${i}]`);
    from = `[bv${i}][bz${i}]overlay=${box.x}:${box.y}:${when}`;
  });
  steps.push(`${from}[covered]`);
  return `${steps.join(';')};[covered]null`;
}

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
 * @param {number} [options.cropWidth]   width of the crop in source pixels, center
 *   layout only. Wider than the 9:16 column shows more of the picture, over a
 *   blurred copy that fills the rest of the screen.
 * @param {number} [options.trim]    pixels cut off every edge of the source first
 * @param {{ x: number, y: number, width: number, height: number }} [options.cam]
 *   webcam rectangle in source pixels, facecam layout only
 * @param {number} [options.camHeight]   the webcam panel's height (camPanelHeight); clips made
 *   before it followed the cam's shape have none and keep CAM_HEIGHT
 * @param {import('./overlay.js').Overlay | null} [options.overlay]   shown over the whole clip,
 *   under the captions; without one the graph is exactly what it always was
 * @param {{ x: number, y: number, width: number, height: number }} [options.game]
 *   the content box in source pixels, facecam layout only; without it the middle of the
 *   gameplay is taken, as before
 * @param {BlurBox[]} [options.blurs]   parts of the frame hidden for part of the clip, already
 *   checked (checkBlurs); without any the graph is exactly what it always was
 * @param {{ start: number, end: number }[]} [options.muffle]   clip seconds in which the sound is
 *   muffled (swear words); without any the sound is exactly what it always was
 * @param {boolean} [options.subtitles]   burn in the clip folder's subtitle file
 * @param {{ at: number, seconds: number, image?: boolean }} [options.endCard]
 *   show the card for `seconds` after the footage ends at `at`. The card's
 *   plain background is ffmpeg's second input; with `image`, a picture is the
 *   third input and is centred on that background.
 * @returns {{ graph: string, cropX: number | null, cropWidth: number | null, audioLabel: string | null }}
 *   `cropX` is the left edge that was used, or null when the layout does not
 *   crop sideways. `cropWidth` is the width that was used when it is wider
 *   than the 9:16 column, or null. `audioLabel` names the sound output when
 *   the graph makes one; otherwise the source's sound is used as it is.
 */
export function buildFilter({ layout, source, cropX, cropWidth, trim = 0, cam, camHeight = CAM_HEIGHT, game, overlay = null, blurs = [], muffle = [], subtitles = false, endCard }) {
  if (!LAYOUTS.includes(layout)) {
    throw new Error(`Unknown layout "${layout}". Use one of: ${LAYOUTS.join(', ')}.`);
  }
  if (cropX !== undefined && layout !== 'center') {
    throw new Error('--crop-x only applies to the center layout.');
  }
  if (cropWidth !== undefined && layout !== 'center') {
    throw new Error('--crop-width only applies to the center layout.');
  }
  if (cam && layout !== 'facecam') {
    throw new Error('--cam only applies to the facecam layout.');
  }
  if (game && layout !== 'facecam') {
    throw new Error('--game only applies to the facecam layout.');
  }

  const area = usableArea(source, trim);
  const end = pictureEnd({ subtitles, endCard, overlay });
  const input = blurs.length > 0 ? coverSteps(blurs) : INPUT;

  let picture;
  if (layout === 'center') picture = centerFilter(area, cropX, cropWidth, end, input);
  else if (layout === 'blur') picture = { graph: blurGraph(area, end, input), cropX: null, cropWidth: null };
  else picture = { graph: facecamGraph(source, area, cam, end, camHeight, game, input), cropX: null, cropWidth: null };

  const sound = muffle.length > 0 ? muffleSteps(muffle) : [];
  // The card adds time after the footage, so the sound needs silence to match.
  if (endCard) sound.push(`apad=pad_dur=${endCard.seconds}`);
  if (sound.length > 0 && source.audioStreams > 0) {
    return { ...picture, graph: `${picture.graph};[0:a:0]${sound.join(',')}[a]`, audioLabel: '[a]' };
  }
  return { ...picture, audioLabel: null };
}

// The muffle: everything above this is cut away, three times over, which leaves the rhythm and
// the tone of a voice and takes the word. Measured on 2026-11-23 on a stream recording with the
// local speech recogniser as the judge: at 300 Hz three times none of six muffled words was still
// recognised, at 250 or 350 Hz twice two or three were (see docs/decisions.md).
const MUFFLE_HZ = 300;
const MUFFLE_PASSES = 3;
// The muffled sound came out about 12 dB quieter; this gives a little of that back.
const MUFFLE_GAIN = 1.5;

/**
 * Sound filters that muffle the given windows and leave everything else as it is.
 *
 * @param {{ start: number, end: number }[]} windows   in clip seconds
 * @returns {string[]}
 */
export function muffleSteps(windows) {
  const when = `enable='${windows.map((one) => `between(t,${one.start},${one.end})`).join('+')}'`;
  return [...Array.from({ length: MUFFLE_PASSES }, () => `lowpass=f=${MUFFLE_HZ}:${when}`), `volume=${MUFFLE_GAIN}:${when}`];
}

/**
 * The last steps of every layout: square pixels, then the end card, then the
 * subtitles on top of everything.
 */
function pictureEnd({ subtitles, endCard, overlay = null }) {
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
  // The overlay goes over the picture and the end card, and under the captions, from the
  // first frame to the last.
  if (overlay) steps = `${steps}[pre];${overlaySteps(overlay, overlayInput(endCard))}`;
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
 * @param {number} [cropWidth]   the center layout's crop width, when one was chosen
 * @returns {{
 *   area: { x: number, y: number, width: number, height: number },
 *   center: CropWindow,
 *   centerWidths: { min: number, max: number } | null,
 *   game: CropWindow,
 *   camAspect: number,
 * }} `center` is the window of the center layout: the 9:16 column, or the
 *   wider crop when `cropWidth` asks for one. `centerWidths` is the range that
 *   width can take, or null when the source is not wider than 9:16. `game` is
 *   the lower panel of the facecam layout, `camAspect` the shape of its
 *   webcam panel.
 */
export function describeLayouts(source, trim = 0, cropWidth) {
  const area = usableArea(source, trim);
  const column = cropWindow(area, OUT_WIDTH / OUT_HEIGHT);
  return {
    area: { x: area.x, y: area.y, width: area.width, height: area.height },
    center: centerWindow(area, cropWidth),
    centerWidths: column.minX === null ? null : { min: column.width, max: toEven(area.width) },
    game: cropWindow(area, OUT_WIDTH / GAME_HEIGHT),
    // The shape of the webcam panel before it followed the box; kept for the default box.
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

/**
 * The window the center layout takes: the 9:16 column, or a wider one of the
 * same height when `cropWidth` asks for it. A width outside what the frame
 * allows is brought inside, as --crop-x is.
 *
 * @returns {CropWindow}
 */
function centerWindow(area, cropWidth) {
  const column = cropWindow(area, OUT_WIDTH / OUT_HEIGHT);
  if (cropWidth === undefined || column.minX === null) return column;
  const width = clamp(toEven(cropWidth), column.width, toEven(area.width));
  const maxX = area.x + area.width - width;
  return { x: area.x + Math.floor((maxX - area.x) / 2), y: area.y, width, height: area.height, minX: area.x, maxX };
}

/**
 * Crop a 9:16 column out of the source and scale it to the output size. With
 * a wider crop, the crop is shown whole over a blurred copy of itself.
 */
function centerFilter(area, cropX, cropWidth, end, input = INPUT) {
  const column = cropWindow(area, OUT_WIDTH / OUT_HEIGHT);
  if (column.minX === null && (cropX !== undefined || cropWidth !== undefined)) {
    const option = cropX !== undefined ? '--crop-x' : '--crop-width';
    throw new Error(`${option} needs a source wider than 9:16; this one has nothing to crop sideways.`);
  }
  const window = centerWindow(area, cropWidth);
  if (window.width > column.width) {
    const x = clamp(cropX ?? window.x, window.minX, window.maxX);
    return { graph: blurGraph({ ...window, x, trimmed: true }, end, input), cropX: x, cropWidth: window.width };
  }
  const fit = fitCrop(area, OUT_WIDTH / OUT_HEIGHT, cropX);
  return {
    graph: `${input},${fit.step}scale=${OUT_WIDTH}:${OUT_HEIGHT},${end}`,
    cropX: fit.cropX,
    cropWidth: null,
  };
}

/**
 * The whole of `area` in the middle, over a blurred copy that fills the
 * screen. `area` is the frame for the blur layout, or the center layout's
 * wider crop.
 */
function blurGraph(area, end, input = INPUT) {
  const size = `${OUT_WIDTH}:${OUT_HEIGHT}`;
  const trim = area.trimmed ? `,${cropStep(area)}` : '';
  return [
    `${input}${trim},split=2[a][b]`,
    `[a]scale=${size}:force_original_aspect_ratio=increase,crop=${size},boxblur=20:5[bg]`,
    `[b]scale=${size}:force_original_aspect_ratio=decrease:force_divisible_by=2[fg]`,
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,${end}`,
  ].join(';');
}

/** The webcam rectangle on top, the middle of the gameplay below it. */
function facecamGraph(source, area, cam, end, camHeight, game, input = INPUT) {
  if (!cam) throw new Error('The facecam layout needs --cam x,y,w,h: the webcam rectangle in source pixels.');
  if (cam.width <= 0 || cam.height <= 0 || cam.x + cam.width > source.width || cam.y + cam.height > source.height) {
    throw new Error(`The --cam rectangle does not fit inside the ${source.width}x${source.height} video.`);
  }
  if (!Number.isInteger(camHeight) || camHeight % 2 !== 0 || camHeight < CAM_MIN_HEIGHT || camHeight > CAM_MAX_HEIGHT) {
    throw new Error(`The webcam panel must be an even number of pixels from ${CAM_MIN_HEIGHT} to ${CAM_MAX_HEIGHT} tall.`);
  }
  const gameHeight = OUT_HEIGHT - camHeight;
  const camSize = `${OUT_WIDTH}:${camHeight}`;
  // A box of the panel's own shape fills it exactly; one past the limits loses only its edges.
  const camPart = `[a]${cropStep(cam)},scale=${camSize}:force_original_aspect_ratio=increase,crop=${camSize}[cam]`;
  if (game) {
    // The owner's own content box, chosen apart from the webcam box: shown whole. In the
    // panel's shape it fills it; in another shape a blurred copy of it fills the rest, as the
    // center layout's wider crop does, so nothing the owner chose is cut away.
    if (!(game.width > 0) || !(game.height > 0) || game.x < 0 || game.y < 0 || game.x + game.width > source.width || game.y + game.height > source.height) {
      throw new Error(`The --game rectangle does not fit inside the ${source.width}x${source.height} video.`);
    }
    const size = `${OUT_WIDTH}:${gameHeight}`;
    const content = gameFit(game, camHeight).fills
      ? [`[b]${cropStep(game)},scale=${size}[game]`]
      : [
        `[b]${cropStep(game)},split=2[gb][gf]`,
        `[gb]scale=${size}:force_original_aspect_ratio=increase,crop=${size},boxblur=20:5[gbg]`,
        `[gf]scale=${size}:force_original_aspect_ratio=decrease:force_divisible_by=2[gfg]`,
        `[gbg][gfg]overlay=(W-w)/2:(H-h)/2[game]`,
      ];
    return [`${input},split=2[a][b]`, camPart, ...content, `[cam][game]vstack=inputs=2,${end}`].join(';');
  }
  const window = fitCrop(area, OUT_WIDTH / gameHeight);
  return [
    `${input},split=2[a][b]`,
    camPart,
    `[b]${window.step}scale=${OUT_WIDTH}:${gameHeight}[game]`,
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
