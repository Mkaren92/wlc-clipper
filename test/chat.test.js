// Finding moments in a stream's chat. The messages are made here, in code.
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { PRESETS } from '../src/chat/presets.js';
import { activitySeries, detectSpikes, windowActivity } from '../src/chat/spikes.js';
import { compileTerms, matchedLabels, matchTerms, normalizeText, parseTermGroups, tokenize } from '../src/chat/terms.js';

const football = PRESETS.football.groups;

/** One quiet message every 5 seconds, from a rotating set of writers. */
function background(duration, text = 'hello there') {
  const list = [];
  for (let t = 1; t < duration; t += 5) list.push({ t, author: `bg${t % 7}`, text });
  return list;
}

/** `count` messages in the 5 seconds from `at`, from `authors` different writers. */
function burst(at, count, { authors = count, text = () => 'wow' } = {}) {
  return Array.from({ length: count }, (_, i) => ({ t: at + (i * 4.5) / count, author: `u${i % authors}`, text: text(i) }));
}

describe('terms', () => {
  it('makes text comparable', () => {
    expect(normalizeText('GOOOOOL')).toBe('gol');
    expect(normalizeText('goooal')).toBe('goal');
    expect(normalizeText('goal')).toBe('goal');
    expect(normalizeText('Golazó')).toBe('golazo');
    expect(tokenize('GOOOL :_P11Papi: 2-1!')).toEqual(['gol', 'p11papi', '2', '1']);
  });

  it('matches whole words only', () => {
    const compiled = compileTerms(football);
    expect(matchedLabels('the door is open', compiled)).toEqual([]);
    expect(matchedLabels('that is a pen', compiled)).toEqual(['Penalty']);
    expect(matchedLabels('redo it', compileTerms([{ label: 'Red', terms: ['red'] }]))).toEqual([]);
  });

  it('matches phrases as words in a row', () => {
    const compiled = compileTerms(football);
    expect(matchedLabels('WHAT A GOOOAL', compiled)).toEqual(['Goal']);
    expect(matchedLabels('what is a goal', compiled)).toEqual(['Goal']); // by "goal" alone
    expect(matchTerms('what is a goal', compiled)[0].terms).toEqual(['goal']);
    expect(matchedLabels('a red shirt, card later', compiled)).toEqual([]);
    expect(matchedLabels('straight red card', compiled)).toEqual(['Red card']);
  });

  it('counts a message once per group, listing the terms that matched', () => {
    const found = matchTerms('golazo, what a goal, gol gol', compileTerms(football));
    expect(found).toEqual([{ label: 'Goal', terms: ['goal', 'gol', 'golazo', 'what a goal'] }]);
    expect(matchTerms(tokenize('save that pen'), compileTerms(football)).map((m) => m.label)).toEqual(['Penalty', 'Save']);
  });

  it('checks term groups strictly', () => {
    expect(parseTermGroups(undefined)).toEqual([]);
    expect(parseTermGroups(null)).toEqual([]);
    expect(parseTermGroups([])).toEqual([]);
    expect(parseTermGroups([{ label: ' Goal ', terms: [' gol ', '', '  '] }])).toEqual([{ label: 'Goal', terms: ['gol'] }]);
    expect(() => parseTermGroups([{ label: 'Goal', terms: ['gol'], colour: 'red' }])).toThrow(/not valid/);
    expect(() => parseTermGroups([{ label: 'Goal', terms: [' ', ''] }])).toThrow(/at least one term/);
    expect(() => parseTermGroups(Array.from({ length: 21 }, (_, i) => ({ label: `G${i}`, terms: ['x'] })))).toThrow(/at most 20/);
    expect(() => parseTermGroups([{ label: 'G', terms: Array.from({ length: 51 }, (_, i) => `t${i}`) }])).toThrow(/at most 50/);
    expect(() => parseTermGroups([{ label: 'G', terms: ['x'] }, { label: 'G', terms: ['y'] }])).toThrow(/both named "G"/);
    expect(() => parseTermGroups([{ label: 'G', terms: ['x'.repeat(61)] }])).toThrow(/60 characters/);
    expect(parseTermGroups(football)).toHaveLength(6);
    expect(parseTermGroups(PRESETS.gaming.groups)).toHaveLength(6);
  });
});

