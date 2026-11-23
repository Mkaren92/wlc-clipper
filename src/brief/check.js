import { cleanOverlayText } from '../captions/ass.js';
import { OUT_HEIGHT, OUT_WIDTH } from '../layout.js';
import { formatClock } from '../time.js';

/** @typedef {import('./schema.js').Brief} Brief */
/** @typedef {import('../types.js').Word} Word */

/**
 * What the rules look at. Before the render only part of it exists; a rule
 * whose input is still missing is left out of the result.
 *
 * @typedef {object} CheckInput
 * @property {Brief} brief
 * @property {number} seconds        full clip length, end card included
 * @property {string} layout
 * @property {string} title
 * @property {string} description
 * @property {string[]} hashtags     as they stand in post.txt
 * @property {{ hook?: string | null, disclosure?: string | null, tag?: string | null, endCard?: string | null }} onScreen
 *   text drawn over the picture
 * @property {Word[] | null} [words]            the transcript, once there is one
 * @property {string | null} [subtitleFile]     contents of captions.ass, once written
 * @property {{ width: number, height: number, audioStreams: number } | null} [clip]
 *   the rendered file, once it exists
 */

/** @typedef {{ rule: string, pass: boolean, detail?: string }} CheckResult */

const LENGTH_SLACK = 0.05;

/**
 * Compare a clip and its post text with a brief.
 *
 * @param {CheckInput} input
 * @returns {CheckResult[]} one entry per rule that applies
 */
export function runChecks(input) {
  return RULES.map((rule) => rule(input)).filter(Boolean);
}

/**
 * Whether `term` appears in `text` as a whole word or phrase, ignoring case.
 * "art" is not found in "start".
 *
 * @param {string} text
 * @param {string} term
 */
export function containsTerm(text, term) {
  const escaped = term.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

const RULES = [
  function length({ brief, seconds }) {
    const { minSeconds: min, maxSeconds: max } = brief;
    if (min === undefined && max === undefined) return null;
    const tooShort = min !== undefined && seconds < min - LENGTH_SLACK;
    const tooLong = max !== undefined && seconds > max + LENGTH_SLACK;
    const allowed = [min !== undefined && `at least ${min} s`, max !== undefined && `at most ${max} s`]
      .filter(Boolean)
      .join(' and ');
    return result('Length', !tooShort && !tooLong, `the clip is ${seconds.toFixed(1)} s; the brief asks for ${allowed}`);
  },

  function requiredHashtags({ brief, hashtags }) {
    const { required, strictOrder } = brief.hashtags;
    if (required.length === 0) return null;
    const posted = hashtags.map((tag) => tag.toLowerCase());
    const positions = required.map((tag) => posted.indexOf(tag.toLowerCase()));
    const missing = required.filter((_, i) => positions[i] === -1);
    if (missing.length > 0) return result('Required hashtags', false, `missing from post.txt: ${missing.join(' ')}`);
    const inOrder = positions.every((position, i) => i === 0 || position > positions[i - 1]);
    return result('Required hashtags', !strictOrder || inOrder, `they must come in this order: ${required.join(' ')}`);
  },

  function descriptionKeywords({ brief, description }) {
    const terms = brief.descriptionMustInclude;
    if (terms.length === 0) return null;
    return result(
      'Description keywords',
      terms.some((term) => containsTerm(description, term)),
      `the description needs at least one of: ${terms.join(', ')}`,
    );
  },

  function onScreenText({ brief, onScreen }) {
    const terms = brief.onScreenTextMustInclude;
    if (terms.length === 0) return null;
    const shown = [onScreen.hook, onScreen.disclosure, onScreen.tag, onScreen.endCard].filter(Boolean).join('\n');
    const missing = terms.filter((term) => !containsTerm(shown, term));
    return result(
      'On-screen text',
      missing.length === 0,
      `not found in the hook, disclosure, channel tag or end-card text: ${missing.join(', ')}`,
    );
  },

  function forbiddenTerms({ brief, title, description, onScreen, words }) {
    const terms = brief.forbiddenTerms;
    if (terms.length === 0) return null;
    const places = [
      ['the title', title],
      ['the description', description],
      ['the hook', onScreen.hook],
      ['the on-screen disclosure', onScreen.disclosure],
      ['the channel tag', onScreen.tag],
      ['the end-card text', onScreen.endCard],
    ];
    const found = [];
    for (const term of terms) {
      for (const [place, text] of places) {
        if (text && containsTerm(text, term)) found.push(`"${term}" is in ${place}`);
      }
      const spokenAt = words ? findSpoken(words, term) : null;
      if (spokenAt !== null) found.push(`"${term}" is in the captions at ${formatClock(spokenAt)}`);
    }
    return result('Forbidden terms', found.length === 0, found.join('; '));
  },

  function disclosure({ brief, hashtags, subtitleFile }) {
    const { mode, text } = brief.disclosure;
    if (mode === 'none') return null;
    if (mode === 'hashtag') {
      const posted = hashtags.some((tag) => tag.toLowerCase() === text.toLowerCase());
      return result('Disclosure', posted, `${text} is missing from the hashtags in post.txt`);
    }
    // Looked up in the subtitle file itself, so it reflects what was drawn.
    if (subtitleFile === undefined) return null;
    const drawn = Boolean(subtitleFile) && subtitleFile.includes(cleanOverlayText(text));
    return result('Disclosure', drawn, `"${text}" is not drawn on the video`);
  },

  function format({ clip }) {
    if (!clip) return null;
    const problems = [];
    if (clip.width !== OUT_WIDTH || clip.height !== OUT_HEIGHT) {
      problems.push(`the clip is ${clip.width}x${clip.height}, not ${OUT_WIDTH}x${OUT_HEIGHT}`);
    }
    if (clip.audioStreams === 0) problems.push('the clip has no sound');
    return result('Format', problems.length === 0, problems.join('; '));
  },

  // A brief with an overlay: the clip must have been rendered with that image.
  function overlay({ brief, overlay: shown }) {
    if (!brief.overlay) return null;
    const wanted = brief.overlay.image.split(/[\\/]/).pop();
    if (shown === undefined) return null; // not known here (a check made before anything is drawn)
    if (!shown) return result('Overlay', false, `the brief asks for the overlay ${wanted}, and the clip was rendered without one`);
    const got = String(shown.image).split(/[\\/]/).pop();
    return result('Overlay', got === wanted, got === wanted ? `${got} is shown for the whole clip` : `the brief asks for ${wanted}, and the clip shows ${got}`);
  },

  function fullFrame({ brief, layout }) {
    if (!brief.keepFullFrame) return null;
    return result(
      'Full frame',
      layout === 'blur',
      `the brief needs the whole source frame visible, which only the blur layout keeps; this clip uses ${layout}`,
    );
  },
];

/** @returns {CheckResult} */
function result(rule, pass, detail) {
  return pass ? { rule, pass } : { rule, pass, detail };
}

/**
 * Find a term in the transcript and return the time it is spoken, or null.
 * Punctuation attached to the transcript's words is ignored.
 */
function findSpoken(words, term) {
  const wanted = term.toLowerCase().split(/\s+/).filter(Boolean);
  const spoken = words.map((word) => word.text.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''));
  for (let i = 0; i + wanted.length <= spoken.length; i++) {
    if (wanted.every((part, j) => spoken[i + j] === part)) return words[i].start;
  }
  return null;
}
