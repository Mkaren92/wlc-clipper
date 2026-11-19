import { readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { containsTerm, runChecks } from '../src/brief/check.js';
import { buildHashtags, buildPostText, parsePostText } from '../src/brief/postText.js';
import { applyReplacements } from '../src/brief/replacements.js';
import { loadBrief, parseBrief } from '../src/brief/schema.js';

const forgegui = {
  id: 'forgegui-basic',
  platforms: ['youtube', 'tiktok'],
  minSeconds: 8,
  maxSeconds: 60,
  hashtags: { required: ['#forgeguipartner', '#robloxdev', '#roblox'], strictOrder: true, optional: ['#gamedev'] },
  onScreenTextMustInclude: ['ForgeGUI'],
  disclosure: { mode: 'hashtag', text: '#forgeguipartner' },
  endCard: { seconds: 3, text: 'Try ForgeGUI' },
  manualChecks: ['Pin a comment that mentions ForgeGUI'],
};

describe('brief files', () => {
  it('loads every brief in briefs/', async () => {
    const files = (await readdir('briefs')).filter((name) => name.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const { brief } = await loadBrief(`briefs/${file}`);
      expect(brief.id).toBe(file.replace(/\.json$/, ''));
    }
  });

  it('needs only an id and fills in the rest', () => {
    expect(parseBrief({ id: 'x' })).toEqual({
      id: 'x',
      platforms: [],
      hashtags: { required: [], strictOrder: false, optional: [] },
      descriptionMustInclude: [],
      onScreenTextMustInclude: [],
      forbiddenTerms: [],
      disclosure: { mode: 'none', text: '' },
      keepFullFrame: false,
      replacements: {},
      manualChecks: [],
    });
  });

  it.each([
    [{}, /id/],
    [{ id: 'x', maxSecond: 60 }, /Unrecognized key: "maxSecond"/],
    [{ id: 'x', hashtags: { required: ['roblox'] } }, /starts with #/],
    [{ id: 'x', minSeconds: 60, maxSeconds: 8 }, /larger than maxSeconds/],
    [{ id: 'x', disclosure: { mode: 'hashtag', text: 'sponsored' } }, /must be a hashtag/],
    [{ id: 'x', disclosure: { mode: 'onscreen' } }, /text is required/],
    [{ id: 'x', captionMustInclude: [] }, /now called "descriptionMustInclude"/],
  ])('rejects %j', (data, message) => {
    expect(() => parseBrief(data)).toThrow(message);
  });

  it('says where it looked when the end-card image is missing', async () => {
    await expect(loadBrief('test/fixtures/missing-image.json')).rejects.toThrow(/end-card image was not found/);
  });
});

describe('post text', () => {
  const brief = parseBrief(forgegui);

  it('lists required hashtags in order, then optional ones, without repeats', () => {
    expect(buildHashtags(brief)).toEqual(['#forgeguipartner', '#robloxdev', '#roblox', '#gamedev']);
  });

  it('adds a disclosure hashtag that is not among the required ones', () => {
    const other = parseBrief({ ...forgegui, disclosure: { mode: 'hashtag', text: '#ad' } });
    expect(buildHashtags(other)).toEqual(['#forgeguipartner', '#robloxdev', '#roblox', '#ad', '#gamedev']);
  });

  it.each([
    [{ title: 'He did NOT expect that', description: 'Built with ForgeGUI.\nLink in bio.', hashtags: ['#a', '#b'] }],
    [{ title: 'Only a title', description: '', hashtags: ['#a', '#b'] }],
    [{ title: 'No tags', description: 'Some text', hashtags: [] }],
  ])('reads back what it wrote: %j', (post) => {
    expect(parsePostText(buildPostText(post))).toEqual(post);
  });

  it('puts the title first and the hashtags last', () => {
    const text = buildPostText({ title: 'T', description: 'D', hashtags: ['#a', '#b'] });
    expect(text).toBe('T\n\nD\n\n#a #b\n');
    expect(buildPostText({ title: 'T', description: 'D', hashtags: [] })).toBe('T\n\nD\n');
    expect(buildPostText({ title: 'T', description: '', hashtags: [] })).toBe('T\n');
  });
});

describe('containsTerm', () => {
  it.each([
    ['Try ForgeGUI today', 'forgegui', true],
    ['Try ForgeGUI!', 'ForgeGUI', true],
    ['the start of it', 'art', false],
    ['ForgeGUIs are fun', 'ForgeGUI', false],
    ['made with Forge  GUI', 'forge gui', true],
    ['costs $5 (really)', '$5', true],
    ['', 'x', false],
  ])('%j / %j -> %s', (text, term, found) => {
    expect(containsTerm(text, term)).toBe(found);
  });
});

describe('runChecks', () => {
  const base = {
    brief: parseBrief(forgegui),
    seconds: 33,
    layout: 'center',
    title: 'He did NOT expect that',
    description: '',
    hashtags: ['#forgeguipartner', '#robloxdev', '#roblox', '#gamedev'],
    onScreen: { hook: 'He did NOT expect that', disclosure: null, endCard: 'Try ForgeGUI' },
    words: [{ text: 'He', start: 0.3, end: 0.5 }],
    subtitleFile: '',
    clip: { width: 1080, height: 1920, audioStreams: 1 },
  };
  const check = (changes) => Object.fromEntries(runChecks({ ...base, ...changes }).map((r) => [r.rule, r]));
  const withBrief = (changes) => ({ brief: parseBrief({ ...forgegui, ...changes }) });

  it('passes a clip that follows the brief', () => {
    const results = runChecks(base);
    expect(results.map((r) => r.rule)).toEqual(['Length', 'Required hashtags', 'On-screen text', 'Disclosure', 'Format']);
    expect(results.every((r) => r.pass)).toBe(true);
  });

  it('fails a clip that is too short or too long, and names the limits', () => {
    expect(check({ seconds: 5 }).Length).toMatchObject({ pass: false, detail: expect.stringContaining('at least 8 s') });
    expect(check({ seconds: 61 }).Length.pass).toBe(false);
    expect(check({ seconds: 60.02 }).Length.pass).toBe(true);
  });

  it('fails a missing required hashtag and names it', () => {
    const result = check({ hashtags: ['#forgeguipartner', '#roblox'] })['Required hashtags'];
    expect(result).toEqual({ rule: 'Required hashtags', pass: false, detail: 'missing from post.txt: #robloxdev' });
  });

  it('fails required hashtags in the wrong order only when the brief is strict about it', () => {
    const swapped = { hashtags: ['#robloxdev', '#forgeguipartner', '#roblox'] };
    expect(check(swapped)['Required hashtags'].pass).toBe(false);
    const relaxed = withBrief({ hashtags: { ...forgegui.hashtags, strictOrder: false } });
    expect(check({ ...swapped, ...relaxed })['Required hashtags'].pass).toBe(true);
  });

  it('needs one description keyword', () => {
    const brief = withBrief({ descriptionMustInclude: ['Roblox', 'UI'] });
    expect(check({ ...brief, description: 'A quick UI build' })['Description keywords'].pass).toBe(true);
    expect(check({ ...brief, description: 'A quick build' })['Description keywords'].pass).toBe(false);
  });

  it('needs every on-screen term in the hook, disclosure or end-card text', () => {
    const noCard = { onScreen: { hook: 'He did NOT expect that', disclosure: null, endCard: null } };
    expect(check(noCard)['On-screen text']).toMatchObject({ pass: false, detail: expect.stringContaining('ForgeGUI') });
  });

  it('finds forbidden terms in the post text, the on-screen text and the captions', () => {
    const brief = withBrief({ forbiddenTerms: ['free robux', 'scam'] });
    expect(check(brief)['Forbidden terms'].pass).toBe(true);
    expect(check({ ...brief, title: 'Not a scam!' })['Forbidden terms'].detail).toBe('"scam" is in the title');
    const words = [
      { text: 'Get', start: 12.0, end: 12.2 },
      { text: 'free', start: 12.3, end: 12.5 },
      { text: 'Robux,', start: 12.5, end: 12.9 },
    ];
    expect(check({ ...brief, words })['Forbidden terms'].detail).toBe('"free robux" is in the captions at 0:12.30');
  });

  it('checks an on-screen disclosure against the subtitle file', () => {
    const brief = withBrief({ disclosure: { mode: 'onscreen', text: 'Sponsored by ForgeGUI' } });
    expect(check({ ...brief, subtitleFile: 'Dialogue: ...,{\\q0}Sponsored by ForgeGUI' }).Disclosure.pass).toBe(true);
    expect(check({ ...brief, subtitleFile: 'Dialogue: ...,HELLO' }).Disclosure.pass).toBe(false);
    expect(check({ ...brief, subtitleFile: null }).Disclosure.pass).toBe(false);
  });

  it('fails a disclosure hashtag that was removed from post.txt', () => {
    expect(check({ hashtags: ['#robloxdev', '#roblox'] }).Disclosure.pass).toBe(false);
  });

  it('fails a clip of the wrong size or without sound', () => {
    expect(check({ clip: { width: 1920, height: 1080, audioStreams: 0 } }).Format.detail).toBe(
      'the clip is 1920x1080, not 1080x1920; the clip has no sound',
    );
  });

  it('allows only the blur layout when the brief keeps the full frame', () => {
    const brief = withBrief({ keepFullFrame: true });
    expect(check(brief)['Full frame'].pass).toBe(false);
    expect(check({ ...brief, layout: 'blur' })['Full frame'].pass).toBe(true);
  });

  it('leaves out rules whose input does not exist yet', () => {
    const { words, subtitleFile, clip, ...early } = base;
    const brief = withBrief({ disclosure: { mode: 'onscreen', text: 'Sponsored' } });
    expect(runChecks({ ...early, ...brief }).map((r) => r.rule)).toEqual(['Length', 'Required hashtags', 'On-screen text']);
  });
});

describe('applyReplacements', () => {
  const words = [
    { text: 'Try', start: 0, end: 0.2 },
    { text: 'forge', start: 0.2, end: 0.5 },
    { text: 'gooey,', start: 0.5, end: 0.9 },
    { text: 'the', start: 1, end: 1.1 },
    { text: 'Barca', start: 1.1, end: 1.5 },
  ];

  it('joins several words into one and keeps the punctuation after them', () => {
    const fixed = applyReplacements(words, { 'Forge Gooey': 'ForgeGUI', barca: 'Barça' });
    expect(fixed).toEqual([
      { text: 'Try', start: 0, end: 0.2 },
      { text: 'ForgeGUI,', start: 0.2, end: 0.9 },
      { text: 'the', start: 1, end: 1.1 },
      { text: 'Barça', start: 1.1, end: 1.5 },
    ]);
  });

  it('changes nothing without rules', () => {
    expect(applyReplacements(words, {})).toBe(words);
  });
});