describe('detectSpikes', () => {
  it('finds nothing in a flat rate', () => {
    const messages = [];
    for (let t = 0; t < 600; t += 0.5) messages.push({ t, author: `u${Math.floor(t * 2) % 30}`, text: 'hi' });
    expect(detectSpikes(messages, { duration: 600 })).toEqual([]);
  });

  it('finds one burst, with the window starting 20 seconds before it', () => {
    const found = detectSpikes([...background(600), ...burst(300, 20)], { duration: 600 });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ source: 'chat', start: 280, eventStart: 300, peakTime: 300, end: 305, label: null, termSpike: false });
    // 20 in the burst and one quiet message in the same bucket, over a baseline of 1.
    expect(found[0].peakRatio).toBe(21);
    expect(found[0].uniqueAuthors).toBe(21);
    expect(found[0].activityScore).toBeCloseTo(21 * Math.log(22));
    expect(found[0].topWords[0]).toEqual({ word: 'wow', count: 20 });
  });

  it('ignores a burst from a single writer', () => {
    expect(detectSpikes([...background(600), ...burst(300, 30, { authors: 1 })], { duration: 600 })).toEqual([]);
  });

  it('merges two bursts 10 seconds apart', () => {
    const found = detectSpikes([...background(600), ...burst(300, 20), ...burst(310, 25)], { duration: 600 });
    expect(found).toHaveLength(1);
    expect(found[0].eventStart).toBe(300);
    expect(found[0].peakTime).toBe(310);
  });

  it('ignores a burst in the first 120 seconds', () => {
    expect(detectSpikes([...background(600), ...burst(60, 20)], { duration: 600 })).toEqual([]);
  });

  it('keeps the window inside the video, and at least the shortest clip long', () => {
    const atEnd = detectSpikes([...background(597), ...burst(595, 20, { text: () => 'wow' })].filter((m) => m.t <= 597), { duration: 597 });
    expect(atEnd).toHaveLength(1);
    expect(atEnd[0].end).toBe(597);
    expect(atEnd[0].start).toBe(575);
    const tight = detectSpikes([...background(600), ...burst(300, 20)], { duration: 600, chatLagSeconds: 0, preRollSeconds: 0, postRollSeconds: 0 });
    expect([tight[0].start, tight[0].end]).toEqual([300, 310]);
  });

  it('labels a burst where 60% say "goool" as Goal', () => {
    const text = (i) => (i % 5 < 3 ? 'goool' : 'wow');
    const found = detectSpikes([...background(600), ...burst(300, 20, { text })], { duration: 600, terms: football });
    expect(found).toHaveLength(1);
    expect(found[0].label).toBe('Goal');
    expect(found[0].termCounts.Goal).toBe(12);
    expect(found[0].bestTermShare).toBeCloseTo(found[0].termShares.Goal);
    expect(found[0].score).toBeCloseTo(found[0].activityScore * (1 + 2 * found[0].bestTermShare));
  });

  it('drops a spike with no matching terms in "only" mode, and keeps it in "boost"', () => {
    const messages = [...background(600), ...burst(300, 20)];
    expect(detectSpikes(messages, { duration: 600, terms: football, termMode: 'only' })).toEqual([]);
    const boost = detectSpikes(messages, { duration: 600, terms: football });
    expect(boost).toHaveLength(1);
    expect(boost[0].label).toBeNull();
    expect(boost[0].score).toBeCloseTo(boost[0].activityScore);
  });

  it('finds a rise in a term inside constantly busy chat', () => {
    const messages = [];
    for (let t = 0; t < 600; t += 0.25) {
      const goal = t >= 400 && t < 405 && Math.round(t * 4) % 4 !== 0;
      messages.push({ t, author: `u${Math.round(t * 4) % 40}`, text: goal ? 'GOOOL' : 'chatting away' });
    }
    expect(detectSpikes(messages, { duration: 600 })).toEqual([]);
    const found = detectSpikes(messages, { duration: 600, terms: football });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ label: 'Goal', termSpike: true, start: 380, end: 405 });
    expect(found[0].termCounts.Goal).toBe(15);
  });

  it('joins a term spike with the activity spike it overlaps', () => {
    const text = (i) => (i % 5 < 3 ? 'gol' : 'wow');
    const found = detectSpikes([...background(600), ...burst(300, 20, { text })], { duration: 600, terms: football });
    expect(found).toHaveLength(1);
    expect(found[0].termSpike).toBe(true);
    expect(found[0].peakRatio).toBe(21);
  });

  it('treats unsorted messages and ones outside the video like sorted ones', () => {
    const messages = [...background(600), ...burst(300, 20), { t: -3, author: 'x', text: 'early' }, { t: 900, author: 'x', text: 'late' }];
    const sorted = detectSpikes(messages, { duration: 600 });
    expect(detectSpikes([...messages].reverse(), { duration: 600 })).toEqual(sorted);
  });
});

describe('activity series', () => {
  it('counts each bucket and judges a window', () => {
    const series = activitySeries([...background(600), ...burst(300, 20, { text: () => 'gol' })], { duration: 600, terms: football });
    expect(series.bucketSeconds).toBe(5);
    expect(series.buckets).toHaveLength(120);
    expect(series.buckets[60]).toMatchObject({ t: 300, count: 21, baseline: 1, spike: true });
    expect(series.termRates.Goal[60]).toBe(20);
    expect(series.termRates.Goal).toHaveLength(120);
    expect(windowActivity(series, 300, 305)).toEqual({ messages: 21, ratio: 21 });
    expect(windowActivity(series, 200, 210)).toEqual({ messages: 2, ratio: 1 });
    expect(windowActivity(series, 700, 710)).toEqual({ messages: 0, ratio: 0 });
    expect(activitySeries([], { duration: 10 }).termRates).toBeUndefined();
  });
});

describe('the chat modules', () => {
  it('import nothing from Node', async () => {
    for (const name of ['terms.js', 'spikes.js', 'presets.js']) {
      const text = await readFile(new URL(`../src/chat/${name}`, import.meta.url), 'utf8');
      const imports = text.split(/\r?\n/).filter((one) => one.startsWith('import '));
      expect(imports.every((one) => !/from 'node:/.test(one))).toBe(true);
    }
  });
});
