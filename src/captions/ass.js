import { CAM_HEIGHT, OUT_HEIGHT, OUT_WIDTH } from '../layout.js';
import { formatAssTime } from '../time.js';
import { captionWidth } from './width.js';

// The bundled font. The file sits in assets/fonts, and the name here must
// match the family name inside it.
export const FONT_NAME = 'Liberation Sans';
export const FONT_FILE = 'LiberationSans-Bold.ttf';

export const HOOK_SECONDS = 2.5;
export const HOOK_MAX_CHARS = 60;
export const DISCLOSURE_SECONDS = 3;

// Top margin of the hook. Its white box reaches 18 px above the text, so 240
// keeps the box below the top 200 px of the frame.
const HOOK_MARGIN = 240;
// In the facecam layout the hook sits just under the webcam panel, off the face.
const HOOK_MARGIN_FACECAM = CAM_HEIGHT + 30;
// Captions end 520 px above the bottom edge, clear of the player's buttons.
const CAPTION_MARGIN = 520;
const CAPTION_SIDE_MARGIN = 60;
const CAPTION_MAX_WIDTH = OUT_WIDTH - 2 * CAPTION_SIDE_MARGIN;
// End-card text sits where captions do. Its box reaches 18 px below the
// text, so the margin is a little larger to end at the same height.
const CARD_TEXT_MARGIN = CAPTION_MARGIN + 20;

// Colours are &HAABBGGRR. Caption: white with a black outline, bottom centre.
// Hook: black on a white box (BorderStyle 3), top centre.
const HEADER = `[Script Info]
ScriptType: v4.00+
PlayResX: ${OUT_WIDTH}
PlayResY: ${OUT_HEIGHT}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,${FONT_NAME},88,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,6,0,2,${CAPTION_SIDE_MARGIN},${CAPTION_SIDE_MARGIN},${CAPTION_MARGIN},1
Style: Hook,${FONT_NAME},64,&H00000000,&H00000000,&H00FFFFFF,&H00FFFFFF,-1,0,0,0,100,100,0,0,3,18,0,8,80,80,${HOOK_MARGIN},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

/**
 * Build the subtitle file that carries everything drawn over the picture:
 * the caption groups, the hook line, an on-screen disclosure and the text on
 * the end card.
 *
 * @param {object} options
 * @param {{ text: string, start: number, end: number }[]} [options.groups]
 * @param {string | null} [options.hook]
 * @param {string | null} [options.disclosure]   shown at the top for the first 3 seconds
 * @param {{ text: string, seconds: number } | null} [options.endCard]
 *   text shown on the card, which follows the footage
 * @param {string} options.layout
 * @param {number} options.clipSeconds   length of the footage, without the card
 * @returns {string}
 */
export function buildAss({ groups = [], hook = null, disclosure = null, endCard = null, layout, clipSeconds }) {
  const lines = [HEADER];

  // 0 means "use the style's margin". \q0 lets these lines wrap; captions
  // never wrap (WrapStyle 2) because their groups are short by construction.
  const topMargin = layout === 'facecam' ? HOOK_MARGIN_FACECAM : 0;
  // The disclosure is written first: when two top lines are on screen
  // together, the renderer puts the earlier event above the later one.
  if (disclosure) {
    const end = Math.min(DISCLOSURE_SECONDS, clipSeconds);
    lines.push(event(1, 0, end, 'Hook', topMargin, `{\\q0}${cleanOverlayText(disclosure)}`));
  }
  if (hook) {
    const end = Math.min(HOOK_SECONDS, clipSeconds);
    lines.push(event(1, 0, end, 'Hook', topMargin, `{\\q0}${cleanOverlayText(hook)}`));
  }
  if (endCard?.text) {
    // \an2 moves this one line to the bottom centre.
    const text = `{\\an2\\q0}${cleanOverlayText(endCard.text)}`;
    lines.push(event(1, clipSeconds, clipSeconds + endCard.seconds, 'Hook', CARD_TEXT_MARGIN, text));
  }

  for (const group of groups) {
    lines.push(event(0, group.start, group.end, 'Caption', 0, fitCaption(cleanOverlayText(group.text))));
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Make text safe to put in a subtitle event: braces and backslashes are
 * control characters in this format, and an event is a single line.
 *
 * @param {string} text
 * @returns {string}
 */
export function cleanOverlayText(text) {
  return text.replace(/[{}\\]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Check a hook line before any work starts.
 *
 * @param {string} text
 * @returns {string} the cleaned hook
 */
export function checkHook(text) {
  const hook = cleanOverlayText(text);
  if (!hook) throw new Error('--hook is empty.');
  if (hook.length > HOOK_MAX_CHARS) {
    throw new Error(
      `--hook is ${hook.length} characters; the limit is ${HOOK_MAX_CHARS}, which is two lines on screen.`,
    );
  }
  return hook;
}

/**
 * Captions never wrap, so a group of wide letters ("WWWWWW MMMMM") or one
 * very long word could run off the frame. Shrink such a line to fit.
 */
function fitCaption(text) {
  const width = captionWidth(text);
  if (width <= CAPTION_MAX_WIDTH) return text;
  const percent = Math.floor((CAPTION_MAX_WIDTH / width) * 100);
  return `{\\fscx${percent}\\fscy${percent}}${text}`;
}

function event(layer, start, end, style, marginV, text) {
  return `Dialogue: ${layer},${formatAssTime(start)},${formatAssTime(end)},${style},,0,0,${marginV},,${text}`;
}
