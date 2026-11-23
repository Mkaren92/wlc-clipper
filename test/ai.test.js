// The AI features, with a stand-in for the AI service. These tests need no
// key and no network.
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getAi } from '../src/ai/client.js';
import { proposeWordFixes, tidyFixes } from '../src/ai/fixWords.js';
import { keptTranscript, prepareTranscript, readKeptResult, suggestMoments, tidyMoments, transcriptLines } from '../src/ai/suggest.js';
import { parseBrief } from '../src/brief/schema.js';
import { suggestHooks, tidyHooks } from '../src/ai/suggestHook.js';
import { parseTermGroups } from '../src/chat/terms.js';
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
      'On-screen text: not found in the hook, disclosure, channel tag or end-card text: ForgeGUI',
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

  it('takes videos up to 3 hours, and refuses or skips a longer one before transcribing', async () => {
    // A tiny picture at 1 frame a second keeps a 3-hour file quick to make.
    const long = path.join(dir, 'over-three-hours.mp4');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=16x16:r=1', '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono',
      '-t', '10805', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '8k', long]);
    const before = transcribed;
    await expect(suggestMoments({ source: long, cacheDir: path.join(dir, 'long-cache'), transcriber, ai: ai({ moments: [] }) })).rejects.toThrow(/up to 3 hours long; this one is 3:00:0/);
    expect(await prepareTranscript({ source: long, cacheDir: path.join(dir, 'long-cache'), transcriber })).toMatchObject({ made: false, skipped: expect.stringMatching(/up to 3 hours/) });
    expect(transcribed).toBe(before);
  }, 120_000);

  it('keeps the whole-video transcript and uses it the next time', async () => {
    const before = transcribed;
    const result = await suggestMoments({ source, cacheDir: path.join(dir, 'cache'), transcriber, ai: ai({ moments: [] }) });
    expect(result.fromCache).toBe(true);
    expect(transcribed).toBe(before);
    // One transcript; the model's answers are kept beside it under their own names.
    expect((await readdir(path.join(dir, 'cache'))).filter((name) => !name.startsWith('moments-'))).toHaveLength(1);
  }, 60_000);

  // The brief for event terms: with no terms and no guidance, the request must be exactly
  // what it was before they existed. The fixture was recorded from the old code.
  describe('event terms and guidance', () => {
    const before = JSON.parse(readFileSync(new URL('./fixtures/suggest-prompt-before.json', import.meta.url), 'utf8'));
    const steeredTranscriber = { name: 'fake', isInstalled: async () => true, transcribe: async () => ({ language: 'en', words: before.words }) };
    let video;
    beforeAll(async () => {
      // A source of its own with the fixture's words, and a sine as its sound so no pauses move them.
      video = path.join(dir, 'steered.mp4');
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440',
        '-t', '9', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video]);
    }, 60_000);
    const shape = (request) => ({ system: request.system, user: request.user, schemaName: request.schemaName, schema: z.toJSONSchema(request.schema) });
    const terms = parseTermGroups([{ label: 'Goal', terms: ['goal', 'gol'] }, { label: 'Penalty', terms: ['penalty', 'pen'] }]);

    it('sends exactly the old request when no terms and no guidance are given', async () => {
      asked.length = 0;
      const cacheDir = path.join(dir, 'steer-cache-1');
      await suggestMoments({ source: video, cacheDir, transcriber: steeredTranscriber, ai: ai({ moments: [] }) });
      await suggestMoments({ source: video, count: 3, brief: parseBrief(before.withBrief.brief), cacheDir, transcriber: steeredTranscriber, ai: ai({ moments: [] }), terms: [], guidance: '   ' });
      expect(shape(asked[0])).toEqual(before.plain);
      const { brief, count, ...withBrief } = before.withBrief;
      expect(shape(asked[1])).toEqual(withBrief);
    }, 60_000);

    it('with the streamer\'s loudness, sends the old request first and then where the voice gets loud', async () => {
      // Quiet speech-band tone with a shout from 10 to 12 s, 24 dB louder.
      const shouting = path.join(dir, 'peanut-part.mp4');
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30',
        '-f', 'lavfi', '-i', 'aevalsrc=0.05*sin(2*PI*800*t)*(1+15*between(t\\,10\\,12)):s=48000',
        '-t', '20', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', shouting]);
      asked.length = 0;
      const cacheDir = path.join(dir, 'steer-cache-loud');
      await suggestMoments({ source: shouting, cacheDir, transcriber: steeredTranscriber, ai: ai({ moments: [] }), loud: true });
      const [request] = asked;
      expect(request.system.startsWith(before.plain.system)).toBe(true);
      expect(request.system).toContain('much louder than usual');
      expect(request.user.startsWith(before.plain.user)).toBe(true);
      expect(request.user).toMatch(/\[10\.0-12\.0\] 1 loud burst, up to \d+ dB louder than usual/);
      // Only times and decibels: nothing that names the file.
      expect(request.user + request.system).not.toContain('peanut-part');
      // Off, the same video gets the old request, and the answer kept for "on" is not used for "off".
      await suggestMoments({ source: shouting, cacheDir, transcriber: steeredTranscriber, ai: ai({ moments: [] }) });
      expect(asked).toHaveLength(2);
      expect(asked[1].user).toBe(before.plain.user);
      expect(asked[1].system).toBe(before.plain.system);
    }, 60_000);

    it('adds the guidance, the labels and the pre-scan hints, and keeps a label the model gives', async () => {
      asked.length = 0;
      // The fixture's brief allows 3 to 8 seconds, which these two moments fit.
      const answer = { moments: [{ ...moment(0, 3.9, { hook: 'What a goal' }), label: 'goal' }, { ...moment(4.3, 8.2, { score: 0.4 }), label: 'Something else' }] };
      const result = await suggestMoments({
        source: video, count: 3, brief: parseBrief(before.withBrief.brief), cacheDir: path.join(dir, 'steer-cache-2'), transcriber: steeredTranscriber, ai: ai(answer),
        terms, guidance: 'Big reactions to goals and referee decisions',
      });
      const [request] = asked;
      // The old request is still there, word for word; the steering comes after it.
      expect(request.system.startsWith(before.withBrief.system)).toBe(true);
      expect(request.system).toContain('Big reactions to goals and referee decisions');
      expect(request.system).toContain('- Goal: goal, gol');
      expect(request.system).toContain('leads to check, not confirmed events');
      // The hints: the lines our matcher found, with their times. "GOOOOOL" is "gol".
      expect(request.user.startsWith(before.plain.user)).toBe(true);
      expect(request.user).toContain('Hints');
      expect(request.user).toContain('[0.0-0.9] Goal');
      expect(request.user).toContain('[3.4-5.0] Penalty');
      expect(request.user).toContain('[6.0-8.2] Goal');
      expect(z.toJSONSchema(request.schema).properties.moments.items.required).toContain('label');
      // A label is kept only when it is one of the owner's, in the owner's spelling; the terms heard come from our matcher.
      expect(result.moments).toHaveLength(2);
      expect(result.moments[0]).toMatchObject({ label: 'Goal', matchedTerms: ['goal'] });
      expect(result.moments[1].label).toBeUndefined();
      expect(result.moments[1].matchedTerms).toEqual(['gol', 'penalty']); // in the order of the owner's groups
    }, 60_000);

    it('keeps the answer per set of inputs: the same inputs ask nothing, new terms ask the model but do not transcribe', async () => {
      const cacheDir = path.join(dir, 'steer-cache-3');
      // The fixture's brief allows 3 to 8 seconds, so this moment is usable and is kept.
      const brief = parseBrief(before.withBrief.brief);
      asked.length = 0;
      const first = await suggestMoments({ source: video, brief, cacheDir, transcriber: steeredTranscriber, ai: ai({ moments: [moment(0, 3.9)] }), terms });
      expect(first.moments).toHaveLength(1);
      const again = await suggestMoments({ source: video, brief, cacheDir, transcriber: steeredTranscriber, ai: ai({ moments: [] }), terms });
      expect(asked).toHaveLength(1);
      expect(again).toMatchObject({ resultFromCache: true, fromCache: true });
      expect(again.moments).toEqual(first.moments);
      const other = await suggestMoments({ source: video, brief, cacheDir, transcriber: steeredTranscriber, ai: ai({ moments: [] }), terms, guidance: 'only goals' });
      expect(asked).toHaveLength(2);
      expect(other).toMatchObject({ resultFromCache: false, fromCache: true });
      const forced = await suggestMoments({ source: video, brief, cacheDir, transcriber: steeredTranscriber, ai: ai({ moments: [] }), terms, force: true });
      expect(asked).toHaveLength(3);
      expect(forced.resultFromCache).toBe(false);
    }, 60_000);

    it('does not keep an answer with nothing usable in it, so asking again asks the model', async () => {
      const cacheDir = path.join(dir, 'steer-cache-empty');
      const brief = parseBrief(before.withBrief.brief);
      asked.length = 0;
      await suggestMoments({ source: video, brief, cacheDir, transcriber: steeredTranscriber, ai: ai({ moments: [] }) });
      const again = await suggestMoments({ source: video, brief, cacheDir, transcriber: steeredTranscriber, ai: ai({ moments: [moment(0, 3.9)] }) });
      expect(asked).toHaveLength(2);
      expect(again.resultFromCache).toBe(false);
      expect(again.moments).toHaveLength(1);
    }, 60_000);

    it('takes only a language code, since it goes into a file name', async () => {
      expect(await keptTranscript({ source: video, lang: '../../a', cacheDir: path.join(dir, 'steer-cache-1') })).toBeNull();
      await expect(suggestMoments({ source: video, lang: '/../x', cacheDir: path.join(dir, 'steer-cache-lang'), transcriber: steeredTranscriber, ai: ai({ moments: [] }) }))
        .rejects.toThrow(/not a language code/);
    });

    it('loads a kept result written without label or matchedTerms', async () => {
      const file = path.join(dir, 'old-result.json');
      await writeFile(file, JSON.stringify({ model: 'fake-1', moments: [{ start: 1, end: 9, hook: null, title: 'T', description: 'D', reason: 'R', score: 0.5 }] }));
      const kept = await readKeptResult(file);
      expect(kept.moments[0]).toEqual({ start: 1, end: 9, hook: null, title: 'T', description: 'D', reason: 'R', score: 0.5 });
      await writeFile(file, '{"moments": "not a list"}');
      expect(await readKeptResult(file)).toBeNull();
    });

    it('reads a kept transcript without making one', async () => {
      expect(await keptTranscript({ source: video, cacheDir: path.join(dir, 'steer-cache-1') })).toEqual(before.words);
      expect(await keptTranscript({ source: video, cacheDir: path.join(dir, 'nowhere') })).toBeNull();
    });
  });

  it('says what is missing when no key is set', async () => {
    const noKey = { ...ai({ moments: [] }), isConfigured: () => false, help: 'Set the thing up.' };
    await expect(suggestMoments({ source, cacheDir: dir, transcriber, ai: noKey })).rejects.toThrow('Set the thing up.');
  });
});

