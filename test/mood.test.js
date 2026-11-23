import { describe, expect, it } from 'vitest';
import { chatMood, loudParts, moodLines } from '../src/ai/mood.js';

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
