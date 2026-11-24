// The dashboard's colours are worked out from the palette's five. These tests
// hold the palette that ships to the contrast a person needs to read it, and two
// light sets that once shipped (removed on 2026-11-24), so the arithmetic for a
// light page and for a strong tint stays right for whoever changes the five values.
import { describe, expect, it } from 'vitest';
import { buildTokens, contrast, luminance, mix, PALETTE } from '../web/src/theme.js';

const SETS = {
  shipped: PALETTE,
  'light, pale tint': { background: '#f4fefe', surface: '#cff6f6', highlight: '#bbeb95', primary: '#005974', ink: '#140f6a' },
  'light, strong tint': { background: '#e6e4e0', surface: '#9b806e', highlight: '#ec7a1c', primary: '#90462c', ink: '#44443b' },
};

describe('colour arithmetic', () => {
  it('mixes two colours by a share', () => {
    expect(mix('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mix('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
  });

  it('measures contrast as the accessibility rules do', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#ffffff', '#ffffff')).toBe(1);
    expect(contrast('#005974', '#f4fefe')).toBeGreaterThan(7);
    expect(luminance('#ffffff')).toBeCloseTo(1, 5);
  });

  it('refuses a colour that is not #rrggbb', () => {
    expect(() => mix('teal', '#ffffff', 0.5)).toThrow(/#rrggbb/);
    expect(() => buildTokens({ ...PALETTE, primary: '#0af' })).toThrow(/#rrggbb/);
  });
});

describe.each(Object.entries(SETS))('the %s palette', (id, palette) => {
  const t = buildTokens(palette);
  const fills = ['--bg', '--panel', '--soft'];

  it('uses the palette for the page and the highlight as given, and the tint as given or thinned', () => {
    expect(t['--bg']).toBe(palette.background);
    expect(t['--highlight']).toBe(palette.highlight);
    // A tint the palette's ink already reads on is used as it is. A stronger one
    // is mixed with the page colour, so it lies between the two.
    if (contrast(t['--text'], palette.surface) >= 6) {
      expect(t['--soft']).toBe(palette.surface);
    } else {
      expect(contrast(t['--text'], t['--soft'])).toBeGreaterThanOrEqual(6);
      expect(t['--soft']).not.toBe(palette.background);
      const [low, high] = [luminance(palette.surface), luminance(palette.background)].sort((a, b) => a - b);
      expect(luminance(t['--soft'])).toBeGreaterThan(low);
      expect(luminance(t['--soft'])).toBeLessThan(high);
    }
  });

  it('keeps every kind of text readable on every fill it sits on (4.5 or more)', () => {
    for (const fill of fills) {
      for (const words of ['--text', '--muted', '--accent', '--good', '--bad', '--warn']) {
        expect(contrast(t[words], t[fill]), `${words} on ${fill}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(contrast(t['--text'], t['--bg'])).toBeGreaterThanOrEqual(7);
  });

  it('keeps the text on coloured buttons, marks and notices readable', () => {
    for (const [words, fill] of [
      ['--accent-text', '--accent'],
      ['--accent-text', '--accent-hover'],
      ['--highlight-text', '--highlight'],
      ['--bad-text', '--bad'],
      ['--text', '--soft-strong'],
      ['--text', '--accent-tint'],
      ['--text', '--good-bg'],
      ['--text', '--bad-bg'],
      ['--text', '--warn-bg'],
      ['--good', '--good-bg'],
      ['--bad', '--bad-bg'],
      ['--warn', '--warn-bg'],
    ]) {
      expect(contrast(t[words], t[fill]), `${words} on ${fill}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('gives a box you type in an edge that stands out (3 or more), and the same for what marks a choice', () => {
    for (const fill of fills) {
      expect(contrast(t['--line-strong'], t[fill]), `--line-strong on ${fill}`).toBeGreaterThanOrEqual(3);
      expect(contrast(t['--accent'], t[fill]), `--accent on ${fill}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('tells the browser whether it is a light or a dark set', () => {
    expect(t['--scheme']).toBe(luminance(palette.background) < 0.3 ? 'dark' : 'light');
  });
});

describe('the palette', () => {
  it('is the one dark set, five colours and nothing else', () => {
    expect(PALETTE).toEqual({ background: '#0d1b24', surface: '#16303d', highlight: '#bbeb95', primary: '#6fd3e6', ink: '#e9f8f8' });
    expect(buildTokens(PALETTE)['--scheme']).toBe('dark');
  });

  it('leaves a pale tint alone and thins a strong one', () => {
    expect(buildTokens(SETS['light, pale tint'])['--soft']).toBe('#cff6f6');
    expect(buildTokens(PALETTE)['--soft']).toBe(PALETTE.surface);
    expect(buildTokens(SETS['light, strong tint'])['--soft']).not.toBe('#9b806e');
  });
});
