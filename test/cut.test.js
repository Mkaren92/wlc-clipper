// Runs the real ffmpeg against a small generated video. Needs ffmpeg and
// ffprobe on the PATH.
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkClip, checkRange, clipSlug, cut, localIsoTime, rerender } from '../src/cut.js';
import { probe } from '../src/probe.js';
import { run } from '../src/run.js';

let dir;
let source;

// The source is black and silent except for a white flash and a beep, both
// starting 2 seconds in. A second audio track stands in for a game recording
// with separate tracks; the clip must keep only the first.
const SIGNAL_AT = 2;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'clipper-test-'));
  source = path.join(dir, 'source.mp4');
  const flash = `drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='between(t,${SIGNAL_AT},${SIGNAL_AT + 0.0999})'`;
  const beep = `aevalsrc='if(between(t,${SIGNAL_AT},${SIGNAL_AT + 0.1}),sin(2*PI*1000*t),0)':s=48000`;
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=1920x1080:r=60,${flash}`,
    '-f', 'lavfi', '-i', beep,
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000',
    '-t', '6', '-map', '0:v', '-map', '1:a', '-map', '2:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    source,
  ]);
}, 60_000);

/** Time of the first bright frame in a video, in seconds. */
async function firstBrightFrame(file) {
  const { stderr } = await run('ffmpeg', [
    '-hide_banner', '-i', file, '-an',
    '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG',
    '-f', 'null', '-',
  ]);
  let time = null;
  for (const line of stderr.split('\n')) {
    const pts = /pts_time:([\d.]+)/.exec(line);
    if (pts) time = Number(pts[1]);
    const brightness = /YAVG=([\d.]+)/.exec(line);
    if (brightness && Number(brightness[1]) > 100) return time;
  }
  return null;
}

/** Time the first sound starts in a file, in seconds. */
async function firstSound(file) {
  const { stderr } = await run('ffmpeg', [
    '-hide_banner', '-i', file, '-vn',
    '-af', 'silencedetect=n=-40dB:d=0.05',
    '-f', 'null', '-',
  ]);
  const match = /silence_end: ([\d.]+)/.exec(stderr);
  return match ? Number(match[1]) : null;
}

/** Loudest level anywhere in a file, in dB. Digital silence is about -91. */
async function peakLevel(file) {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
  return Number(/max_volume: (-?[\d.]+) dB/.exec(stderr)[1]);
}

// Stands in for the real speech-to-text engine, which needs Python.
const fakeTranscriber = {
  name: 'fake',
  isInstalled: async () => true,
  transcribe: async () => ({
    language: 'en',
    words: [
      { text: 'He', start: 0.32, end: 0.48 },
      { text: 'did', start: 0.48, end: 0.66 },
      { text: 'not.', start: 0.66, end: 0.95 },
    ],
  }),
};
const notInstalled = { ...fakeTranscriber, isInstalled: async () => false };

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('cut', () => {
  it.each(['center', 'blur'])('renders the %s layout as 1080x1920 at 30 fps', async (layout) => {
    const outDir = path.join(dir, `out-${layout}`);
    const { clipDir, meta, warnings } = await cut({
      source, start: 1, end: 4, layout, outDir, toolVersion: 'test', captions: false,
    });

    const clip = await probe(path.join(clipDir, 'clip.mp4'));
    expect([clip.width, clip.height, clip.fps]).toEqual([1080, 1920, 30]);
    expect(Math.abs(clip.duration - 3)).toBeLessThan(0.1);
    expect(clip.audioStreams).toBe(1);
    expect(warnings).toEqual([]);

    // Picture and sound must both land where the source had them, to within
    // one output frame.
    const clipFile = path.join(clipDir, 'clip.mp4');
    const expected = SIGNAL_AT - 1;
    const frame = 1 / 30;
    expect(Math.abs((await firstBrightFrame(clipFile)) - expected)).toBeLessThan(frame);
    expect(Math.abs((await firstSound(clipFile)) - expected)).toBeLessThan(frame);

    const saved = JSON.parse(await readFile(path.join(clipDir, 'work', 'meta.json'), 'utf8'));
    expect(saved).toEqual(meta);
    expect(saved).toMatchObject({
      source,
      start: 1,
      end: 4,
      layout,
      captions: false,
      output: { file: 'clip.mp4', width: 1080, height: 1920, fps: 30, audio: true },
    });
  }, 120_000);

  it('renders a wider crop as 1080x1920, in step, and again from its saved settings', async () => {
    // 1006 px of a 1080 px high frame comes to 1159.4 px high on screen, an
    // odd number that the encoder would refuse if it were not made even.
    const { clipDir, meta } = await cut({
      source, start: 1, end: 4, layout: 'center', cropWidth: 1006, cropX: 300,
      outDir: path.join(dir, 'out-wide'), toolVersion: 'test', captions: false,
    });
    expect(meta).toMatchObject({ layout: 'center', cropX: 300, cropWidth: 1006 });
    const clipFile = path.join(clipDir, 'clip.mp4');
    const clip = await probe(clipFile);
    expect([clip.width, clip.height, clip.fps]).toEqual([1080, 1920, 30]);
    const frame = 1 / 30;
    expect(Math.abs((await firstBrightFrame(clipFile)) - (SIGNAL_AT - 1))).toBeLessThan(frame);
    expect(Math.abs((await firstSound(clipFile)) - (SIGNAL_AT - 1))).toBeLessThan(frame);

    const again = await rerender(clipDir);
    expect(again.meta).toMatchObject({ cropX: 300, cropWidth: 1006 });
    expect((await probe(clipFile)).height).toBe(1920);
  }, 120_000);

  it('numbers clip folders in order', async () => {
    const outDir = path.join(dir, 'out-numbering');
    const first = await cut({ source, start: 0, end: 0.5, outDir, toolVersion: 'test', captions: false });
    const second = await cut({ source, start: 0, end: 0.5, outDir, toolVersion: 'test', captions: false });
    expect(path.basename(first.clipDir)).toBe('clip-001');
    expect(path.basename(second.clipDir)).toBe('clip-002');
  }, 120_000);

  it('names a clip folder after its hook, and adds a number when the name is taken', async () => {
    const outDir = path.join(dir, 'out-named');
    const make = (hook) => cut({ source, start: 0, end: 0.5, hook, outDir, toolVersion: 'test', captions: false });
    const names = [];
    for (const hook of ['Barca wants WHO?', 'Barca wants WHO?', 'barca  wants who', undefined, '?!', undefined]) {
      names.push(path.basename((await make(hook)).clipDir));
    }
    // A hook with nothing usable in it falls back to a number, like no hook at all.
    expect(names).toEqual(['barca-wants-who', 'barca-wants-who-2', 'barca-wants-who-3', 'clip-001', 'clip-002', 'clip-003']);
  }, 120_000);

  it('rejects a range that runs past the end of the video', async () => {
    await expect(cut({ source, start: 4, end: 30, outDir: dir, toolVersion: 'test' })).rejects.toThrow(
      /only 0:06\.00 long/,
    );
  });
});

describe('captions and hook', () => {
  it('burns in captions and a hook without moving picture or sound', async () => {
    const { clipDir, meta, warnings } = await cut({
      source, start: 1, end: 4, layout: 'facecam', cam: { x: 1400, y: 40, width: 480, height: 270 },
      hook: 'He did NOT expect that', outDir: path.join(dir, 'out-captions'), toolVersion: 'test',
      transcriber: fakeTranscriber,
    });
    expect(warnings).toEqual([]);
    expect(meta).toMatchObject({ captions: true, hook: 'He did NOT expect that', lang: 'en' });
    expect(meta.output.captionGroups).toBe(1);

    // The transcript stays for later fixes; the audio file and the fonts link do not.
    expect((await readdir(clipDir)).sort()).toEqual(['clip.mp4', 'work']);
    expect((await readdir(path.join(clipDir, 'work'))).sort()).toEqual(['captions.ass', 'meta.json', 'transcript.json']);
    const ass = await readFile(path.join(clipDir, 'work', 'captions.ass'), 'utf8');
    expect(ass).toContain(',Caption,,0,0,0,,HE DID NOT');
    expect(ass).toContain(',Hook,,0,0,670,,{\\q0}He did NOT expect that');

    const clipFile = path.join(clipDir, 'clip.mp4');
    const clip = await probe(clipFile);
    expect([clip.width, clip.height, clip.fps]).toEqual([1080, 1920, 30]);
    // The hook is a white box, so the first bright frame is now the hook at 0.
    // Sound is still the check that nothing shifted.
    expect(Math.abs((await firstSound(clipFile)) - (SIGNAL_AT - 1))).toBeLessThan(1 / 30);
  }, 120_000);

  it('renders again from an edited transcript and keeps the clip if that fails', async () => {
    const { clipDir } = await cut({
      source, start: 1, end: 3, outDir: path.join(dir, 'out-rerender'), toolVersion: 'test',
      transcriber: fakeTranscriber,
    });
    const transcriptFile = path.join(clipDir, 'work', 'transcript.json');
    const transcript = JSON.parse(await readFile(transcriptFile, 'utf8'));
    transcript.words[2].text = 'NOT!';
    transcript.words.push({ text: 'ever', start: 1.6, end: 1.9 });
    await writeFile(transcriptFile, JSON.stringify(transcript));

    const again = await rerender(clipDir);
    expect(again.meta.output.captionGroups).toBe(2);
    expect(await readFile(path.join(clipDir, 'work', 'captions.ass'), 'utf8')).toContain(',,EVER');

    await writeFile(transcriptFile, '{ not json');
    await expect(rerender(clipDir)).rejects.toThrow(/not valid JSON/);
    expect((await probe(path.join(clipDir, 'clip.mp4'))).duration).toBeCloseTo(2, 1);
  }, 120_000);

  it('still shows the hook with captions off', async () => {
    const { clipDir, meta } = await cut({
      source, start: 1, end: 2, hook: 'Watch this', hookSeconds: 0, captions: false,
      outDir: path.join(dir, 'out-hook-only'), toolVersion: 'test', transcriber: fakeTranscriber,
    });
    expect(meta.captions).toBe(false);
    expect((await readdir(clipDir)).sort()).toEqual(['clip.mp4', 'work']);
    expect((await readdir(path.join(clipDir, 'work'))).sort()).toEqual(['captions.ass', 'meta.json']);
    // A hook time of 0 keeps the hook for the whole 1-second clip, and is saved.
    expect(meta.hookSeconds).toBe(0);
    expect(await readFile(path.join(clipDir, 'work', 'captions.ass'), 'utf8')).toContain('0:00:00.00,0:00:01.00,Hook');
    await expect(cut({ source, start: 1, end: 2, hook: 'x', hookSeconds: -1, outDir: dir, toolVersion: 'test' })).rejects.toThrow(/0 or more/);
  }, 120_000);

  it('makes the clip without captions when the transcriber is not installed', async () => {
    const { meta, warnings } = await cut({
      source, start: 1, end: 2, outDir: path.join(dir, 'out-not-installed'), toolVersion: 'test',
      transcriber: notInstalled,
    });
    expect(meta.captions).toBe(false);
    expect(warnings.join(' ')).toMatch(/npm run setup/);
  }, 120_000);

  it('still renders and checks a clip folder from before the work subfolder existed', async () => {
    const { clipDir } = await cut({
      source, start: 1, end: 3, outDir: path.join(dir, 'out-old-layout'), toolVersion: 'test',
      transcriber: fakeTranscriber,
    });
    // Rebuild the old shape: every file next to clip.mp4, and a meta.json
    // without the fields that were added later.
    const work = path.join(clipDir, 'work');
    const { cam, cropWidth, hook, hookSeconds, lang, trim, brief, briefPath, checks, ...oldMeta } = JSON.parse(
      await readFile(path.join(work, 'meta.json'), 'utf8'),
    );
    await writeFile(path.join(clipDir, 'meta.json'), JSON.stringify(oldMeta));
    await rename(path.join(work, 'transcript.json'), path.join(clipDir, 'transcript.json'));
    await rm(work, { recursive: true });

    const again = await rerender(clipDir);
    expect(again.meta).toMatchObject({ cropWidth: null, trim: 0, cam: null, hook: null, hookSeconds: 2.5, captions: true, lang: 'en', brief: null });
    expect(again.meta.output.captionGroups).toBe(1);
    expect((await readdir(clipDir)).sort()).toEqual(['captions.ass', 'clip.mp4', 'meta.json', 'transcript.json']);
    await expect(checkClip(clipDir)).rejects.toThrow(/made without a brief/);
  }, 120_000);

  it('says so when a folder is not a clip folder', async () => {
    await expect(rerender(dir)).rejects.toThrow(/not a clip folder/);
  });
});

describe('briefs', () => {
  const briefs = {};

  beforeAll(async () => {
    const write = async (name, brief) => {
      briefs[name] = path.join(dir, `${name}.json`);
      await writeFile(briefs[name], JSON.stringify({ id: name, ...brief }));
    };
    await write('card', {
      maxSeconds: 5,
      hashtags: { required: ['#partner', '#roblox'], strictOrder: true, optional: ['#gamedev'] },
      onScreenTextMustInclude: ['ForgeGUI'],
      forbiddenTerms: ['not'],
      disclosure: { mode: 'onscreen', text: 'Sponsored by ForgeGUI' },
      endCard: { seconds: 1, text: 'Try ForgeGUI' },
      replacements: { he: 'She' },
      manualChecks: ['Pin a comment'],
    });
    await write('strict', { minSeconds: 8, keepFullFrame: true, forbiddenTerms: ['scam'] });
  });

  it('follows a brief: post text, disclosure, end card and checks', async () => {
    // The beep is at 2.0 s in the source. This range ends at 1.5 s, so with
    // the 1 s card the clip runs to what would be 2.5 s. If the source kept
    // playing under the card, the beep would be heard; it must not be.
    const { clipDir, meta, warnings, checks } = await cut({
      source, start: 0.5, end: 1.5, hook: 'Watch this trick', briefFile: briefs.card,
      description: 'Built in one evening.', outDir: path.join(dir, 'out-brief'), toolVersion: 'test',
      transcriber: fakeTranscriber,
    });
    expect(warnings).toEqual([]);
    const clipFile = path.join(clipDir, 'clip.mp4');
    const clip = await probe(clipFile);
    expect([clip.width, clip.height, clip.fps, clip.audioStreams]).toEqual([1080, 1920, 30, 1]);
    expect(clip.duration).toBeCloseTo(2, 1);
    expect(await peakLevel(clipFile)).toBeLessThan(-60);

    expect(await readFile(path.join(clipDir, 'post.txt'), 'utf8')).toBe(
      'Watch this trick\n\nBuilt in one evening.\n\n#partner #roblox #gamedev\n',
    );
    const ass = await readFile(path.join(clipDir, 'work', 'captions.ass'), 'utf8');
    const events = ass.split('\n').filter((line) => line.startsWith('Dialogue:'));
    expect(events[0]).toContain('0:00:00.00,0:00:01.00,Hook,,0,0,0,,{\\q0}Sponsored by ForgeGUI');
    expect(events[1]).toContain('{\\q0}Watch this trick');
    expect(events[2]).toContain('0:00:01.00,0:00:02.00,Hook,,0,0,540,,{\\an2\\q0}Try ForgeGUI');
    // The brief's word fix was applied to the transcript.
    expect(ass).toContain(',,SHE DID NOT');

    // "not" is forbidden and is spoken, which is only known after transcription:
    // the clip is still made, and the rule is reported as failed.
    expect(Object.fromEntries(checks.map((c) => [c.rule, c.pass]))).toEqual({
      Length: true, 'Required hashtags': true, 'On-screen text': true, 'Forbidden terms': false,
      Disclosure: true, Format: true,
    });
    expect(checks.find((c) => !c.pass).detail).toBe('"not" is in the captions at 0:00.66');
    expect(meta.checks).toEqual(checks);
    expect(meta.brief.id).toBe('card');
  }, 120_000);

  it('keeps picture and sound in place before an end card', async () => {
    const { clipDir } = await cut({
      source, start: 1, end: 3, title: 'ForgeGUI test', briefFile: briefs.card, captions: false,
      outDir: path.join(dir, 'out-brief-sync'), toolVersion: 'test',
    });
    const clipFile = path.join(clipDir, 'clip.mp4');
    expect((await probe(clipFile)).duration).toBeCloseTo(3, 1);
    expect(Math.abs((await firstBrightFrame(clipFile)) - (SIGNAL_AT - 1))).toBeLessThan(1 / 30);
    expect(Math.abs((await firstSound(clipFile)) - (SIGNAL_AT - 1))).toBeLessThan(1 / 30);
  }, 120_000);

  it('checks post.txt as it stands on disk, and against another brief', async () => {
    const { clipDir } = await cut({
      source, start: 1, end: 3, title: 'ForgeGUI test', briefFile: briefs.card, captions: false,
      outDir: path.join(dir, 'out-brief-check'), toolVersion: 'test',
    });
    const passes = async (...args) => Object.fromEntries((await checkClip(...args)).checks.map((c) => [c.rule, c.pass]));
    expect(await passes(clipDir)).toMatchObject({ 'Required hashtags': true, 'Forbidden terms': true });

    await writeFile(path.join(clipDir, 'post.txt'), 'A scam? No\n\n#roblox #partner\n');
    expect(await passes(clipDir)).toMatchObject({ 'Required hashtags': false });
    expect(await passes(clipDir, briefs.strict)).toEqual({ Length: false, 'Forbidden terms': false, Format: true, 'Full frame': false });

    // A render never rewrites post.txt.
    await rerender(clipDir);
    expect(await readFile(path.join(clipDir, 'post.txt'), 'utf8')).toBe('A scam? No\n\n#roblox #partner\n');
  }, 120_000);

  it('stops before making a folder when the brief does not allow the clip', async () => {
    const outDir = path.join(dir, 'out-brief-rejected');
    await expect(
      cut({ source, start: 1, end: 3, title: 'Not a scam', layout: 'center', briefFile: briefs.strict, outDir, toolVersion: 'test' }),
    ).rejects.toThrow(/does not allow this clip:\n  Length: .*\n  Forbidden terms: "scam" is in the title\n  Full frame: /);
    await expect(readdir(outDir)).rejects.toThrow(/ENOENT/);
  });

  it('counts the end card in the length rule', async () => {
    await expect(
      cut({ source, start: 0, end: 4.5, title: 'ForgeGUI', briefFile: briefs.card, outDir: dir, toolVersion: 'test' }),
    ).rejects.toThrow(/Length: the clip is 5\.5 s; the brief asks for at most 5 s/);
  });

  it('needs a title when there is a brief', async () => {
    await expect(cut({ source, start: 1, end: 3, briefFile: briefs.card, outDir: dir, toolVersion: 'test' })).rejects.toThrow(
      /needs a title/,
    );
  });

  it('saves a title and description without a brief: no hashtags, no checks', async () => {
    const { clipDir, meta, checks } = await cut({
      source, start: 1, end: 2, title: 'Araújo over Martínez', description: 'My honest take.', captions: false,
      outDir: path.join(dir, 'out-post-no-brief'), toolVersion: 'test',
    });
    expect(await readFile(path.join(clipDir, 'post.txt'), 'utf8')).toBe('Araújo over Martínez\n\nMy honest take.\n');
    expect([meta.brief, checks]).toEqual([null, []]);

    // Only a description: the hook becomes the title. Neither given: no post.txt.
    const hooked = await cut({
      source, start: 1, end: 2, hook: 'Watch this', description: 'Text.', captions: false,
      outDir: path.join(dir, 'out-post-no-brief'), toolVersion: 'test',
    });
    expect(await readFile(path.join(hooked.clipDir, 'post.txt'), 'utf8')).toBe('Watch this\n\nText.\n');
    const plain = await cut({ source, start: 1, end: 2, captions: false, outDir: path.join(dir, 'out-post-no-brief'), toolVersion: 'test' });
    expect((await readdir(plain.clipDir)).sort()).toEqual(['clip.mp4', 'work']);
  }, 120_000);

  it('says a clip without a brief needs one named', async () => {
    const { clipDir } = await cut({
      source, start: 1, end: 2, captions: false, outDir: path.join(dir, 'out-no-brief'), toolVersion: 'test',
    });
    await expect(checkClip(clipDir)).rejects.toThrow(/made without a brief/);
    expect((await checkClip(clipDir, briefs.strict)).checks.map((c) => c.rule)).toEqual(['Length', 'Forbidden terms', 'Format', 'Full frame']);
  }, 120_000);
});

describe('clipSlug', () => {
  it.each([
    ['Barca wants WHO?', 'barca-wants-who'],
    ["I'd take Araújo over Martínez", 'i-d-take-araújo-over-martínez'],
    ['  --He did NOT expect that!!  ', 'he-did-not-expect-that'],
    ['../../etc/passwd', 'etc-passwd'],
    ['20K by the end of the year', '20k-by-the-end-of-the-year'],
    ['?!…', ''],
  ])('turns %j into %j', (hook, slug) => {
    expect(clipSlug(hook)).toBe(slug);
  });

  it('cuts a long hook at a word', () => {
    const slug = clipSlug('This hook is far too long to fit on the screen in two lines');
    expect(slug).toBe('this-hook-is-far-too-long-to-fit-on-the-screen-in');
    expect(slug.length).toBeLessThanOrEqual(50);
  });
});

describe('checkRange', () => {
  it('rejects an end that is not after the start', () => {
    expect(() => checkRange(10, 10, 60)).toThrow(/must be later/);
    expect(() => checkRange(10, 5, 60)).toThrow(/must be later/);
  });

  it('accepts a range that ends exactly at the end of the video', () => {
    expect(() => checkRange(50, 60, 60)).not.toThrow();
  });
});

describe('localIsoTime', () => {
  it('writes local time with a UTC offset', () => {
    expect(localIsoTime(new Date())).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
  });
});
