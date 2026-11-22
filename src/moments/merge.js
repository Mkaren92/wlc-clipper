// Puts the transcript's suggestions and the chat's candidates into one list,
// when the owner asks for both. A moment both found becomes one item with
// both sources; a moment only one found is kept as it is.
//
// Nothing here touches a file or a program, so the engine and the page can
// both use it. It imports nothing: the chat's `windowActivity` is passed in.

/** How close two starts must be, in seconds, for two candidates to be the same moment. */
export const SAME_START_SECONDS = 15;

/** How sure the AI check must be before its label is used over the chat's keyword label. */
export const AI_LABEL_CONFIDENCE = 0.5;

/** How many seconds two windows share. */
const overlapOf = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

/** Whether a chat candidate's busiest moment falls inside the other window. */
const peakInside = (chat, other) => Number.isFinite(chat?.peakTime) && chat.peakTime >= other.start && chat.peakTime <= other.end;

/**
 * Whether two candidates are the same moment: their windows share at least
 * half of the shorter one, or they start within 15 seconds of each other, or
 * (added beyond the brief, 2026-11-21) the chat burst's peak falls inside the
 * transcript's window. A chat window starts about 20 s before its burst on
 * purpose, so a goal the streamer is heard reacting to was found by both
 * sources yet failed the first two tests: on a test chat, a transcript moment
 * at 199.9-223.8 s and a chat burst peaking at 200 s (window 180-205 s) stayed
 * two items.
 */
function sameMoment(a, b) {
  const shorter = Math.min(a.end - a.start, b.end - b.start);
  return overlapOf(a, b) >= shorter / 2 || Math.abs(a.start - b.start) <= SAME_START_SECONDS || peakInside(b, a) || peakInside(a, b);
}

/** A label, or null when there is none. "none" is how the transcript says there is none. */
// The spec names "none" only for the transcript; it is read the same way from
// the chat side too, since a label called "none" would never be meant.
const labelOrNull = (label) => (typeof label === 'string' && label !== '' && label !== 'none' ? label : null);

/** The transcript moment's label. */
const transcriptLabel = (moment) => labelOrNull(moment?.label);

/**
 * The chat candidate's label: the event words' label when there is one, since the AI check
 * only proposes and is never written over them (a disagreement is marked "needs review");
 * the AI check's own label only for a moment the event words left without one, and only
 * when it is sure enough.
 */
function chatLabel(candidate) {
  const fromWords = labelOrNull(candidate?.label);
  if (fromWords) return fromWords;
  const ai = candidate?.ai;
  const fromAi = ai ? labelOrNull(ai.label) : null;
  return fromAi && ai.confidence >= AI_LABEL_CONFIDENCE ? fromAi : null;
}

/**
 * Each item's place within its own source, from 1 for the top down to 1/n
 * for the last. Items with the same score share the best place of the group.
 * The answer is in the same order as `items`.
 *
 * @param {{ score: number }[]} items
 * @returns {number[]}
 */
export function rankWithin(items) {
  const n = items.length;
  const order = items.map((item, index) => ({ score: item.score, index })).sort((a, b) => b.score - a.score);
  const ranks = new Array(n);
  let groupStart = 0;
  for (const [position, entry] of order.entries()) {
    if (position > 0 && entry.score !== order[position - 1].score) groupStart = position;
    ranks[entry.index] = (n - groupStart) / n;
  }
  return ranks;
}

/**
 * One list from both sources, best first.
 *
 * @param {TranscriptMoment[]} transcript   moments as src/ai/suggest.js returns them
 * @param {ChatCandidate[]} chat            candidates as src/chat/spikes.js returns them
 * @param {{ maxSeconds?: number }} [options]   the longest a merged item may be
 * @returns {Merged[]}
 *
 * @typedef {{ start: number, end: number, score: number, label?: string, [key: string]: unknown }} TranscriptMoment
 * @typedef {{ start: number, end: number, score: number, label: string | null,
 *   ai?: { label: string | null, confidence: number, description: string } | null,
 *   needsReview?: boolean, [key: string]: unknown }} ChatCandidate
 * @typedef {{ start: number, end: number, sources: ('transcript' | 'chat')[], combined: number,
 *   label: string | null, labels: { transcript: string | null, chat: string | null }, needsReview: boolean,
 *   transcript: TranscriptMoment | null, chat: ChatCandidate | null,
 *   lines?: { start: number, end: number, text: string }[], chatActivity?: unknown }} Merged
 */
