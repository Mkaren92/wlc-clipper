// The AI features, with a stand-in for the AI service. These tests need no
// key and no network.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAi } from '../src/ai/client.js';
import { proposeWordFixes, tidyFixes } from '../src/ai/fixWords.js';
import { suggestMoments, tidyMoments, transcriptLines } from '../src/ai/suggest.js';
import { parseBrief } from '../src/brief/schema.js';
import { run } from '../src/run.js';

/** Sixty words, one per second: word N is spoken from N to N + 0.5. */
const words = Array.from({ length: 60 }, (_, i) => ({ text: `w${i}${i % 10 === 9 ? '.' : ''}`, start: i, end: i + 0.5 }));
const context = { words, duration: 61, limits: { min: 5, max: 20 }, count: 5 };
const moment = (start, end, more = {}) => ({ start, end, hook: 'A hook', title: 'T', description: 'D', reason: 'R', score: 0.5, ...more });

describe('tidyMoments', () => {
  it('moves times onto real words, with a little room around them', () => {
    const [m] = tidyMoments([moment(10.3, 19.8)], context);
    // nearest word start to 10.3 is 10; nearest word end to 19.8 is 19.5
    expect([m.start, m.end]).toEqual([9.9, 19.75]);
  });

  it('shortens a moment that is too long, at a word', () => {
    const [m] = tidyMoments([moment(0, 50)], context);
    expect(m.start).toBe(0);
    expect(m.end - m.start).toBeLessThanOrEqual(20);
    expect(m.end).toBe(19.75);
  });

  it('drops moments that are too short, backwards, or not numbers', () => {
    const bad = [moment(10, 12), moment(30, 20), moment('ten', 20), { nonsense: true }, null, moment(NaN, 5)];
    expect(tidyMoments(bad, context)).toEqual([]);
    expect(tidyMoments('not a list', context)).toEqual([]);
  });

  it('keeps the better of two overlapping moments, and the wanted number, in time order', () => {
    const raw = [
      moment(30, 40, { score: 0.2, title: 'late' }),
      moment(0, 10, { score: 0.9, title: 'best' }),
      moment(5, 15, { score: 0.8, title: 'overlaps best' }),
      moment(45, 55, { score: 0.7, title: 'third' }),
    ];
    expect(tidyMoments(raw, context).map((m) => m.title)).toEqual(['best', 'late', 'third']);
    expect(tidyMoments(raw, { ...context, count: 2 }).map((m) => m.title)).toEqual(['best', 'third']);
  });

  it('cleans the text and cuts a long hook at a word', () => {
    const long = 'This hook is far too long to fit on the screen in two lines of text';
    const [m] = tidyMoments(
      [moment(0, 10, { hook: `{\\b1}${long}`, title: ' Two\nlines ', description: null, reason: 7, score: 9 })],
      context,
    );
    expect(m.hook.length).toBeLessThanOrEqual(60);
    expect(m.hook).toBe('b1This hook is far too long to fit on the screen in two');
    expect([m.title, m.description, m.reason, m.score]).toEqual(['Two lines', '', '7', 1]);
    expect(tidyMoments([moment(0, 10, { hook: '   ' })], context)[0].hook).toBeNull();
  });
});

describe('transcriptLines', () => {
  it('writes timed lines that break at sentence ends and pauses', () => {
    const lines = transcriptLines([
      { text: 'No', start: 0.3, end: 0.5 },
      { text: 'way.', start: 0.5, end: 0.9 },
      { text: 'Look', start: 1, end: 1.2 },
      { text: 'here', start: 2.5, end: 2.8 },
    ]);
    expect(lines).toBe('[0.3-0.9] No way.\n[1.0-1.2] Look\n[2.5-2.8] here');
  });
});

describe('suggestMoments', () => {
  let dir;
  let source;
  const asked = [];
  let transcribed = 0;

  const transcriber = {
    name: 'fake',
    isInstalled: async () => true,
    transcribe: async () => {
      transcribed += 1;
      return { language: 'en', words: words.slice(0, 8) };
    },
  };
  const ai = (answer) => ({
    service: 'Fake', model: 'fake-1', isConfigured: () => true,
    ask: async (request) => {
      asked.push(request);
      return { data: answer, usage: { input: 100, output: 20 } };
    },
  });

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'clipper-ai-'));
    source = path.join(dir, 'talk.mp4');
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440',
      '-t', '9', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source,
    ]);
  }, 60_000);
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('sends the transcript and the rules, and returns tidy moments with brief problems', async () => {
    const brief = parseBrief({ id: 'b', minSeconds: 3, maxSeconds: 8, onScreenTextMustInclude: ['ForgeGUI'], forbiddenTerms: ['scam'] });
    const answer = { moments: [moment(0.2, 5.4, { hook: 'Not a scam', score: 0.9 }), moment(0, 2)] };
    const result = await suggestMoments({
      source, count: 3, brief, cacheDir: path.join(dir, 'cache'), transcriber, ai: ai(answer),
    });

    expect(result).toMatchObject({ model: 'fake-1', usage: { input: 100, output: 20 }, fromCache: false });
    expect(result.moments).toHaveLength(1);
    expect(result.moments[0]).toMatchObject({ start: 0, end: 5.75, hook: 'Not a scam' });
    expect(result.moments[0].problems).toEqual([
      'On-screen text: not found in the hook, disclosure or end-card text: ForgeGUI',
      'Forbidden terms: "scam" is in the hook',
    ]);

    const [request] = asked;
    expect(request.user).toBe('[0.0-7.5] w0 w1 w2 w3 w4 w5 w6 w7');
    expect(request.system).toContain('between 3 and 8 seconds');
    expect(request.system).toContain('The hook must contain: ForgeGUI');
    // Nothing that names a file or a folder leaves the machine.
    expect(request.user + request.system).not.toContain(dir);
    expect(request.user + request.system).not.toContain('talk.mp4');
  }, 60_000);

  it('keeps the whole-video transcript and uses it the next time', async () => {
    const before = transcribed;
    const result = await suggestMoments({ source, cacheDir: path.join(dir, 'cache'), transcriber, ai: ai({ moments: [] }) });
    expect(result.fromCache).toBe(true);
    expect(transcribed).toBe(before);
    expect(await readdir(path.join(dir, 'cache'))).toHaveLength(1);
  }, 60_000);

  it('says what is missing when no key is set', async () => {
    const noKey = { ...ai({ moments: [] }), isConfigured: () => false, help: 'Set the thing up.' };
    await expect(suggestMoments({ source, cacheDir: dir, transcriber, ai: noKey })).rejects.toThrow('Set the thing up.');
  });
});

