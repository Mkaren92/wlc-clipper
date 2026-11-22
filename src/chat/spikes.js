// Moments found in a stream's chat: where far more people write than usual,
// or where many suddenly write the same kind of thing ("goal").
//
// Nothing here touches a file or a program, so the engine and the dashboard
// page (its activity chart) both use it.
import { compileTerms, matchedLabels, tokenize } from './terms.js';

/** @typedef {{ t: number, author: string, text: string }} ChatMessage */
/** @typedef {import('./terms.js').TermGroup} TermGroup */
/**
 * @typedef {object} Candidate
 * @property {'chat'} source
 * @property {number} start            the clip window, in seconds of the local video
 * @property {number} end
 * @property {number} eventStart       start of the first busy bucket
 * @property {number} peakTime         start of the busiest bucket
 * @property {number} peakRatio        its count over its baseline
 * @property {number} uniqueAuthors    different writers in the busiest bucket
 * @property {number} messageCount     messages in the window
 * @property {number} activityScore
 * @property {number} score
 * @property {Array<{ word: string, count: number }>} topWords
 * @property {string | null} label
 * @property {Record<string, number>} termShares
 * @property {Record<string, number>} termCounts
 * @property {number} bestTermShare
 * @property {boolean} termSpike
 */

export const SPIKE_DEFAULTS = {
  bucketSeconds: 5, baselineWindowSeconds: 300, spikeRatio: 3, minMessages: 8, minUniqueAuthors: 5,
  mergeGapSeconds: 20, chatLagSeconds: 5, preRollSeconds: 15, postRollSeconds: 10, ignoreFirstSeconds: 120,
  maxCandidates: 20, termMode: 'boost', minTermShare: 0.15, termBoost: 2, minTermMessages: 5, minClipSeconds: 10,
};

/** The defaults with the given options laid over them, the messages that count, and their words and groups. */
function prepare(messages, options = {}) {
  const o = { ...SPIKE_DEFAULTS, ...options };
  const valid = (messages ?? []).filter((m) => m && Number.isFinite(m.t));
  // "The last message's t" when no length is given: the latest one, since they may come unsorted.
  const duration = Number.isFinite(o.duration) ? o.duration : valid.reduce((most, m) => Math.max(most, m.t), 0);
  const groups = o.terms ?? [];
  const compiled = compileTerms(groups);
  const termMode = groups.length ? o.termMode : 'off';
  const kept = valid
    .filter((m) => m.t >= 0 && m.t <= duration)
    .sort((a, b) => a.t - b.t)
    .map((m) => {
      const tokens = tokenize(m.text);
      return { t: m.t, author: String(m.author), tokens, labels: new Set(matchedLabels(tokens, compiled)) };
    });
  return { o, duration, groups, compiled, termMode, kept };
}

const bucketCount = (duration, size) => Math.max(1, Math.ceil(duration / size));

