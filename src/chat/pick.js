// Choosing the moments to download from a finished stream: where chat reacted, and
// where viewers pointed in the comments.
//
// Asked for by the owner on 2026-11-21: paste a finished live stream's link, give a
// few words (or none) and a number of clips, and get that many short parts of the
// video around its best moments. With words, moments with the words come first and
// the rest is filled up with the best others.
//
// What counts (changed the same day, after a gaming stream's clips were polls and
// giveaways): not how much chat wrote but how it reacted (reactions.js: laughter,
// hype, shock, a loss, "clip it"; commands, poll votes and pasted messages left
// out), and the moments viewers' comments point to (comments.js). A moment both
// point to rises to the top.
//
// Each part runs from `before` seconds before the moment to `after` seconds after.
// A chat moment is taken a few seconds earlier than the chat (people type after
// they see it); a comment's time is the moment itself.
//
// Pure, like spikes.js: no Node imports, so it can be tested and shown alike.
import { commentMarks, commentMoments } from './comments.js';
import { PRESETS } from './presets.js';
import { reactionStream, reactionSummary } from './reactions.js';
import { detectSpikes } from './spikes.js';
import { compileTerms, matchedLabels, matchTerms, normalizeText, parseTermGroups } from './terms.js';

export const CLIP_DEFAULTS = { count: 6, before: 30, after: 30, lag: 5, maxCount: 20 };

// A chat moment counts as matching the words only when this many of its messages hold
// them. One mention is chatter: on a real 2-hour watchalong (2026-11-21), bursts of 4 to 6
// messages with one "who scored for Belgium??" were taken as goals ahead of real moments.
export const MIN_MATCHING_MESSAGES = 2;

// From the brief's thresholds down to what a quiet chat reaches, on the stream of
// reactions only. The first tier that gives enough moments wins.
const TIERS = [
  {},
  { spikeRatio: 2.5, minMessages: 5, minUniqueAuthors: 4 },
  { spikeRatio: 2, minMessages: 3, minUniqueAuthors: 3 },
  { spikeRatio: 1.5, minMessages: 2, minUniqueAuthors: 2 },
];

/**
 * The owner's words as term groups. A word that belongs to a preset's group brings
 * the whole group, so "goal" also counts "gol", "golazo" and "GOOOOL"; any other
 * word is a group of its own.
 *
 * @param {string} text   words separated by commas, such as "goal, penalty"
 * @returns {import('./terms.js').TermGroup[]}
 */
export function expandWords(text) {
  const words = String(text ?? '').split(',').map((word) => word.trim()).filter(Boolean).slice(0, 20);
  const known = Object.values(PRESETS).flatMap((preset) => preset.groups);
  const groups = [];
  for (const word of words) {
    const key = normalizeText(word);
    const group = known.find((one) => normalizeText(one.label) === key || one.terms.some((term) => normalizeText(term) === key));
    const chosen = group ? { label: group.label, terms: [...group.terms] } : { label: word.slice(0, 40), terms: [word.slice(0, 60)] };
    if (!groups.some((one) => one.label === chosen.label)) groups.push(chosen);
  }
  return parseTermGroups(groups);
}

/** A rank from 1 (best) down to 1/n, by score; equal scores share the better rank. */
function ranks(items, score) {
  const sorted = [...items].sort((a, b) => score(b) - score(a));
  const n = sorted.length;
  const rank = new Map();
  sorted.forEach((item, i) => {
    const firstEqual = sorted.findIndex((other) => score(other) === score(item));
    rank.set(item, (n - Math.min(i, firstEqual)) / n);
  });
  return rank;
}

/**
 * The moments to download.
 *
 * @param {Array<{ t: number, author: string, text: string }>} messages   on the stream's clock
 * @param {object} options
 * @param {number} options.duration   the stream's length in seconds
 * @param {import('./terms.js').TermGroup[]} [options.groups]
 * @param {Array<{ text: string, likes?: number }>} [options.comments]   the video's top comments
 * @param {number} [options.count]
 * @param {number} [options.before]   seconds before the moment
 * @param {number} [options.after]    seconds after it
 * @param {number} [options.lag]      how much earlier than the chat a chat moment is taken to be
 * @param {Array<{ start: number, end: number }>} [options.skip]
 *   parts already suggested (in the stream's seconds): no moment that would share a second with one is chosen
 */
