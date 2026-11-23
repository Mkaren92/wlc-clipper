import { describe, expect, it } from 'vitest';
import { chatMood, loudMomentLines, loudMoments, loudParts, moodLines } from '../src/ai/mood.js';

const steps = (...dbs) => dbs.map((db, i) => ({ t: i * 0.5, db }));

describe('loudParts', () => {
  it('finds stretches well above the clip\'s usual level and joins neighbours', () => {
    const parts = loudParts(steps(-30, -31, -29, -18, -15, -30, -30, -12, -30, -30));
    expect(parts).toEqual([{ start: 1.5, end: 2.5, louder: 15 }, { start: 3.5, end: 4, louder: 18 }]);
  });

  it('finds nothing in a clip at one level, or in silence', () => {
    expect(loudParts(steps(-30, -29, -31, -30, -30))).toEqual([]);
    expect(loudParts(steps(-Infinity, -Infinity, -Infinity, -Infinity))).toEqual([]);
  });

  it('does not let silence lower the usual level', () => {
    // Speech at -30 with long pauses: speech is not "loud" next to the pauses.
    expect(loudParts(steps(-90, -90, -90, -90, -30, -30, -31, -29, -90, -90))).toEqual([]);
  });
});

describe('chatMood', () => {
  const at = (t, text) => ({ t, author: 'x', text });

  it('counts reactions up to 5 s after the clip, on the clip\'s clock, and leaves out noise', () => {
    const mood = chatMood([at(5, 'before the clip'), at(16, 'LOL'), at(17, 'lmao'), at(18, 'omg'), at(19, '!sr song'), at(24, 'W'), at(26, 'W too late'), at(40, 'lol later')], 10, 20);
    expect(mood.reactions).toEqual([{ label: 'laughing', count: 2 }, { label: 'shock', count: 1 }, { label: 'hype', count: 1 }]);
    expect(mood.messages).toBe(4);
    // 16 s in the video is 1 s into the clip once chat's delay is taken off.
    expect(mood.busiest).toEqual({ start: 0, end: 5 });
  });

  it('has nothing to say about a quiet chat', () => {
    expect(chatMood([at(12, 'anyone know the song name'), at(13, '!points')], 10, 20)).toEqual({ messages: 0, reactions: [], busiest: null });
  });
});

describe('moodLines', () => {
  it('adds nothing when there is nothing to tell', () => {
    expect(moodLines({ loud: [], chat: { messages: 0, reactions: [], busiest: null } })).toEqual([]);
  });

  it('gives times, decibels and counts, and nothing else', () => {
    const lines = moodLines({ loud: [{ start: 1.5, end: 2.5, louder: 15 }], chat: { reactions: [{ label: 'laughing', count: 12 }], busiest: { start: 0, end: 5 } } });
    expect(lines.join('\n')).toBe([
      '', 'Sound: where the voice is much louder than usual in this clip (times in seconds):', '[1.5-2.5] 15 dB louder than usual',
      '', "Chat's reactions to this clip (messages counted by kind): laughing 12.", 'Most of them came at [0.0-5.0].',
    ].join('\n'));
  });
});

// A whole video's loud moments, for "Suggest moments" (2026-11-23).
describe('loud moments of a whole video', () => {
  const part = (start, end, louder) => ({ start, end, louder });

  it('makes one moment of bursts close together, and keeps the busiest in time order', () => {
    const parts = [part(10, 11, 9), part(13, 14.5, 12), part(16, 17, 10), part(100, 100.5, 8), part(200, 203, 11)];
    expect(loudMoments(parts)).toEqual([
      { start: 10, end: 17, peak: 12, bursts: 3 },
      { start: 100, end: 100.5, peak: 8, bursts: 1 },
      { start: 200, end: 203, peak: 11, bursts: 1 },
    ]);
    // Only the busiest are kept (loud seconds times decibels), still in time order.
    expect(loudMoments(parts, { top: 2 })).toEqual([
      { start: 10, end: 17, peak: 12, bursts: 3 },
      { start: 200, end: 203, peak: 11, bursts: 1 },
    ]);
    expect(loudMoments([])).toEqual([]);
  });

  it('writes one line per moment after a heading, or nothing', () => {
    expect(loudMomentLines([{ start: 1462, end: 1483, peak: 12, bursts: 6 }, { start: 2122, end: 2124.5, peak: 11, bursts: 1 }])).toEqual([
      '',
      'Sound: where the streamer\'s voice is much louder than usual (shouting, screaming, laughing), times in seconds:',
      '[1462.0-1483.0] 6 loud bursts, up to 12 dB louder than usual',
      '[2122.0-2124.5] 1 loud burst, up to 11 dB louder than usual',
    ]);
    expect(loudMomentLines([])).toEqual([]);
  });
});
