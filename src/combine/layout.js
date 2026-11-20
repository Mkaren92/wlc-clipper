// The sums behind a combined video: how long it is, how long the screen is
// split, and which part of each video shows in its half.
//
// Nothing here touches a file or a program, so the engine (build.js) and the
// page that previews a combination (web/src/pages/Combiner.vue) both use it.
// What the preview shows is then what gets made.
import { OUT_FPS } from '../layout.js';

/** The sizes a combined video can have. The same two as a compilation. */
export const COMBINE_SIZES = {
  landscape: { width: 1920, height: 1080 },
  portrait: { width: 1080, height: 1920 },
};

/** How much of the split screen the main video can have, in percent. The other video has the rest. */
export const MAIN_SHARES = [50, 60, 70];

/** How far a video can be enlarged beyond filling its half. */
export const MAX_ZOOM = 4;

const toFrame = (seconds) => Math.round(seconds * OUT_FPS) / OUT_FPS;
const even = (pixels) => Math.ceil(pixels / 2) * 2;
const clamp = (value, low, high) => Math.min(Math.max(Number.isFinite(value) ? value : low, low), high);

/**
 * The two parts of the frame while it is split. A wide frame is split left
 * and right; a tall one top and bottom, where "left" is the top. The main
 * video's part is `share` percent of the frame, an even number of pixels.
 *
 * @param {{ width: number, height: number }} size
 * @param {'left' | 'right'} [main]   which side the main video is on
 * @param {number} [share]            how much of the frame it has, in percent
 * @returns {{ wide: boolean, left: Box, right: Box }}
 * @typedef {{ x: number, y: number, width: number, height: number }} Box
 */
export function halves({ width, height }, main = 'left', share = 50) {
  const wide = width >= height;
  const whole = wide ? width : height;
  const mainPart = Math.round((whole * clamp(share, 30, 70)) / 200) * 2;
  const first = main === 'left' ? mainPart : whole - mainPart;
  return wide
    ? { wide, left: { x: 0, y: 0, width: first, height }, right: { x: first, y: 0, width: width - first, height } }
    : { wide, left: { x: 0, y: 0, width, height: first }, right: { x: 0, y: first, width, height: height - first } };
}

/**
 * Which part of a video shows in a box. The video is first made just large
 * enough to cover the box, then enlarged by `zoom`, and `x` and `y` say which
 * part of what sticks out is kept: 0 is the left or top edge, 0.5 the middle,
 * 1 the right or bottom edge.
 *
 * @param {{ width: number, height: number }} source   the video's own size
 * @param {{ width: number, height: number }} box      the half it goes in
 * @param {{ zoom?: number, x?: number, y?: number }} [part]
 * @returns {{ width: number, height: number, x: number, y: number }}
 *   the size to scale the video to, and where in it the box sits
 */
export function shownPart(source, box, { zoom = 1, x = 0.5, y = 0.5 } = {}) {
  const scale = Math.max(box.width / source.width, box.height / source.height) * clamp(zoom, 1, MAX_ZOOM);
  const width = Math.max(even(source.width * scale), box.width);
  const height = Math.max(even(source.height * scale), box.height);
  return { width, height, x: Math.round((width - box.width) * clamp(x, 0, 1)), y: Math.round((height - box.height) * clamp(y, 0, 1)) };
}

/**
 * The part of a file a video's settings ask for, held to what the file has.
 *
 * @param {{ start?: number | null, end?: number | null }} video
 * @param {number} duration   the file's length in seconds
 * @returns {{ start: number, seconds: number }}
 */
export function rangeOf(video, duration) {
  const start = clamp(video.start ?? 0, 0, Math.max(duration, 0));
  const end = clamp(video.end ?? duration, start, Math.max(duration, start));
  return { start, seconds: end - start };
}

/**
 * How long the combined video is and how long its screen is split, in whole
 * frames. It lasts as long as the main video's part; the screen is split
 * while the other video's part runs, and the main video has it all after.
 *
 * @param {number} mainSeconds    length of the main video's part
 * @param {number} otherSeconds   length of the other video's part
 * @returns {{ seconds: number, split: number }}
 */
export function timing(mainSeconds, otherSeconds) {
  const seconds = toFrame(mainSeconds);
  return { seconds, split: Math.min(toFrame(otherSeconds), seconds) };
}