export function pickChatMoments(messages, { duration, groups = [], comments = [], count = CLIP_DEFAULTS.count, before = CLIP_DEFAULTS.before, after = CLIP_DEFAULTS.after, lag = CLIP_DEFAULTS.lag, skip = [] }) {
  const want = Math.max(1, Math.min(CLIP_DEFAULTS.maxCount, Math.floor(count)));
  const words = groups.length > 0 ? compileTerms(groups) : null;
  const wordMatch = (text) => Boolean(words && matchedLabels(text, words).length > 0);
  const stream = reactionStream(messages, { wordMatch });
  // A moment's clip runs from `before` ahead of its first second to `after` past its last.
  const taken = (from, until) => skip.some((part) => from - before < part.end && part.start < until + after);
  const fromComments = commentMoments(commentMarks(comments, duration)).filter((moment) => !taken(moment.at, moment.until));

  // Chat moments: bursts of reactions. A label comes only from enough messages with the words.
  // With parts to skip, more candidates are read, so that as many new ones can be found.
  const maxCandidates = 60 + 3 * skip.length;
  const chat = [];
  for (const tier of TIERS) {
    const candidates = detectSpikes(stream, { duration, terms: groups, termMode: groups.length > 0 ? 'boost' : 'off', maxCandidates, ...tier });
    for (const candidate of candidates) {
      const at = Math.max(0, candidate.eventStart - lag);
      if (taken(at, at)) continue;
      if (chat.some((one) => Math.abs(one.at - at) < before + after)) continue;
      const label = candidate.label && (candidate.termCounts?.[candidate.label] ?? 0) >= MIN_MATCHING_MESSAGES ? candidate.label : null;
      chat.push({ at, score: candidate.score, peakRatio: candidate.peakRatio, label });
    }
    const matched = chat.filter((one) => one.label).length;
    if ((groups.length > 0 ? matched : chat.length + fromComments.length) >= want) break;
  }

  // Comment moments: a comment with the owner's words counts as matching them.
  const commentLabel = (moment) => {
    if (!words) return null;
    for (const text of moment.texts) {
      const found = matchTerms(text, words);
      if (found.length > 0) return found[0].label;
    }
    return null;
  };

  // One list: a chat moment and a comment moment close together are one moment, found by both.
  const chatRank = ranks(chat, (one) => one.score);
  const commentRank = ranks(fromComments, (one) => one.weight);
  // Two or more viewers pointing at the same moment, independently, is as strong a sign as any:
  // such a moment ranks with the moments both chat and comments found.
  const commentScore = (moment) => commentRank.get(moment) + (moment.pointers >= 2 ? 0.5 : 0);
  // A moment has a first and a last second: one for a chat burst, the span of their times for comments.
  const items = chat.map((one) => ({ at: one.at, until: one.at, label: one.label, chat: one, comments: null, combined: chatRank.get(one) }));
  for (const moment of fromComments) {
    const near = items.find((item) => item.chat && !item.comments && Math.abs(item.at - moment.at) <= (before + after) / 2 + lag);
    const rank = commentScore(moment);
    if (near) {
      near.comments = moment;
      // Viewers' own pointer is the surer of the two times.
      near.until = Math.max(near.at, moment.until);
      near.at = moment.at;
      near.label ??= commentLabel(moment);
      near.combined = Math.max(near.combined, rank) + 0.5 * Math.min(near.combined, rank);
    } else {
      items.push({ at: moment.at, until: moment.until, label: commentLabel(moment), chat: null, comments: moment, combined: rank });
    }
  }

  // Matches first, then the best of the rest; never two clips that share a second.
  const ranked = items.sort((a, b) => Number(Boolean(b.label)) - Number(Boolean(a.label)) || b.combined - a.combined);
  const chosen = [];
  for (const item of ranked) {
    if (chosen.length >= want) break;
    // A chat moment moved onto a comment's time may now reach a part already suggested.
    if (taken(item.at, item.until)) continue;
    // Never two clips that share a second.
    if (chosen.some((other) => item.at - before < other.until + after && other.at - before < item.until + after)) continue;
    chosen.push(item);
  }
  return chosen.map((item) => {
    const start = Math.max(0, round(item.at - before));
    // At most a minute longer than an ordinary clip, however far apart the comments' times are.
    const end = Math.min(duration, round(Math.min(item.until, item.at + 60) + after));
    const inside = stream.filter((message) => message.t >= start && message.t <= end);
    return {
      start, end, at: round(item.at),
      label: item.label, matched: Boolean(item.label),
      sources: [...(item.chat ? ['chat'] : []), ...(item.comments ? ['comments'] : [])],
      score: round(item.combined * 100) / 100,
      peakRatio: item.chat?.peakRatio ?? 0,
      messages: messages.filter((message) => message.t >= start && message.t <= end).length,
      people: new Set(inside.map((message) => message.author)).size,
      reactions: reactionSummary(inside).slice(0, 4),
      comments: item.comments ? { count: item.comments.marks, likes: item.comments.likes, texts: item.comments.texts } : null,
      // Kept for the page as before: the reactions' own words, most first.
      topWords: topWords(inside),
    };
  }).sort((a, b) => a.start - b.start);
}

function topWords(messages) {
  const counts = {};
  for (const message of messages) {
    const key = normalizeText(message.text).slice(0, 30);
    if (key) counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.entries(counts).map(([word, count]) => ({ word, count })).sort((a, b) => b.count - a.count).slice(0, 6);
}

function round(n) {
  return Math.round(n * 10) / 10;
}
