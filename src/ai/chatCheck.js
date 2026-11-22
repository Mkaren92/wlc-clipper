// The optional AI check of chat candidates: what happened in each window, judged
// from what chat said (and what the streamer said, when the transcript is already
// kept). Keyword labels misfire ("no goal", "that should be a red card",
// "penalty?"), so a second opinion is offered, never forced on the result.
//
// One request for all candidates, not one each: 20 requests would take minutes
// and spend 20 times the plan's usage. Only text leaves the machine: the
// messages' words and times, never who wrote them (the owner's choice,
// 2026-11-21), and transcript lines only from a transcript already kept.
import { z } from 'zod';
import { cleanOverlayText } from '../captions/ass.js';

/** @typedef {import('./client.js').Ai} Ai */
/** @typedef {import('../chat/terms.js').TermGroup} TermGroup */

const MESSAGES_PER_WINDOW = 50;
const MAX_CANDIDATES = 20;
export const MIN_CONFIDENCE = 0.5;
// The general labels used when no event terms are given. "donation or raid" is offered only when asked for.
export const GENERAL_LABELS = ['funny', 'hype', 'fail', 'drama', 'other'];
export const DONATION_LABEL = 'donation or raid';

const answerSchema = z.object({
  moments: z.array(z.object({ number: z.number(), label: z.string(), confidence: z.number(), description: z.string() })),
});

/**
 * @param {object} options
 * @param {Array<{ start: number, end: number, label: string | null }>} options.candidates   chat candidates, on the video's clock
 * @param {Array<{ t: number, text: string }>} options.messages   the chat on the video's clock
 * @param {Array<{ text: string, start: number, end: number }> | null} [options.words]   a kept transcript, if any
 * @param {TermGroup[]} [options.terms]
 * @param {string} [options.guidance]
 * @param {boolean} [options.donations]   offer "donation or raid" as a label
 * @param {Ai} options.ai
 * @param {(step: string) => void} [options.onStep]
 * @returns {Promise<{ results: Array<{ ai: { label: string | null, confidence: number, description: string } | null, needsReview: boolean }>, error: string | null, model: string, usage: { input: number, output: number } }>}
 *   one result per candidate, in order. On a failed request every `ai` is null and `error` says so in our words.
 */
export async function checkChatMoments({ candidates, messages, words = null, terms = [], guidance = '', donations = false, ai, onStep = () => {} }) {
  const list = candidates.slice(0, MAX_CANDIDATES);
  const labels = terms.length > 0 ? terms.map((group) => group.label) : [...GENERAL_LABELS, ...(donations ? [DONATION_LABEL] : [])];
  const blank = { results: list.map((candidate) => ({ ai: null, needsReview: Boolean(candidate.needsReview) })), model: ai.model, usage: { input: 0, output: 0 } };
  if (!ai.isConfigured()) return { ...blank, error: ai.help };
  if (list.length === 0) return { ...blank, error: null };

  onStep('thinking');
  let answer;
  try {
    answer = await ai.ask({ system: instructions({ labels, terms, guidance, withTranscript: Boolean(words?.length) }), user: windows(list, messages, words), schema: answerSchema, schemaName: 'chat_moments' });
  } catch {
    // The service's own message can repeat part of a key, so it is not passed on.
    return { ...blank, error: `${ai.service} could not check the chat moments. The keyword labels are kept.` };
  }
  return { results: tidyChecks(answer.data?.moments, list, labels), error: null, model: ai.model, usage: answer.usage };
}

function instructions({ labels, terms, guidance, withTranscript }) {
  const lines = [
    'You look at moments of a finished live stream that its chat reacted to, and say what happened in each.',
    `Each moment is numbered and lists chat messages with their time in seconds${withTranscript ? ', then what the streamer said at the same time' : ''}.`,
    'Chat reacts a few seconds after something happens. Messages are from many different viewers.',
    `For each moment write: number; label, exactly one of ${labels.map((label) => JSON.stringify(label)).join(', ')}, or "none"; confidence from 0 to 1; description: one short sentence of what happened.`,
    'Words alone do not prove an event: "no goal", "that should be a red card" and "penalty?" contain the words without the event. Say "none" when you are not sure.',
  ];
  if (terms.length > 0) {
    lines.push('The labels are events the person is looking for, with words that may be used about them:');
    for (const group of terms) lines.push(`- ${group.label}: ${group.terms.join(', ')}`);
  }
  if (guidance) lines.push('What makes a good moment, in the words of the person asking:', guidance);
  return lines.join('\n');
}

/** Each candidate's window as text: up to 50 messages spread across it, and the streamer's words. */
function windows(list, messages, words) {
  return list.map((candidate, index) => {
    const inside = messages.filter((message) => message.t >= candidate.start && message.t <= candidate.end);
    const step = Math.max(1, inside.length / MESSAGES_PER_WINDOW);
    const chosen = [];
    for (let i = 0; i < inside.length && chosen.length < MESSAGES_PER_WINDOW; i += step) chosen.push(inside[Math.floor(i)]);
    const parts = [`Moment ${index + 1}: ${candidate.start.toFixed(1)} to ${candidate.end.toFixed(1)} s, ${inside.length} messages`];
    for (const message of chosen) parts.push(`[${message.t.toFixed(1)}] ${message.text}`);
    if (words?.length) {
      const said = words.filter((word) => word.start >= candidate.start && word.start < candidate.end).map((word) => word.text).join(' ');
      if (said) parts.push(`Streamer said: ${said}`);
    }
    return parts.join('\n');
  }).join('\n\n');
}

/**
 * What the model sent, made safe: one result per candidate, a label only when it
 * is one of ours and confident enough, and "needs review" when it disagrees with
 * the keyword label. A candidate the model skipped keeps its keyword result.
 *
 * @param {unknown} raw
 * @param {Array<{ label: string | null, needsReview?: boolean }>} list
 * @param {string[]} labels
 */
export function tidyChecks(raw, list, labels) {
  const byNumber = new Map();
  for (const item of Array.isArray(raw) ? raw : []) {
    const number = Number(item?.number);
    if (Number.isInteger(number) && number >= 1 && number <= list.length && !byNumber.has(number)) byNumber.set(number, item);
  }
  return list.map((candidate, index) => {
    const item = byNumber.get(index + 1);
    if (!item) return { ai: null, needsReview: Boolean(candidate.needsReview) };
    const confidence = Number.isFinite(item.confidence) ? Math.min(1, Math.max(0, item.confidence)) : 0;
    const named = labels.find((label) => label.toLowerCase() === String(item.label ?? '').trim().toLowerCase()) ?? null;
    const label = confidence >= MIN_CONFIDENCE ? named : null;
    // Model-written text is shown on the page only; it is still made one plain line.
    const description = cleanOverlayText(String(item.description ?? '')).replace(/\s+/g, ' ').trim().slice(0, 200);
    const disagrees = Boolean(candidate.label && label && candidate.label !== label);
    return { ai: { label, confidence, description }, needsReview: Boolean(candidate.needsReview) || disagrees };
  });
}
