import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { runChecks } from '../brief/check.js';
import { buildHashtags } from '../brief/postText.js';
import { cleanOverlayText, HOOK_MAX_CHARS } from '../captions/ass.js';
import { findPauses, snapToSpeech } from '../captions/pauses.js';
import { compileTerms, matchTerms } from '../chat/terms.js';
import { onScreenTexts } from '../cut.js';
import { formatClock } from '../time.js';
import { probe } from '../probe.js';
import { extractAudio } from '../render.js';
import { checkTranscript } from '../transcribe/index.js';

/** @typedef {import('../types.js').Word} Word */
/** @typedef {import('../brief/schema.js').Brief} Brief */
/** @typedef {import('./client.js').Ai} Ai */

/**
 * One proposed clip. Nothing here has been cut: it is a suggestion for the
 * person to look at.
 *
 * @typedef {object} Moment
 * @property {number} start        seconds into the source
 * @property {number} end
 * @property {string | null} hook
 * @property {string} title
 * @property {string} description
 * @property {string} reason       why the model picked it
 * @property {number} score        0 to 1, the model's own rating
 * @property {string[]} problems   brief rules this suggestion would fail
 * @property {string} [label]       which event term group it is, when terms were given and the model named one
 * @property {string[]} [matchedTerms]   the terms heard in its window, found by our own matcher
 */

/** @typedef {import('../chat/terms.js').TermGroup} TermGroup */

// A whole-video transcript of a longer source would take very long to make
// on a CPU, so longer videos are refused with a message.
const MAX_SOURCE_MINUTES = 60;
// A fetched hour is a few hundredths over 3600 s (the owner's "0m00s-1h00m00s" was 3600.001 s and was
// refused on 2026-11-21), so a second over the limit is let through.
const LENGTH_SLACK_SECONDS = 1;
const DEFAULT_MIN_SECONDS = 15;
const DEFAULT_MAX_SECONDS = 60;
// Room before the first word and after the last, so neither is clipped.
const LEAD_IN = 0.1;
const LEAD_OUT = 0.25;

// What the model must send back. Kept plain on purpose: every field is
// required and there are no length or range rules, because those are
// checked in tidyMoments, in our own code.
const answerSchema = z.object({
  moments: z.array(
    z.object({
      start: z.number(),
      end: z.number(),
      hook: z.string(),
      title: z.string(),
      description: z.string(),
      reason: z.string(),
      score: z.number(),
    }),
  ),
});

// The answer when event terms or guidance are given: the same, plus the label the model
// chose. Kept plain like the other: the label is checked against the owner's labels in
// tidyMoments, in our own code. Only used when steering is given, so with none the request
// is exactly what it always was.
const steeredSchema = z.object({
  moments: z.array(
    z.object({
      start: z.number(),
      end: z.number(),
      hook: z.string(),
      title: z.string(),
      description: z.string(),
      reason: z.string(),
      score: z.number(),
      label: z.string(),
    }),
  ),
});

// Hints from the pre-scan are capped, so a long video full of one word does not flood the prompt.
const MAX_HINTS = 80;
// Change this when the prompt or the tidying changes, so results kept from before are asked again.
const RESULT_VERSION = 1;

/**
 * Propose moments of a video worth clipping.
 *
 * The whole video is transcribed on this machine (and the transcript kept
 * for next time). Only the transcript text and the brief's rules are sent to
 * the AI service: no audio, no video, no file names.
 *
 * @param {object} options
 * @param {string} options.source
 * @param {number} [options.count]
 * @param {Brief | null} [options.brief]
 * @param {string} [options.lang]
 * @param {string} options.cacheDir      where whole-video transcripts and kept results are
 * @param {import('../transcribe/index.js').Transcriber} options.transcriber
 * @param {Ai} options.ai
 * @param {TermGroup[]} [options.terms]   event terms that steer the model, already checked (parseTermGroups)
 * @param {string} [options.guidance]     the owner's own words on what a good moment is
 * @param {boolean} [options.force]       ask the model again even when a kept result exists
 * @param {(step: string) => void} [options.onStep]
 * @returns {Promise<{ moments: Moment[], model: string, usage: { input: number, output: number }, fromCache: boolean, resultFromCache: boolean }>}
 *   `fromCache`: the transcript was kept from before; `resultFromCache`: so was the model's answer
 */
