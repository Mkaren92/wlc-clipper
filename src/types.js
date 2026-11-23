// Data shapes shared between steps. This file holds JSDoc typedefs only.

/**
 * What `ffprobe` reports about a video file. Width and height are the
 * displayed size, after any rotation flag is applied.
 *
 * @typedef {object} VideoInfo
 * @property {string} path
 * @property {number} width
 * @property {number} height
 * @property {number} fps
 * @property {number} duration   seconds
 * @property {number} audioStreams
 * @property {boolean} isVertical   taller than wide
 */

/**
 * One spoken word. Times are seconds from the start of the clip.
 *
 * @typedef {object} Word
 * @property {string} text
 * @property {number} start
 * @property {number} end
 */

/**
 * Written to `work/transcript.json` in the clip folder. Edit the words there
 * and run `clipper render` to fix a caption.
 *
 * @typedef {object} Transcript
 * @property {string} language
 * @property {Word[]} words
 */

/**
 * Written to `work/meta.json` in each clip folder. It holds every option of the
 * run, so a clip can be traced back to its source and rendered again.
 * `output` is null until the render has finished.
 *
 * @typedef {object} Meta
 * @property {{ name: string, version: string }} tool
 * @property {string} source   absolute path
 * @property {number} start    seconds into the source
 * @property {number} end      seconds into the source
 * @property {string} layout
 * @property {number | null} cropX   left edge of the crop in source pixels
 * @property {number | null} cropWidth   width of the center layout's crop in source pixels
 *   when it is wider than the 9:16 column; null for the column
 * @property {number} trim     pixels cut off every edge of the source first
 * @property {{ x: number, y: number, width: number, height: number } | null} cam
 *   webcam rectangle in source pixels, facecam layout only
 * @property {import('./overlay.js').Overlay | null} overlay
 *   the logo or full-frame picture shown for the whole clip; null for none
 * @property {import('./layout.js').BlurBox[]} blurs
 *   parts of the frame blurred or blacked out for part of the clip; empty for none
 * @property {{ x: number, y: number, width: number, height: number } | null} game
 *   the facecam's content box in source pixels; null takes the middle of the gameplay
 * @property {number | null} camHeight
 *   the webcam panel's height in the clip; null for clips made before it followed the box (640)
 * @property {string | null} hook
 * @property {number} hookSeconds   how long the hook stays on screen; 0 means the whole clip
 * @property {string | null} tag   the channel tag shown at the top for all the footage, as typed; null for none
 * @property {boolean} censor   swear words in the captions and the hook are drawn with a letter covered (F*CK)
 * @property {boolean} muffle   the sound is muffled while a swear word is spoken (needs captions, for the word times)
 * @property {boolean} captions   whether the clip has a transcript to caption from
 * @property {string} lang
 * @property {string | null} briefPath   the brief file the clip was made with
 * @property {import('./brief/schema.js').Brief | null} brief   a copy of that
 *   brief as it was then, so a later render does not depend on the file
 * @property {{ file: string, width: number, height: number, fps: number,
 *   seconds: number, audio: boolean, captionGroups: number, muffled?: number } | null} output
 * @property {import('./brief/check.js').CheckResult[]} checks   result of each brief rule
 * @property {string} createdAt   local time with UTC offset
 */

export {};
