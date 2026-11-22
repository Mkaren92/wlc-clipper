// Hooks for the clip about to be cut: the line shown at the top for its first
// seconds. Asked for by the owner on 2026-11-21, as a button beside the hook box.
//
// The AI rules of this project hold as for suggested moments: only text leaves the
// machine (the words spoken in the clip's range and the brief's rules, never the
// video, the sound or a file name); what comes back is untrusted and is fitted,
// cleaned and checked here; it is only ever shown as a proposal for the owner to
// click; and errors about the service are written here.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { runChecks } from '../brief/check.js';
import { buildHashtags } from '../brief/postText.js';
import { HOOK_MAX_CHARS } from '../captions/ass.js';
import { findPauses, snapToSpeech } from '../captions/pauses.js';
import { onScreenTexts } from '../cut.js';
import { probe } from '../probe.js';
import { extractAudio } from '../render.js';
import { checkTranscript } from '../transcribe/index.js';
import { fitHook, keptTranscript, transcriptLines } from './suggest.js';

/** @typedef {import('./client.js').Ai} Ai */
/** @typedef {import('../brief/schema.js').Brief} Brief */

export const HOOK_COUNT = 3;
// A clip longer than this is not a clip; it would also make a long request.
const MAX_SECONDS = 600;

const answerSchema = z.object({ hooks: z.array(z.string()) });

/**
 * Propose hooks for the range of a video that is about to be cut.
 *
 * @param {object} options
 * @param {string} options.source
 * @param {number} options.start
 * @param {number} options.end
 * @param {Brief | null} [options.brief]
 * @param {string} [options.lang]
 * @param {string} options.cacheDir   where the whole-video transcript may be kept
 * @param {import('../transcribe/index.js').Transcriber} options.transcriber
 * @param {Ai} options.ai
 * @param {(step: string) => void} [options.onStep]
 * @returns {Promise<{ hooks: Array<{ text: string, problems: string[] }>, model: string, usage: { input: number, output: number }, transcribed: boolean }>}
 *   `transcribed`: the range had to be transcribed, as no whole-video transcript was kept
 */
export async function suggestHooks({ source, start, end, brief = null, lang = 'en', cacheDir, transcriber, ai, onStep = () => {} }) {
  if (!ai.isConfigured()) throw new Error(ai.help);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw new Error('Set the start and the end of the clip first.');
  if (end - start > MAX_SECONDS) throw new Error(`A hook is suggested for a clip of up to ${MAX_SECONDS / 60} minutes.`);

  const words = await rangeWords({ source, start, end, lang, cacheDir, transcriber, onStep });
  if (words.length === 0) throw new Error('No speech was found in this range, so there is nothing to base a hook on. Write one, or move the range.');

  onStep('thinking');
  const { data, usage } = await ai.ask({
    system: instructions(brief),
    user: transcriptLines(words),
    schema: answerSchema,
    schemaName: 'hooks',
  });
  return { hooks: tidyHooks(data?.hooks, brief), model: ai.model, usage, transcribed: words.transcribed === true };
}

/**
 * The words spoken in the range, on the clip's own clock: from the kept
 * whole-video transcript when there is one, else by transcribing only the range.
 */
async function rangeWords({ source, start, end, lang, cacheDir, transcriber, onStep }) {
  const kept = await keptTranscript({ source, lang, cacheDir });
  if (kept) {
    return kept.filter((word) => word.end > start && word.start < end).map((word) => ({ ...word, start: Math.max(0, word.start - start), end: word.end - start }));
  }
  if (!(await transcriber.isInstalled())) throw new Error('A hook needs the words spoken in the clip, and the transcriber is not installed. Run "npm run setup".');
  onStep('transcribing');
  const info = await probe(path.resolve(source));
  if (info.audioStreams === 0) throw new Error('This video has no sound, so there is nothing to base a hook on.');
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'clipper-hook-'));
  try {
    const audio = await extractAudio({ source: info.path, start, seconds: Math.min(end, info.duration) - start, workDir });
    const transcript = checkTranscript(await transcriber.transcribe(audio, { lang }));
    const words = snapToSpeech(transcript.words, await findPauses(audio));
    return Object.assign(words, { transcribed: true });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function instructions(brief) {
  const lines = [
    'You write the hook of a short vertical video clip: one line shown on screen at the start, over the video, to make people keep watching.',
    `Write ${HOOK_COUNT} different hooks for the clip whose transcript follows.`,
    `Each at most ${HOOK_MAX_CHARS} characters, plain text, no hashtags, no emoji, no quotation marks around it.`,
    'Each must be true to what is said and happens in the clip: do not invent facts, names or numbers.',
    'Make them different from each other: for example a question, a bold claim, and a reaction.',
    'Each transcript line starts with its start and end time in seconds, in square brackets.',
  ];
  if (brief) {
    const shown = [brief.endCard?.text, brief.disclosure.mode === 'onscreen' ? brief.disclosure.text : null].filter(Boolean).join(' ');
    const needed = brief.onScreenTextMustInclude.filter((term) => !shown.toLowerCase().includes(term.toLowerCase()));
    if (needed.length > 0) lines.push(`Each hook must contain: ${needed.join(', ')}.`);
    if (brief.forbiddenTerms.length > 0) lines.push(`Never use these words: ${brief.forbiddenTerms.join(', ')}.`);
  }
  return lines.join('\n');
}

/**
 * What the model sent, made safe to show and to use: fitted to the hook's limit,
 * cleaned of the characters that are commands in a subtitle file, without
 * repeats, and each with the brief rules it would fail.
 *
 * @param {unknown} raw
 * @param {Brief | null} brief
 * @returns {Array<{ text: string, problems: string[] }>}
 */
export function tidyHooks(raw, brief = null) {
  const hooks = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const text = fitHook(String(item ?? '').replace(/^["“”']+|["“”']+$/g, '').replace(/\s+/g, ' '));
    if (!text || hooks.some((hook) => hook.text.toLowerCase() === text.toLowerCase())) continue;
    hooks.push({ text, problems: brief ? hookProblems(text, brief) : [] });
    if (hooks.length === HOOK_COUNT) break;
  }
  return hooks;
}

/** The brief rules a hook alone can break: words the screen must show, and forbidden words. */
function hookProblems(text, brief) {
  return runChecks({
    brief, seconds: 0, layout: 'blur', title: text, description: '', hashtags: buildHashtags(brief), onScreen: onScreenTexts(text, brief),
  })
    .filter((check) => !check.pass && /^(On-screen text|Forbidden terms)/.test(check.rule))
    .map((check) => `${check.rule}: ${check.detail}`);
}