export function mergeMoments(transcript, chat, { maxSeconds = 60 } = {}) {
  const transcriptRanks = rankWithin(transcript);
  const chatRanks = rankWithin(chat);

  // Pair greedily, best transcript moment first. Equal scores keep their
  // order in the list (the sort is stable): the spec leaves that open.
  const pairedChat = new Set();
  /** @type {Map<number, number>} transcript index -> chat index */
  const pairs = new Map();
  const byScore = transcript.map((moment, index) => ({ moment, index })).sort((a, b) => b.moment.score - a.moment.score);
  for (const { moment, index } of byScore) {
    let best = -1;
    for (const [c, candidate] of chat.entries()) {
      if (pairedChat.has(c) || !sameMoment(moment, candidate)) continue;
      if (best === -1) {
        best = c;
        continue;
      }
      const overlap = overlapOf(moment, candidate);
      const bestOverlap = overlapOf(moment, chat[best]);
      const nearer = Math.abs(candidate.start - moment.start) < Math.abs(chat[best].start - moment.start);
      // The first in the chat list wins a tie in both overlap and distance.
      if (overlap > bestOverlap || (overlap === bestOverlap && nearer)) best = c;
    }
    if (best !== -1) {
      pairedChat.add(best);
      pairs.set(index, best);
    }
  }

  /** @type {Merged[]} */
  const merged = [];
  for (const [t, moment] of transcript.entries()) {
    const tLabel = transcriptLabel(moment);
    const rT = transcriptRanks[t];
    if (!pairs.has(t)) {
      merged.push({
        start: moment.start,
        end: moment.end,
        sources: ['transcript'],
        combined: rT,
        label: tLabel,
        labels: { transcript: tLabel, chat: null },
        needsReview: false,
        transcript: moment,
        chat: null,
      });
      continue;
    }
    const c = pairs.get(t);
    const candidate = chat[c];
    const cLabel = chatLabel(candidate);
    const rC = chatRanks[c];
    const start = Math.min(moment.start, candidate.start);
    const end = Math.min(Math.max(moment.end, candidate.end), start + maxSeconds);
    const differ = tLabel !== null && cLabel !== null && tLabel !== cLabel;
    merged.push({
      start,
      end,
      sources: ['transcript', 'chat'],
      combined: Math.max(rT, rC) + 0.5 * Math.min(rT, rC),
      label: differ ? null : (tLabel ?? cLabel),
      labels: { transcript: tLabel, chat: cLabel },
      needsReview: differ || candidate.needsReview === true,
      // The transcript's hook, title, description and reason, and the chat's
      // topWords, messageCount, termShares and ai, are read from these two.
      transcript: moment,
      chat: candidate,
    });
  }
  for (const [c, candidate] of chat.entries()) {
    if (pairedChat.has(c)) continue;
    const cLabel = chatLabel(candidate);
    merged.push({
      start: candidate.start,
      end: candidate.end,
      sources: ['chat'],
      combined: chatRanks[c],
      label: cLabel,
      labels: { transcript: null, chat: cLabel },
      needsReview: candidate.needsReview === true,
      transcript: null,
      chat: candidate,
    });
  }

  return merged.sort((a, b) => b.combined - a.combined || a.start - b.start);
}

/**
 * The words of a stretch as lines of text, broken where `transcriptLines` in
 * src/ai/suggest.js breaks them: at a sentence's end, a pause over 0.6 s, or
 * 16 words.
 *
 * @param {{ start: number, end: number, text: string }[]} words
 * @returns {{ start: number, end: number, text: string }[]}
 */
export function wordLines(words) {
  const lines = [];
  let line = [];
  const flush = () => {
    if (line.length === 0) return;
    lines.push({ start: line[0].start, end: line.at(-1).end, text: line.map((word) => word.text).join(' ') });
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
  return lines;
}

/**
 * Adds what the other source can say about a single-source item: to one the
 * chat found, what was said in it; to one the transcript found, how busy the
 * chat was. Items found by both are left as they are. Returns new items.
 *
 * @param {Merged[]} merged
 * @param {{ words?: { start: number, end: number, text: string }[], series?: unknown,
 *   windowActivity?: (series: unknown, start: number, end: number) => unknown }} [context]
 * @returns {Merged[]}
 */
export function enrich(merged, { words, series, windowActivity } = {}) {
  return merged.map((item) => {
    if (item.sources.length === 1 && item.sources[0] === 'chat' && words) {
      // A word belongs to the window when it starts inside it.
      const inside = words.filter((word) => word.start >= item.start && word.start < item.end);
      return { ...item, lines: wordLines(inside) };
    }
    if (item.sources.length === 1 && item.sources[0] === 'transcript' && series && windowActivity) {
      return { ...item, chatActivity: windowActivity(series, item.start, item.end) };
    }
    return item;
  });
}