describe('getAi', () => {
  // The environment and whether Claude Code is installed are passed in, so
  // these never depend on the machine and never reach a real service.
  const pick = (env, hasClaude) => getAi({ env, hasClaude });

  it('uses Claude Code when it is installed, and OpenAI otherwise', () => {
    expect(pick({}, true)).toMatchObject({ service: 'Claude Code', model: 'sonnet' });
    expect(pick({}, true).isConfigured()).toBe(true);
    expect(pick({}, false)).toMatchObject({ service: 'OpenAI', model: 'gpt-6.2-sol' });
  });

  it('follows CLIPPER_AI when it is set', () => {
    expect(pick({ CLIPPER_AI: 'openai', OPENAI_API_KEY: 'k' }, true).service).toBe('OpenAI');
    expect(pick({ CLIPPER_AI: 'OpenAI', OPENAI_API_KEY: 'k' }, true).isConfigured()).toBe(true);
    expect(pick({ CLIPPER_AI: 'claude' }, false).service).toBe('Claude Code');
    expect(() => pick({ CLIPPER_AI: 'gemini' }, true)).toThrow(/must be "claude" or "openai"/);
  });

  it('takes the model names from the environment', () => {
    expect(pick({ CLIPPER_CLAUDE_MODEL: 'haiku' }, true).model).toBe('haiku');
    expect(pick({ CLIPPER_AI: 'openai', CLIPPER_AI_MODEL: 'gpt-6-luna' }, true).model).toBe('gpt-6-luna');
  });

  it('says how to set a service up when it cannot be used', async () => {
    const noKey = pick({}, false);
    expect(noKey.isConfigured()).toBe(false);
    await expect(noKey.ask({ system: '', user: '', schema: null, schemaName: 'x' })).rejects.toThrow(/OPENAI_API_KEY/);
    const noClaude = pick({ CLIPPER_AI: 'claude' }, false);
    expect(noClaude.isConfigured()).toBe(false);
    await expect(noClaude.ask({ system: '', user: '', schema: null, schemaName: 'x' })).rejects.toThrow(/Claude Code was not found/);
  });
});

describe('word fixes', () => {
  const spoken = ['have', 'the', 'noses', 'on.', 'Lisandro'].map((text, i) => ({ text, start: i, end: i + 0.5 }));

  it('keeps only fixes that replace one real word with one different word', () => {
    const raw = [
      { index: 2, text: 'notifications' },
      { index: 2, text: 'second answer for the same word' },
      { index: 3, text: 'on.' },          // no change
      { index: 4, text: 'two words' },    // would split a word
      { index: 0, text: '' },             // would delete a word
      { index: 1, text: '{\\b1}the' },  // subtitle control characters
      { index: 9, text: 'x' },            // no such word
      { index: 1.5, text: 'x' },
      { text: 'x' },
      null,
    ];
    expect(tidyFixes(raw, spoken)).toEqual([{ index: 2, from: 'noses', to: 'notifications' }]);
    expect(tidyFixes('nonsense', spoken)).toEqual([]);
  });

  it('sends numbered words and known names, and nothing for an empty transcript', async () => {
    const asked = [];
    const ai = {
      service: 'Fake', model: 'fake-1', isConfigured: () => true,
      ask: async (request) => {
        asked.push(request);
        return { data: { fixes: [{ index: 2, text: 'notifications' }] }, usage: { input: 30, output: 4 } };
      },
    };
    const result = await proposeWordFixes({ words: spoken, ai, knownTerms: ['Barça'] });
    expect(result).toEqual({ fixes: [{ index: 2, from: 'noses', to: 'notifications' }], model: 'fake-1', usage: { input: 30, output: 4 } });
    expect(asked[0].user).toBe('0: have\n1: the\n2: noses\n3: on.\n4: Lisandro');
    expect(asked[0].system).toContain('Barça');
    expect((await proposeWordFixes({ words: [], ai })).fixes).toEqual([]);
    expect(asked).toHaveLength(1);
  });
});