/** Per bucket: how many messages and how many different writers. A message at the very end goes in the last bucket. */
function countBuckets(list, n, size) {
  const counts = new Array(n).fill(0);
  const authors = Array.from({ length: n }, () => new Set());
  for (const m of list) {
    const i = Math.min(n - 1, Math.floor(m.t / size));
    counts[i]++;
    authors[i].add(m.author);
  }
  return { counts, authors: authors.map((set) => set.size) };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Each bucket's baseline (the median of the buckets before it, at least 1)
 * and whether it is a spike. The window is rounded down to whole buckets.
 */
function findSpikes({ counts, authors }, o, minMessages) {
  const k = Math.max(1, Math.floor(o.baselineWindowSeconds / o.bucketSeconds));
  return counts.map((count, i) => {
    const baseline = Math.max(1, median(counts.slice(Math.max(0, i - k), i)));
    const ratio = count / baseline;
    const spike = ratio >= o.spikeRatio && count >= minMessages && authors[i] >= o.minUniqueAuthors
      && i * o.bucketSeconds >= o.ignoreFirstSeconds;
    return { baseline, ratio, spike };
  });
}

/** Spike buckets close together made into events, each with its busiest bucket. */
function groupEvents(spikes, authors, size, gap) {
  const events = [];
  let current = null;
  spikes.forEach((bucket, i) => {
    if (!bucket.spike) return;
    const start = i * size;
    if (current && start - current.lastEnd <= gap) {
      current.lastEnd = start + size;
      if (bucket.ratio > current.peakRatio) Object.assign(current, { peakRatio: bucket.ratio, peakTime: start, uniqueAuthors: authors[i] });
    } else {
      current = { eventStart: start, lastEnd: start + size, peakRatio: bucket.ratio, peakTime: start, uniqueAuthors: authors[i] };
      events.push(current);
    }
  });
  return events;
}

/** The clip window around an event, inside the video and at least `minClipSeconds` long where the video allows. */
function clipWindow(event, o, duration) {
  let start = Math.min(Math.max(event.eventStart - o.chatLagSeconds - o.preRollSeconds, 0), duration);
  let end = Math.min(Math.max(event.peakTime - o.chatLagSeconds + o.postRollSeconds, 0), duration);
  if (end < start) end = start;
  if (end - start < o.minClipSeconds) {
    end = Math.min(duration, start + o.minClipSeconds);
    if (end - start < o.minClipSeconds) start = Math.max(0, end - o.minClipSeconds);
  }
  return { start, end };
}

/** What the messages in [start, end] say: how many, their commonest words, and each group's share. */
function describeWindow(kept, start, end, ctx) {
  const inside = kept.filter((m) => m.t >= start && m.t <= end);
  const words = new Map();
  for (const m of inside) {
    for (const word of new Set(m.tokens)) {
      const short = word.length === 1 || /^\p{N}+$/u.test(word);
      if (short && !ctx.termWords.has(word)) continue;
      words.set(word, (words.get(word) ?? 0) + 1);
    }
  }
  const topWords = [...words]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0))
    .slice(0, 10);
  const termShares = {};
  const termCounts = {};
  if (ctx.termMode !== 'off') {
    for (const group of ctx.groups) {
      const count = inside.filter((m) => m.labels.has(group.label)).length;
      termCounts[group.label] = count;
      termShares[group.label] = inside.length ? count / inside.length : 0;
    }
  }
  return { messageCount: inside.length, topWords, termShares, termCounts };
}

/** The group with the highest share, if it reaches `minTermShare`. A tie goes to the group listed first. */
function bestLabel(termShares, groups, minTermShare) {
  let label = null;
  let share = 0;
  for (const group of groups) {
    const value = termShares[group.label] ?? 0;
    if (value >= minTermShare && value > share) [label, share] = [group.label, value];
  }
  return { label, share };
}

const boosted = (activityScore, share, o, termMode) => (termMode === 'off' ? activityScore : activityScore * (1 + o.termBoost * share));
// Windows that share some time; ones that only touch at an edge do not overlap.
const overlaps = (a, b) => a.start < b.end && b.start < a.end;

/**
 * The chat's busy moments, best first. Pure: it only reads the messages.
 *
 * @param {ChatMessage[]} messages   on the local video's clock, in any order
 * @param {Partial<typeof SPIKE_DEFAULTS> & { duration?: number, terms?: TermGroup[] }} [options]
 * @returns {Candidate[]}
 */