export async function suggestMoments({ source, count = 5, brief = null, lang = 'en', cacheDir, transcriber, ai, terms = [], guidance = '', force = false, onStep = () => {} }) {
  if (!ai.isConfigured()) throw new Error(ai.help);
  const steer = { terms, guidance: String(guidance ?? '').trim() };
  const steered = steer.terms.length > 0 || steer.guidance !== '';
  const info = await probe(path.resolve(source));
  if (info.audioStreams === 0) throw new Error('This video has no sound, so there is no speech to choose moments from.');
  if (info.duration > MAX_SOURCE_MINUTES * 60 + LENGTH_SLACK_SECONDS) {
    throw new Error(`Suggestions work on videos up to ${MAX_SOURCE_MINUTES} minutes long; this one is ${formatClock(info.duration)}.`);
  }

  const { words, fromCache } = await sourceTranscript({ info, lang, cacheDir, transcriber, onStep });
  if (words.length === 0) throw new Error('No speech was found in this video.');

  // The end card counts toward the brief's length, so the footage gets less.
  const card = brief?.endCard?.seconds ?? 0;
  const limits = {
    min: Math.max(1, (brief?.minSeconds ?? DEFAULT_MIN_SECONDS) - card),
    max: Math.max(2, (brief?.maxSeconds ?? DEFAULT_MAX_SECONDS) - card),
  };

  // The model's answer is kept per video and per set of inputs, so asking again with the same
  // terms and guidance costs nothing, and changing them asks the model but does not transcribe.
  const resultFile = path.join(cacheDir, `moments-${resultKey({ info, lang, count, brief, steer, model: ai.model })}.json`);
  if (!force) {
    const kept = await readKeptResult(resultFile);
    if (kept) {
      return { moments: kept.moments.map((moment) => ({ ...moment, problems: brief ? briefProblems(moment, brief) : [] })), model: kept.model, usage: { input: 0, output: 0 }, fromCache, resultFromCache: true };
    }
  }

  onStep('thinking');
  const compiled = steered ? compileTerms(steer.terms) : null;
  const { data, usage } = await ai.ask(steered
    ? { system: `${instructions({ count, limits, brief })}\n${steeringLines(steer)}`, user: withHints(words, compiled), schema: steeredSchema, schemaName: 'moments' }
    : { system: instructions({ count, limits, brief }), user: transcriptLines(words), schema: answerSchema, schemaName: 'moments' });

  const tidied = tidyMoments(data.moments, { words, duration: info.duration, limits, count, labels: steer.terms.map((group) => group.label), compiled });
  // An answer with nothing usable in it is not kept, so "try again" really asks again.
  if (tidied.length > 0) await keepResult(resultFile, { moments: tidied, model: ai.model });
  const moments = tidied.map((moment) => ({
    ...moment,
    problems: brief ? briefProblems(moment, brief) : [],
  }));
  return { moments, model: ai.model, usage, fromCache, resultFromCache: false };
}

/**
 * The transcript of a whole video if it was made before, without making it.
 * Used where transcribing would be wrong (chat-only suggestions) and the lines
 * are only extra information.
 *
 * @param {{ source: string, lang?: string, cacheDir: string }} options
 * @returns {Promise<Word[] | null>}
 */
export async function keptTranscript({ source, lang = 'en', cacheDir }) {
  const file = await stat(path.resolve(source)).catch(() => null);
  if (!file) return null;
  try {
    return checkTranscript(JSON.parse(await readFile(path.join(cacheDir, transcriptKey(path.resolve(source), file, lang)), 'utf8'))).words;
  } catch {
    return null;
  }
}

// A language code ("en", "pt-BR"). It goes into a file name, so nothing else is let through.
export const LANG_PATTERN = /^[a-z]{2,3}(-[a-z]{2,4})?$/i;

function transcriptKey(file, info, lang) {
  if (!LANG_PATTERN.test(lang)) throw new Error(`"${String(lang).slice(0, 20)}" is not a language code.`);
  return `${path.basename(file)}.${info.size}.${Math.round(info.mtimeMs)}.${lang}.json`;
}

/** A name for one set of inputs: the video as it is now, and everything that changes the answer. */
function resultKey({ info, lang, count, brief, steer, model }) {
  const what = JSON.stringify({ v: RESULT_VERSION, video: path.basename(info.path), size: info.size, duration: info.duration, lang, count, brief, terms: steer.terms, guidance: steer.guidance, model });
  return createHash('sha256').update(what).digest('hex').slice(0, 24);
}

// What is read back is checked like a model's answer: kept files may be from an older version,
// may lack `label` and `matchedTerms`, and must still load.
const keptMoment = z.object({
  start: z.number(), end: z.number(), hook: z.string().nullable(), title: z.string(), description: z.string(),
  reason: z.string(), score: z.number(), label: z.string().optional(), matchedTerms: z.array(z.string()).optional(),
});
const keptResult = z.object({ moments: z.array(keptMoment), model: z.string() });