// The "Suggest" button beside the hook box (2026-11-21): hooks for the range about to be cut.
describe('hook suggestions', () => {
  let dir;
  let source;
  const asked = [];
  let transcribed = [];
  const said = [['He', 0.2, 0.4], ['really', 0.4, 0.8], ['did', 0.8, 1.0], ['that.', 1.0, 1.4], ['No', 2.0, 2.2], ['way!', 2.2, 2.6]].map(([text, start, end]) => ({ text, start, end }));
  const transcriber = {
    name: 'fake', isInstalled: async () => true,
    transcribe: async (file) => {
      transcribed.push(file);
      return { language: 'en', words: said };
    },
  };
  const ai = (answer) => ({
    service: 'Fake', model: 'fake-1', help: 'Set it up.', isConfigured: () => true,
    ask: async (request) => {
      asked.push(request);
      if (answer instanceof Error) throw answer;
      return { data: answer, usage: { input: 10, output: 5 } };
    },
  });
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'clipper-hook-'));
    source = path.join(dir, 'secret-name.mp4');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440',
      '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source]);
  }, 60_000);
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('transcribes only the range when no transcript is kept, and sends only its words', async () => {
    asked.length = 0;
    transcribed = [];
    const result = await suggestHooks({ source, start: 1, end: 4, cacheDir: path.join(dir, 'none'), transcriber, ai: ai({ hooks: ['He REALLY did that', 'No way he did that?', 'Wait for it'] }) });
    expect(transcribed).toHaveLength(1);
    expect(result).toMatchObject({ transcribed: true, model: 'fake-1' });
    expect(result.hooks.map((hook) => hook.text)).toEqual(['He REALLY did that', 'No way he did that?', 'Wait for it']);
    const [request] = asked;
    expect(request.user).toBe('[0.2-1.4] He really did that.\n[2.0-2.6] No way!');
    expect(request.system).toContain('at most 60 characters');
    // Nothing that names a file or a folder leaves the machine.
    expect(request.user + request.system).not.toContain('secret-name');
    expect(request.user + request.system).not.toContain(dir);
  }, 60_000);

  it('takes the range\'s words from a kept whole-video transcript, on the clip\'s clock, without transcribing', async () => {
    asked.length = 0;
    transcribed = [];
    const cacheDir = path.join(dir, 'cache');
    // Keep a whole-video transcript the way suggested moments does.
    await suggestMoments({ source, cacheDir, transcriber: { ...transcriber, transcribe: async () => ({ language: 'en', words: [{ text: 'Before.', start: 0.5, end: 0.9 }, { text: 'Inside', start: 2.1, end: 2.5 }, { text: 'the', start: 2.5, end: 2.7 }, { text: 'range.', start: 2.7, end: 3.1 }, { text: 'After.', start: 5.2, end: 5.6 }] }) }, ai: ai({ moments: [] }) });
    asked.length = 0;
    const result = await suggestHooks({ source, start: 2, end: 4, cacheDir, transcriber, ai: ai({ hooks: ['Inside the range'] }) });
    expect(transcribed).toHaveLength(0);
    expect(result.transcribed).toBe(false);
    expect(asked[0].user).toBe('[0.1-1.1] Inside the range.');
  }, 60_000);

  it('makes what comes back safe: fitted, cleaned, without repeats, and checked against the brief', () => {
    const brief = parseBrief({ id: 'b', onScreenTextMustInclude: ['ForgeGUI'], forbiddenTerms: ['scam'] });
    const long = 'This is a very long hook that keeps going well past the sixty character limit of the screen';
    const hooks = tidyHooks([`"${long}"`, 'Not a {\\b1}scam', 'not a scam', '', 42, 'ForgeGUI did it'], brief);
    expect(hooks[0].text.length).toBeLessThanOrEqual(60);
    expect(hooks[0].text.startsWith('This is a very long hook')).toBe(true);
    expect(hooks[1]).toEqual({ text: 'Not a b1scam', problems: ['On-screen text: not found in the hook, disclosure, channel tag or end-card text: ForgeGUI'] });
    // The third proposal repeats nothing new, so at most three distinct hooks are kept.
    expect(hooks.map((hook) => hook.text)).toEqual([hooks[0].text, 'Not a b1scam', 'not a scam']);
    expect(hooks[2].problems.some((problem) => problem.startsWith('Forbidden terms: "scam"'))).toBe(true);
    expect(tidyHooks('nonsense')).toEqual([]);
  });

  it('tells the model who the streamer is, where the voice is loud and how chat reacted, never the messages', async () => {
    // Quiet talk at a steady level, then a shout from 2 to 3 s.
    const loudSource = path.join(dir, 'loud.mp4');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30',
      '-f', 'lavfi', '-i', "aevalsrc='if(between(t,2,3),0.9,0.03)*sin(2*PI*800*t)':s=48000", '-t', '6',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', loudSource]);
    asked.length = 0;
    const chat = [
      { t: 3.5, author: 'a', text: 'LMAOOO' }, { t: 4, author: 'b', text: 'no way' }, { t: 4.2, author: 'c', text: 'KEKW' },
      { t: 4.4, author: 'd', text: '!points' }, { t: 4.6, author: 'e', text: 'secret words of a viewer' },
    ];
    const result = await suggestHooks({ source: loudSource, start: 1, end: 5, streamer: '@Keerk', chat, cacheDir: path.join(dir, 'none3'), transcriber, ai: ai({ hooks: ['Keerk loses it'] }) });
    const [request] = asked;
    expect(request.system).toContain('The streamer is called Keerk.');
    expect(request.user).toMatch(/^Transcript:\n\[0\.2-1\.4\] He really did that\./);
    // The shout is at 1-2 s on the clip's clock.
    expect(request.user).toMatch(/\n\[1\.0-2\.0\] \d+ dB louder than usual/);
    // "no way" is shock and fail in chat's word lists.
    expect(request.user).toContain("Chat's reactions to this clip (messages counted by kind): laughing 2, shock 1, fail 1.");
    expect(request.user + request.system).not.toMatch(/LMAOOO|KEKW|secret words|points|author/);
    expect(result.used).toEqual({ loud: 1, chat: 3 });
  }, 60_000);

  it('says what is missing, in its own words', async () => {
    await expect(suggestHooks({ source, start: 1, end: 4, cacheDir: dir, transcriber, ai: { ...ai({}), isConfigured: () => false } })).rejects.toThrow('Set it up.');
    await expect(suggestHooks({ source, start: 4, end: 1, cacheDir: dir, transcriber, ai: ai({}) })).rejects.toThrow(/start and the end/);
    const silent = { ...transcriber, transcribe: async () => ({ language: 'en', words: [] }) };
    await expect(suggestHooks({ source, start: 1, end: 4, cacheDir: path.join(dir, 'none2'), transcriber: silent, ai: ai({}) })).rejects.toThrow(/No speech was found/);
  }, 60_000);
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