export function detectSpikes(messages, options = {}) {
  const { o, duration, groups, termMode, kept } = prepare(messages, options);
  if (!kept.length) return [];
  const n = bucketCount(duration, o.bucketSeconds);
  const termWords = new Set(compileTerms(groups).flatMap((g) => g.variants).filter((v) => v.tokens.length === 1).map((v) => v.tokens[0]));
  const ctx = { termMode, groups, termWords };

  const total = countBuckets(kept, n, o.bucketSeconds);
  const events = groupEvents(findSpikes(total, o, o.minMessages), total.authors, o.bucketSeconds, o.mergeGapSeconds);

  /** @type {Candidate[]} */
  let candidates = events.map((event) => {
    const { start, end } = clipWindow(event, o, duration);
    const about = describeWindow(kept, start, end, ctx);
    const activityScore = event.peakRatio * Math.log(1 + event.uniqueAuthors);
    const best = termMode === 'off' ? { label: null, share: 0 } : bestLabel(about.termShares, groups, o.minTermShare);
    return {
      source: 'chat', start, end, eventStart: event.eventStart, peakTime: event.peakTime, peakRatio: event.peakRatio,
      uniqueAuthors: event.uniqueAuthors, messageCount: about.messageCount, activityScore,
      score: boosted(activityScore, best.share, o, termMode), topWords: about.topWords, label: best.label,
      termShares: about.termShares, termCounts: about.termCounts, bestTermShare: best.share, termSpike: false,
    };
  });

  if (termMode !== 'off') {
    for (const group of groups) {
      const matching = kept.filter((m) => m.labels.has(group.label));
      const rate = countBuckets(matching, n, o.bucketSeconds);
      const termEvents = groupEvents(findSpikes(rate, o, o.minTermMessages), rate.authors, o.bucketSeconds, o.mergeGapSeconds);
      for (const event of termEvents) {
        const window = clipWindow(event, o, duration);
        const about = describeWindow(kept, window.start, window.end, ctx);
        const activityScore = event.peakRatio * Math.log(1 + event.uniqueAuthors);
        const share = about.termShares[group.label] ?? 0;
        const score = boosted(activityScore, share, o, termMode);
        // It merges with the first candidate found in total activity that it overlaps (one already
        // grown by an earlier merge counts). Term spikes of different groups are not merged with each other.
        const host = candidates.find((one) => !one.termOnly && overlaps(one, window));
        if (host) {
          const start = Math.min(host.start, window.start);
          const end = Math.max(host.end, window.end);
          // messageCount, topWords and the shares describe the window, so they are worked out again for the joined one.
          const joined = describeWindow(kept, start, end, ctx);
          const best = bestLabel(joined.termShares, groups, o.minTermShare);
          const label = best.label ?? group.label;
          Object.assign(host, joined, {
            start, end, score: Math.max(host.score, score), label,
            bestTermShare: joined.termShares[label] ?? 0, termSpike: true,
          });
        } else {
          candidates.push({
            source: 'chat', start: window.start, end: window.end, eventStart: event.eventStart, peakTime: event.peakTime,
            peakRatio: event.peakRatio, uniqueAuthors: event.uniqueAuthors, messageCount: about.messageCount, activityScore,
            score, topWords: about.topWords, label: group.label, termShares: about.termShares, termCounts: about.termCounts,
            bestTermShare: share, termSpike: true, termOnly: true,
          });
        }
      }
    }
  }

  if (termMode === 'only') candidates = candidates.filter((one) => one.label !== null);
  return candidates
    .map(({ termOnly, ...one }) => one)
    // Equal scores: the earlier moment first.
    .sort((a, b) => b.score - a.score || a.start - b.start)
    .slice(0, o.maxCandidates);
}

/**
 * The chat's activity per bucket, for the page's chart and for judging a
 * window found another way (the transcript).
 *
 * @param {ChatMessage[]} messages
 * @param {Partial<typeof SPIKE_DEFAULTS> & { duration?: number, terms?: TermGroup[] }} [options]
 * @returns {{ bucketSeconds: number, buckets: Array<{ t: number, count: number, authors: number, baseline: number, spike: boolean }>, termRates?: Record<string, number[]> }}
 */
export function activitySeries(messages, options = {}) {
  const { o, duration, groups, kept } = prepare(messages, options);
  const n = bucketCount(duration, o.bucketSeconds);
  const total = countBuckets(kept, n, o.bucketSeconds);
  const spikes = findSpikes(total, o, o.minMessages);
  const series = {
    bucketSeconds: o.bucketSeconds,
    buckets: total.counts.map((count, i) => ({
      t: i * o.bucketSeconds, count, authors: total.authors[i], baseline: spikes[i].baseline, spike: spikes[i].spike,
    })),
  };
  if (groups.length) {
    series.termRates = Object.fromEntries(groups.map((group) => [
      group.label, countBuckets(kept.filter((m) => m.labels.has(group.label)), n, o.bucketSeconds).counts,
    ]));
  }
  return series;
}

/**
 * How busy the chat was in [start, end): the messages in the buckets that
 * overlap it, and their mean count over their mean baseline.
 *
 * @param {{ bucketSeconds: number, buckets: Array<{ t: number, count: number, baseline: number }> }} series
 * @param {number} start
 * @param {number} end
 * @returns {{ messages: number, ratio: number }}
 */
export function windowActivity(series, start, end) {
  const inside = series.buckets.filter((b) => b.t < end && b.t + series.bucketSeconds > start);
  if (!inside.length) return { messages: 0, ratio: 0 };
  const messages = inside.reduce((sum, b) => sum + b.count, 0);
  const baseline = inside.reduce((sum, b) => sum + b.baseline, 0);
  // Equal numbers of buckets on both sides, so the ratio of the means is the ratio of the sums.
  return { messages, ratio: messages / baseline };
}
