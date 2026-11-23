// Hooks for the clip about to be cut: the line shown at the top for its first
// seconds. Asked for by the owner on 2026-11-21, as a button beside the hook box.
//
// The AI rules of this project hold as for suggested moments: only text leaves the
// machine (the words spoken in the clip's range, the brief's rules, and since
// 2026-11-22 the streamer's name, where the voice is louder than usual and, when
// asked, counts of chat's reactions; never the video, the sound, a chat message's
// words or author, or a file name); what comes back is untrusted and is fitted,
// cleaned and checked here; it is only ever shown as a proposal for the owner to
// click; and errors about the service are written here.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { runChecks } from '../brief/check.js';
import { buildHashtags } from '../brief/postText.js';
import { cleanOverlayText, HOOK_MAX_CHARS } from '../captions/ass.js';
import { findPauses, snapToSpeech } from '../captions/pauses.js';
import { onScreenTexts } from '../cut.js';
import { probe } from '../probe.js';
import { extractAudio } from '../render.js';
import { checkTranscript } from '../transcribe/index.js';
import { chatMood, findLoudness, loudParts, moodLines } from './mood.js';
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
 * @param {string | null} [options.streamer]   the streamer's name, so a hook can say who
 * @param {{ t: number, text: string }[] | null} [options.chat]
 *   the video's chat on its own clock; only counts of its reactions are sent
 * @param {string} options.cacheDir   where the whole-video transcript may be kept
 * @param {import('../transcribe/index.js').Transcriber} options.transcriber
 * @param {Ai} options.ai
 * @param {(step: string) => void} [options.onStep]
 * @returns {Promise<{ hooks: Array<{ text: string, problems: string[] }>, model: string, usage: { input: number, output: number }, transcribed: boolean, used: { loud: number, chat: number } }>}
 *   `transcribed`: the range had to be transcribed, as no whole-video transcript was kept;
 *   `used`: how many loud stretches and chat reactions the request carried
 */
export async function suggestHooks({ source, start, end, brief = null, lang = 'en', streamer = null, chat = null, cacheDir, transcriber, ai, onStep = () => {} }) {
  if (!ai.isConfigured()) throw new Error(ai.help);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw new Error('Set the start and the end of the clip first.');
  if (end - start > MAX_SECONDS) throw new Error(`A hook is suggested for a clip of up to ${MAX_SECONDS / 60} minutes.`);

  const { words, loud } = await rangeSound({ source, start, end, lang, cacheDir, transcriber, onStep });
  const mood = { loud, chat: chat ? chatMood(chat, start, end) : null };
  const chatCount = mood.chat?.messages ?? 0;
  // A scream or chat going wild is something to base a hook on even without words.
  if (words.length === 0 && loud.length === 0 && chatCount === 0) {
    throw new Error('No speech was found in this range, so there is nothing to base a hook on. Write one, or move the range.');
  }

  onStep('thinking');
  const transcript = words.length > 0 ? transcriptLines(words) : '(no words were recognised in this clip)';
  const extra = moodLines(mood);
  const { data, usage } = await ai.ask({
    system: instructions(brief, cleanName(streamer)),
    // With nothing about the sound or chat, the request is the transcript alone, as it was.
    user: extra.length > 0 ? ['Transcript:', transcript, ...extra].join('\n') : transcript,
    schema: answerSchema,
    schemaName: 'hooks',
  });
  return { hooks: tidyHooks(data?.hooks, brief), model: ai.model, usage, transcribed: words.transcribed === true, used: { loud: loud.length, chat: chatCount } };
}

/**
 * The words spoken in the range, on the clip's own clock (from the kept whole-video
 * transcript when there is one, else by transcribing only the range), and where the
 * voice is much louder than usual. The range's sound is read once, for both.
 */
async function rangeSound({ source, start, end, lang, cacheDir, transcriber, onStep }) {
  const kept = await keptTranscript({ source, lang, cacheDir });
  if (!kept && !(await transcriber.isInstalled())) throw new Error('A hook needs the words spoken in the clip, and the transcriber is not installed. Run "npm run setup".');
  const info = await probe(path.resolve(source));
  if (info.audioStreams === 0) {
    if (!kept) throw new Error('This video has no sound, so there is nothing to base a hook on.');
    return { words: keptWords(kept, start, end), loud: [] };
  }
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'clipper-hook-'));
  try {
    const seconds = Math.min(end, info.duration) - start;
    const audio = await extractAudio({ source: info.path, start, seconds, workDir });
    const loud = loudParts(await findLoudness(audio));
    if (kept) return { words: keptWords(kept, start, end), loud };
    onStep('transcribing');
    const transcript = checkTranscript(await transcriber.transcribe(audio, { lang, seconds }));
    const words = snapToSpeech(transcript.words, await findPauses(audio));
    return { words: Object.assign(words, { transcribed: true }), loud };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function keptWords(kept, start, end) {
  return kept.filter((word) => word.end > start && word.start < end).map((word) => ({ ...word, start: Math.max(0, word.start - start), end: word.end - start }));
}

/** The streamer's name as the model is told it: one plain line, no "@". */
function cleanName(name) {
  const clean = cleanOverlayText(String(name ?? '')).replace(/^@+/, '').slice(0, 60).trim();
  return clean || null;
}

function instructions(brief, streamer = null) {
  const lines = [
    'You write the hook of a short vertical video clip from a live stream: one line shown on screen at the start, over the video, to make people keep watching.',
    `Write ${HOOK_COUNT} different hooks for the clip described below.`,
    `Each at most ${HOOK_MAX_CHARS} characters, plain text, no hashtags, no emoji, no quotation marks around it.`,
    'A hook is about the moment and how the streamer feels, not a quote: the reaction (losing it, raging, panicking, in disbelief, overjoyed), what is at stake, or how it ends. Do not just repeat or quote what is said.',
    'Read the feeling from how things are said, from the sound and from chat, as well as from the words. Shouting, screaming and laughing are usually missing from the transcript, so a loud part with few or no words is usually a reaction.',
    'Each must be true to the clip: do not invent events, names or numbers. Say something happened only if the clip shows it; the feeling can be read, the facts cannot be made up.',
    'Make them different from each other: one about the reaction, one about the stakes or a tease of what comes, and one question.',
    'Each transcript line starts with its start and end time in seconds, in square brackets.',
  ];
  if (streamer) {
    lines.push(
      `The streamer is called ${streamer}. Name them in at least two of the hooks, the way a viewer would talk about them: for example "${streamer} loses it after finishing the mission" or "This is the end for ${streamer}".`,
      `Use the name rather than he or she, unless the transcript makes clear how ${streamer} is referred to.`,
    );
  }
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
