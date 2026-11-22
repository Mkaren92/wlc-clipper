import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { enrich, mergeMoments, rankWithin, wordLines } from '../src/moments/merge.js';

const said = (start, end, score, extra = {}) => ({
  start, end, score, hook: 'HOOK', title: 'Title', description: 'Text', reason: 'Why', problems: [], ...extra,
});
const heard = (start, end, score, extra = {}) => ({
  source: 'chat', start, end, score, label: null, topWords: [{ word: 'gol', count: 9 }], messageCount: 40,
  termShares: {}, ai: null, needsReview: false, ...extra,
});

describe('mergeMoments', () => {
  it('makes one item with both sources from two windows overlapping by 60%', () => {
    // Both 50 s long, 30 s shared; the starts are 20 s apart, so only the overlap joins them.
    const result = mergeMoments([said(100, 150, 9)], [heard(120, 170, 5)], { maxSeconds: 120 });
    expect(result).toHaveLength(1);
    expect(result[0].sources).toEqual(['transcript', 'chat']);
    expect(result[0]).toMatchObject({ start: 100, end: 170 });
    expect(result[0].transcript.hook).toBe('HOOK');
    expect(result[0].chat.topWords[0].word).toBe('gol');
  });

  it('keeps two candidates 60 seconds apart separate, and keeps both', () => {
    const result = mergeMoments([said(100, 130, 9)], [heard(160, 190, 9)]);
    expect(result).toHaveLength(2);
    expect(result.map((item) => item.sources)).toEqual([['transcript'], ['chat']]);
    expect(result.map((item) => item.combined)).toEqual([1, 1]);
  });

  // Added beyond the brief: a chat window starts about 20 s before its burst, so the same goal could fail both tests.
  it('counts a chat burst whose peak falls inside a transcript moment as the same moment', () => {
    // The case seen in the browser: overlap 5 s of a 25 s window, starts 19.9 s apart, peak at 200 s.
    const result = mergeMoments([said(199.9, 223.75, 1)], [heard(180, 205, 1, { peakTime: 200 })]);
    expect(result).toHaveLength(1);
    expect(result[0].sources).toEqual(['transcript', 'chat']);
    // A peak just outside still leaves them apart.
    expect(mergeMoments([said(199.9, 223.75, 1)], [heard(170, 195, 1, { peakTime: 190 })])).toHaveLength(2);
  });

  it('counts starts within 15 seconds as the same moment', () => {
    // 10 s and 40 s long, sharing nothing, but starting 12 s apart.
    const result = mergeMoments([said(100, 110, 1)], [heard(112, 152, 1)]);
    expect(result).toHaveLength(1);
    expect(result[0].sources).toEqual(['transcript', 'chat']);
  });

  it('caps a merged item at maxSeconds, keeping its start', () => {
    const result = mergeMoments([said(100, 140, 1)], [heard(110, 180, 1)], { maxSeconds: 60 });
    expect(result[0]).toMatchObject({ start: 100, end: 160 });
  });

  it('ranks a moment both found above an equally ranked one only one found', () => {
    const result = mergeMoments([said(100, 130, 5), said(500, 530, 5)], [heard(105, 135, 3)]);
    expect(result[0].sources).toEqual(['transcript', 'chat']);
    expect(result[0].combined).toBe(1.5);
    expect(result[1]).toMatchObject({ sources: ['transcript'], combined: 1, start: 500 });
  });

  it('pairs one to one, the best transcript moment taking the largest overlap', () => {
    const result = mergeMoments([said(100, 140, 2), said(105, 145, 9)], [heard(100, 140, 1)]);
    const both = result.find((item) => item.sources.length === 2);
    expect(both.transcript.start).toBe(105);
    expect(result).toHaveLength(2);
  });

  it('marks differing labels for review and shows both', () => {
    const [item] = mergeMoments([said(100, 130, 1, { label: 'Goal' })], [heard(100, 130, 1, { label: 'Penalty' })]);
    expect(item).toMatchObject({ label: null, labels: { transcript: 'Goal', chat: 'Penalty' }, needsReview: true });
  });

  it('takes the one label there is, and a shared one', () => {
    const [one] = mergeMoments([said(100, 130, 1, { label: 'none' })], [heard(100, 130, 1, { label: 'Goal' })]);
    expect(one).toMatchObject({ label: 'Goal', needsReview: false });
    const [same] = mergeMoments([said(100, 130, 1, { label: 'Goal' })], [heard(100, 130, 1, { label: 'Goal' })]);
    expect(same).toMatchObject({ label: 'Goal', needsReview: false });
  });

  it("never writes the AI check's label over the event words' label", () => {
    const sure = heard(100, 130, 1, { label: 'Goal', ai: { label: 'Save', confidence: 0.8, description: '' } });
    expect(mergeMoments([], [sure])[0].label).toBe('Goal');
    const unsure = heard(100, 130, 1, { label: 'Goal', ai: { label: 'Save', confidence: 0.3, description: '' } });
    expect(mergeMoments([], [unsure])[0].label).toBe('Goal');
  });

  it("labels a moment the event words left without one with the AI check's, only when it is sure enough", () => {
    expect(mergeMoments([], [heard(100, 130, 1, { label: null, ai: { label: 'Save', confidence: 0.8, description: '' } })])[0].label).toBe('Save');
    expect(mergeMoments([], [heard(100, 130, 1, { label: null, ai: { label: 'Save', confidence: 0.3, description: '' } })])[0].label).toBe(null);
  });

  it('keeps needsReview from the chat candidate', () => {
    const [item] = mergeMoments([said(100, 130, 1)], [heard(100, 130, 1, { needsReview: true })]);
    expect(item.needsReview).toBe(true);
  });
});

describe('rankWithin', () => {
  it('gives the top 1 and lets ties share the best rank', () => {
    expect(rankWithin([{ score: 3 }, { score: 9 }, { score: 3 }, { score: 1 }])).toEqual([0.75, 1, 0.75, 0.25]);
    expect(rankWithin([])).toEqual([]);
  });
});

describe('enrich', () => {
  const words = [
    { start: 100, end: 100.4, text: 'What' },
    { start: 100.5, end: 100.9, text: 'a' },
    { start: 101, end: 101.5, text: 'goal.' },
    { start: 103, end: 103.5, text: 'Unbelievable' },
    { start: 200, end: 200.5, text: 'later' },
  ];

  it('adds the spoken lines to a chat-only item and chat activity to a transcript-only one', () => {
    const merged = mergeMoments([said(300, 330, 1)], [heard(95, 125, 1)]);
    const activity = (series, start, end) => ({ series, start, end });
    const result = enrich(merged, { words, series: 'S', windowActivity: activity });
    const chatOnly = result.find((item) => item.sources[0] === 'chat');
    expect(chatOnly.lines).toEqual([
      { start: 100, end: 101.5, text: 'What a goal.' },
      { start: 103, end: 103.5, text: 'Unbelievable' },
    ]);
    const transcriptOnly = result.find((item) => item.sources[0] === 'transcript');
    expect(transcriptOnly.chatActivity).toEqual({ series: 'S', start: 300, end: 330 });
    expect(merged[0].lines).toBeUndefined();
  });

  it('breaks a line at 16 words', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ start: i * 0.3, end: i * 0.3 + 0.2, text: 'w' }));
    expect(wordLines(many).map((line) => line.text.split(' ').length)).toEqual([16, 4]);
  });
});

it('imports nothing', async () => {
  const text = await readFile(new URL('../src/moments/merge.js', import.meta.url), 'utf8');
  expect(text.split(/\r?\n/).filter((line) => line.startsWith('import '))).toEqual([]);
});
