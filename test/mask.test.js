import { describe, expect, it } from 'vitest';
import { captionWidth } from '../src/captions/width.js';
import { isSwear, maskProfanity, swearWindows } from '../src/captions/mask.js';

describe('covering swear words in drawn text', () => {
  it('covers one letter with one star, in any case, and keeps the length', () => {
    const pairs = {
      'WHAT THE FUCK': 'WHAT THE F*CK',
      'fucking shit, man!': 'f*cking sh*t, man!',
      'Motherfucker': 'Motherf*cker',
      'BULLSHIT': 'BULLSH*T',
      'SON OF A BITCH': 'SON OF A B*TCH',
      'you asshole': 'you a**hole',
      "fuckin' pussies": "f*ckin' p*ssies",
      'what a wanker, twats': 'what a w*nker, tw*ts',
      'ARSEHOLE BASTARDS': 'A**EHOLE B*STARDS',
    };
    for (const [text, masked] of Object.entries(pairs)) {
      expect(maskProfanity(text), text).toBe(masked);
      expect(masked.length, text).toBe(text.length); // the captions are grouped by length
    }
  });

  it('knows a shouted word by its stretched letters', () => {
    expect(maskProfanity('FUUUUCK')).toBe('F****CK');
    expect(maskProfanity('shiiit')).toBe('sh***t');
    expect(maskProfanity('FFFUCKKK')).toBe('FFF*CKKK');
  });

  it('leaves names, mild words, clean text and words that came already starred', () => {
    for (const text of [
      'Scunthorpe count Dick Hancock Dickens', // names, and a word that only looks alike
      'damn hell crap', // YouTube does not count these
      'HE DID NOT', 'What a goal!', '', '   ', '100% @name #tag',
      'f*** this f*ck', // starred by the recogniser
      'Niger', // a country, not the slur it resembles with doubled letters taken out
    ]) expect(maskProfanity(text), text).toBe(text);
  });

  it('covers a hateful word wholly after its first letter', () => {
    expect(maskProfanity('you RETARDS')).toBe('you R******');
    expect(maskProfanity('faggot.')).toBe('f*****.');
  });

  it('has the star\'s own width, so a covered word does not shrink its line', () => {
    // 389 thousandths of an em in the bundled font, against 722 for the U it covers.
    expect(captionWidth('F*CK')).toBeLessThan(captionWidth('FUCK'));
    expect(captionWidth('F*CK') - captionWidth('FCK')).toBe(captionWidth('*') - captionWidth(''));
    expect(captionWidth('*') - captionWidth('')).toBe(Math.round((389 * 66.5) / 1000));
  });

  it('finds when the swear words are spoken: the middle of the word, inside the clip, joined when they touch', () => {
    const words = [
      { text: 'What', start: 0.02, end: 0.2 }, { text: 'the', start: 0.2, end: 0.3 }, { text: 'fuck', start: 0.5, end: 1.0 },
      { text: 'is', start: 1.0, end: 1.1 }, { text: 'this', start: 1.1, end: 1.4 },
      { text: 'Shit,', start: 2.0, end: 2.1 }, { text: 'shit!', start: 2.1, end: 2.2 }, // short ones are muffled whole; back to back: one window
      { text: 'f***', start: 4.0, end: 4.3 }, // starred by the recogniser: still muffled
      { text: 'BITCH', start: 5.9, end: 6.4 }, // runs past the end of the clip
      { text: 'fuck', start: 7, end: 7.2 }, // after the clip: nothing
    ];
    // 60% of the word, in its middle: half a second of "fuck" is muffled from 0.6 to 0.9.
    expect(swearWindows(words, 6)).toEqual([{ start: 0.6, end: 0.9 }, { start: 2, end: 2.2 }, { start: 4.06, end: 4.24 }, { start: 5.9, end: 6 }]);
    expect(swearWindows(words.slice(0, 2), 6)).toEqual([]);
    expect(swearWindows([], 6)).toEqual([]);
    expect([isSwear('Fuck!'), isSwear('f***'), isSwear('duck'), isSwear('Scunthorpe')]).toEqual([true, true, false, false]);
  });
});