/** @returns {Promise<{ moments: Omit<Moment, 'problems'>[], model: string } | null>} */
export async function readKeptResult(file) {
  try {
    const parsed = keptResult.safeParse(JSON.parse(await readFile(file, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function keepResult(file, result) {
  await mkdir(path.dirname(file), { recursive: true });
  const partial = `${file}.partial`;
  await writeFile(partial, JSON.stringify(result));
  await rename(partial, file);
}

/**
 * The words of the whole video with their times, made once per video and
 * kept in `cacheDir`. A changed file (size or date) is transcribed again.
 */
async function sourceTranscript({ info, lang, cacheDir, transcriber, onStep }) {
  const file = await stat(info.path);
  const cacheFile = path.join(cacheDir, transcriptKey(info.path, file, lang));
  try {
    return { words: checkTranscript(JSON.parse(await readFile(cacheFile, 'utf8'))).words, fromCache: true };
  } catch {
    // not transcribed yet, or the kept file is unreadable: make it again
  }

  if (!(await transcriber.isInstalled())) {
    throw new Error('Suggestions need the transcriber. Run "npm run setup" to install it.');
  }
  onStep('transcribing');
  await mkdir(cacheDir, { recursive: true });
  const workDir = await mkdtemp(path.join(cacheDir, 'audio-'));
  try {
    const audioFile = await extractAudio({ source: info.path, start: 0, seconds: info.duration, workDir });
    // Batched: a whole video is long, and this transcript is read by the model, not burned in.
    const transcript = checkTranscript(await transcriber.transcribe(audioFile, { lang, batched: true }));
    transcript.words = snapToSpeech(transcript.words, await findPauses(audioFile));
    await writeFile(cacheFile, JSON.stringify(transcript));
    return { words: transcript.words, fromCache: false };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** The task, as told to the model. */
function instructions({ count, limits, brief }) {
  const lines = [
    'You choose moments from a video transcript that would work as short vertical clips for social media.',
    `Pick the ${count} best moments. Each must stand on its own: a viewer who sees only that clip understands it.`,
    `Each moment must last between ${limits.min} and ${limits.max} seconds.`,
    'Start a moment where a sentence starts and end it where a sentence ends. Use only times that appear in the transcript.',
    'Moments must not overlap.',
    'For each moment write:',
    `- hook: one line shown on screen at the start, at most ${HOOK_MAX_CHARS} characters, plain text, no hashtags, no emoji. It must be true to what is said.`,
    '- title: a short title for the post.',
    '- description: one or two sentences for the post.',
    '- reason: one sentence on why this moment works.',
    '- score: your rating from 0 to 1.',
    'Each transcript line starts with its start and end time in seconds, in square brackets.',
  ];
  if (brief) {
    lines.push('The clips are for a campaign with these rules:');
    const shown = [brief.endCard?.text, brief.disclosure.mode === 'onscreen' ? brief.disclosure.text : null].filter(Boolean).join(' ');
    const needed = brief.onScreenTextMustInclude.filter((term) => !shown.toLowerCase().includes(term.toLowerCase()));
    if (needed.length > 0) lines.push(`- The hook must contain: ${needed.join(', ')}.`);
    if (brief.descriptionMustInclude.length > 0) {
      lines.push(`- The description must contain at least one of: ${brief.descriptionMustInclude.join(', ')}.`);
    }
    if (brief.forbiddenTerms.length > 0) {
      lines.push(`- Never use these words in the hook, title or description, and avoid moments where they are spoken: ${brief.forbiddenTerms.join(', ')}.`);
    }
  }
  return lines.join('\n');
}

/**
 * What the owner gave to steer the model, added after the ordinary task. Only
 * used when there are terms or guidance.
 */
function steeringLines({ terms, guidance }) {
  const lines = [];
  if (guidance) lines.push('What makes a good moment in this video, in the words of the person asking:', guidance);
  if (terms.length > 0) {
    lines.push('These are the events the person is looking for, each with words that may be said about it:');
    for (const group of terms) lines.push(`- ${group.label}: ${group.terms.join(', ')}`);
    lines.push('Prefer moments where one of these events happens or is being reacted to. A strong moment that is none of them may still be chosen.');
    lines.push(`For each moment also write label: the one event it is, written exactly as one of ${terms.map((group) => JSON.stringify(group.label)).join(', ')}, or "none".`);
    lines.push('After the transcript there may be a list of hints: lines where those words were found. They are leads to check, not confirmed events: "no goal" or "was that a penalty?" contain the words without the event.');
  } else {
    lines.push('For each moment also write label: "none".');
  }
  return lines.join('\n');
}

/** The transcript, then the lines our own matcher found the terms in, as hints. */
function withHints(words, compiled) {
  const text = transcriptLines(words);
  if (!compiled) return text;
  const hints = [];
  for (const line of text.split('\n')) {
    const found = matchTerms(line.replace(/^\[[^\]]*\]\s*/, ''), compiled);
    if (found.length > 0) hints.push(`${line.match(/^\[[^\]]*\]/)?.[0] ?? ''} ${found.map((group) => group.label).join(', ')}`);
    if (hints.length >= MAX_HINTS) break;
  }
  return hints.length === 0 ? text : `${text}\n\nHints (lines where the words were found; check them):\n${hints.join('\n')}`;
}

/**
 * The transcript as timed lines, a sentence or so each, which is what the
 * model reads.
 *
 * @param {Word[]} words
 * @returns {string}
 */
export function transcriptLines(words) {
  const lines = [];
  let line = [];
  const flush = () => {
    if (line.length === 0) return;
    lines.push(`[${line[0].start.toFixed(1)}-${line.at(-1).end.toFixed(1)}] ${line.map((word) => word.text).join(' ')}`);
    line = [];
  };
  for (const [i, word] of words.entries()) {
    line.push(word);
    const next = words[i + 1];
    const endsSentence = /[.!?]["')\]]*$/.test(word.text);
    const pause = next ? next.start - word.end > 0.6 : true;
    if (endsSentence || pause || line.length >= 16) flush();
  }
  flush();
  return lines.join('\n');
}

/**
 * Turn whatever the model sent into moments that can be trusted: times that
 * sit on real words, lengths inside the limits, a hook that fits, nothing
 * overlapping. A model's answer is a suggestion and can be wrong in any field.
 *
 * @param {unknown[]} raw
 * @param {{ words: Word[], duration: number, limits: { min: number, max: number }, count: number, labels?: string[], compiled?: object | null }} context
 *   `labels`: the owner's labels; a model's label is kept only when it is one of them
 * @returns {Omit<Moment, 'problems'>[]}
 */
export function tidyMoments(raw, { words, duration, limits, count, labels = [], compiled = null }) {
  const tidy = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!Number.isFinite(item?.start) || !Number.isFinite(item?.end) || item.end <= item.start) continue;

    // First word that starts at or just before the wanted start; last word
    // that ends by the wanted end.
    const first = nearest(words, item.start, (word) => word.start);
    let last = nearest(words, item.end, (word) => word.end);
    if (last < first) continue;
    // Too long: drop words from the end until it fits.
    const start = Math.max(0, words[first].start - LEAD_IN);
    while (last > first && words[last].end + LEAD_OUT - start > limits.max) last -= 1;
    const end = Math.min(duration, words[last].end + LEAD_OUT);
    if (end - start < limits.min || end - start > limits.max) continue;

    const moment = {
      start: round(start),
      end: round(end),
      hook: fitHook(item.hook),
      title: oneLine(item.title),
      description: oneLine(item.description),
      reason: oneLine(item.reason),
      score: Number.isFinite(item.score) ? Math.min(1, Math.max(0, item.score)) : 0,
    };
    // Only when terms were given: the label must be one of the owner's, written any case;
    // anything else (or "none") leaves it out. The terms heard are found by our matcher, not the model.
    const label = labels.find((known) => known.toLowerCase() === String(item.label ?? '').trim().toLowerCase());
    if (label) moment.label = label;
    if (compiled) {
      const heard = matchTerms(words.slice(first, last + 1).map((word) => word.text).join(' '), compiled).flatMap((group) => group.terms);
      if (heard.length > 0) moment.matchedTerms = [...new Set(heard)];
    }
    tidy.push(moment);
  }

  // Best first; a moment that overlaps a better one is dropped.
  const kept = [];
  for (const moment of tidy.sort((a, b) => b.score - a.score)) {
    if (kept.every((other) => moment.end <= other.start || moment.start >= other.end)) kept.push(moment);
  }
  return kept.slice(0, count).sort((a, b) => a.start - b.start);
}

/** Rules of the brief that a suggestion would already fail before it is cut. */
function briefProblems(moment, brief) {
  return runChecks({
    brief,
    seconds: moment.end - moment.start + (brief.endCard?.seconds ?? 0),
    layout: 'blur', // the layout is chosen later, so the full-frame rule is not judged here
    title: moment.title || moment.hook || '',
    description: moment.description,
    hashtags: buildHashtags(brief),
    onScreen: onScreenTexts(moment.hook, brief),
  })
    .filter((check) => !check.pass)
    .map((check) => `${check.rule}: ${check.detail}`);
}

function nearest(words, time, at) {
  let best = 0;
  for (let i = 1; i < words.length; i++) {
    if (Math.abs(at(words[i]) - time) < Math.abs(at(words[best]) - time)) best = i;
  }
  return best;
}

/** A hook that fits on screen: cleaned, and cut at a word if it is too long. */
export function fitHook(text) {
  let hook = cleanOverlayText(String(text ?? ''));
  if (hook.length > HOOK_MAX_CHARS) {
    hook = hook.slice(0, HOOK_MAX_CHARS + 1).replace(/\s+\S*$/, '').slice(0, HOOK_MAX_CHARS).trim();
  }
  return hook || null;
}

function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function round(n) {
  return Math.round(n * 100) / 100;
}
