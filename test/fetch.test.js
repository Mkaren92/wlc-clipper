// Fetching part of a video, with a stand-in for the downloader. These tests
// never reach YouTube.
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDescription } from '../src/compilation/description.js';
import { fetchVideo, leadInOf, removeHiddenLeadIn, videoUrl } from '../src/fetch.js';
import { run } from '../src/run.js';
import { agreedSourceOf, channelKey, creditLinks, parseSources, readSources, saveSources } from '../src/sources.js';

const sources = parseSources([
  { id: 'northstand', name: 'Northstand', url: 'https://www.youtube.com/@northstandtv', status: 'agreed', note: 'Said yes by email' },
  { id: 'kopend', name: 'Kopend', url: 'https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa', status: 'agreed' },
  { id: 'terrace', name: 'Terrace Talk', url: 'https://www.youtube.com/@terracetalk', status: 'asked' },
  { id: 'dave', name: 'Away Day Dave', url: 'https://www.youtube.com/@awaydaydave', status: 'declined' },
]);

describe('videoUrl', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?t=42', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/live/dQw4w9WgXcQ?feature=share', 'dQw4w9WgXcQ'],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123', 'dQw4w9WgXcQ'],
    [' https://www.youtube.com/shorts/dQw4w9WgXcQ ', 'dQw4w9WgXcQ'],
  ])('reads %s', (link, id) => {
    expect(videoUrl(link)).toBe(`https://www.youtube.com/watch?v=${id}`);
  });

  it.each([
    'http://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/@northstandtv',
    'https://www.youtube.com/playlist?list=PL123',
    'https://example.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=--exec=rm',
    'file:///etc/passwd',
    'not a link',
    '',
  ])('refuses %j', (link) => {
    expect(() => videoUrl(link)).toThrow(/link to one YouTube video/);
  });
});

describe('sources', () => {
  it('reads a channel from its address', () => {
    expect(channelKey('https://www.youtube.com/@NorthStandTV')).toEqual({ handle: '@northstandtv' });
    expect(channelKey('https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa/')).toEqual({ channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa' });
    for (const bad of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://example.com/@x', 'http://www.youtube.com/@x', 'x']) {
      expect(channelKey(bad)).toBeNull();
    }
  });

  it('matches a video to a channel only when that channel has agreed', () => {
    expect(agreedSourceOf(sources, { handle: '@NorthStandTV', channelId: 'UCxxx' })?.name).toBe('Northstand');
    expect(agreedSourceOf(sources, { handle: '@kopend', channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa' })?.name).toBe('Kopend');
    expect(agreedSourceOf(sources, { handle: '@terracetalk', channelId: 'UCyyy' })).toBeNull();
    expect(agreedSourceOf(sources, { handle: '@awaydaydave', channelId: 'UCzzz' })).toBeNull();
    expect(agreedSourceOf(sources, { handle: '@someoneelse', channelId: 'UCqqq' })).toBeNull();
    expect(agreedSourceOf(sources, {})).toBeNull();
  });

  it('saves and reads the list, and rejects one that is not well formed', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'clipper-sources-'));
    expect(await readSources(dir)).toEqual([]);
    await saveSources(dir, sources);
    expect((await readSources(dir)).map((source) => [source.name, source.status])).toContainEqual(['Terrace Talk', 'asked']);
    await rm(dir, { recursive: true });
    expect(() => parseSources([{ id: 'x', name: 'X', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }])).toThrow(/channel address/);
    expect(() => parseSources([{ id: 'x', name: 'X', url: 'https://www.youtube.com/@x', status: 'maybe' }])).toThrow(/not valid/);
    expect(() => parseSources([sources[0], { ...sources[1], id: 'northstand' }])).toThrow(/share an id/);
  });

  it('gives links for the credits of agreed channels only', () => {
    expect(creditLinks(sources)).toEqual({ northstand: 'https://www.youtube.com/@northstandtv', kopend: 'https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa' });
    const text = buildDescription([
      { kind: 'video', seconds: 5, credit: 'northstand' },
      { kind: 'video', seconds: 5, credit: 'Terrace Talk' },
    ], creditLinks(sources));
    expect(text).toContain('- northstand: https://www.youtube.com/@northstandtv\n- Terrace Talk\n');
  });
});

describe('fetchVideo', () => {
  let dir;
  const calls = [];
  // Says every video is Northstand's unless told otherwise, and "downloads" by making a short test video.
  const downloader = (video = {}, installed = true) => ({
    isInstalled: async () => installed,
    info: async () => ({ id: 'dQw4w9WgXcQ', title: 'Barca v United watchalong', channel: 'Northstand', channelId: 'UCxxx', handle: '@northstandtv', duration: 7200, ...video }),
    download: async (job) => {
      calls.push(job);
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-t', '2', '-pix_fmt', 'yuv420p', path.join(job.dir, `${job.name}.mp4`)]);
    },
  });
  const link = 'https://youtu.be/dQw4w9WgXcQ';
  const ask = (options) => fetchVideo({ url: link, start: 3720, end: 3900, sources, outDir: dir, downloader: downloader(), ...options });

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'clipper-fetch-'));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('fetches a part from an agreed channel, under a name made from the channel, the video and the range', async () => {
    const steps = [];
    const fetched = await ask({ onStep: (step) => steps.push(step) });
    expect(fetched).toMatchObject({ name: 'northstand_dQw4w9WgXcQ_1h02m00s-1h05m00s.mp4', title: 'Barca v United watchalong', source: { name: 'Northstand' } });
    expect(steps).toEqual(['looking', 'fetching', 'tidying']);
    // The stand-in's video has nothing hidden at its start, so it is left as it is.
    expect(fetched.early).toBe(0);
    expect(calls.at(-1)).toMatchObject({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', start: 3720, end: 3900 });
    // The same part again gets its own name.
    expect((await ask({})).name).toBe('northstand_dQw4w9WgXcQ_1h02m00s-1h05m00s_2.mp4');
    expect((await readdir(dir)).sort()).toEqual(['northstand_dQw4w9WgXcQ_1h02m00s-1h05m00s.mp4', 'northstand_dQw4w9WgXcQ_1h02m00s-1h05m00s_2.mp4']);
  }, 60_000);

  it('names the file from the id checked in the link, whatever the downloader reports', async () => {
    const fetched = await ask({ downloader: downloader({ id: '../../somewhere-else' }), start: 60, end: 90 });
    expect(fetched.name).toBe('northstand_dQw4w9WgXcQ_1m00s-1m30s.mp4');
    expect(path.dirname(fetched.file)).toBe(dir);
    await rm(fetched.file);
  }, 60_000);

  it('does not keep a download that cannot be prepared', async () => {
    const broken = { ...downloader(), download: async (job) => writeFile(path.join(job.dir, `${job.name}.mp4`), 'not a video') };
    await expect(ask({ downloader: broken, start: 131, end: 161 })).rejects.toThrow(/could not be prepared, so it was not kept/);
    expect((await readdir(dir)).filter((name) => name.includes('2m11s'))).toEqual([]);
  });

  it('refuses a video from a channel that has not agreed, and downloads nothing', async () => {
    const before = calls.length;
    for (const video of [
      { channel: 'Terrace Talk', handle: '@terracetalk', channelId: 'UCyyy' },
      { channel: 'Away Day Dave', handle: '@awaydaydave', channelId: 'UCzzz' },
      { channel: 'Somebody Else', handle: '@somebody', channelId: 'UCqqq' },
    ]) {
      await expect(ask({ downloader: downloader(video) })).rejects.toThrow(new RegExp(`from "${video.channel}", which is not marked as agreed`));
    }
    await expect(ask({ sources: [] })).rejects.toThrow(/not marked as agreed/);
    expect(calls.length).toBe(before);
  });

  it('needs a range, of at most 20 minutes, inside the video', async () => {
    await expect(ask({ start: 100, end: 100 })).rejects.toThrow(/end must be after the start/);
    await expect(ask({ start: undefined, end: undefined })).rejects.toThrow(/start and the end/);
    await expect(ask({ start: 0, end: 1201 })).rejects.toThrow(/at most 20 minutes/);
    await expect(ask({ start: 7190, end: 7300 })).rejects.toThrow(/only 2:00:00.00 long/);
  });

  it('refuses a link that is not one YouTube video, and says when the downloader is missing', async () => {
    await expect(ask({ url: 'https://example.com/video.mp4' })).rejects.toThrow(/link to one YouTube video/);
    await expect(ask({ downloader: downloader({}, false) })).rejects.toThrow(/npm run setup/);
  });
});

// A part cut without encoding again starts at an earlier keyframe, with the
// extra picture and sound marked "skip this". Players disagree about how to
// skip, which put the sound almost 3 s away from the picture on a real fetch.
// These files are made the same way: black and silent but for a flash and a
// beep at 7.0 s, with a keyframe every 5 s.
describe('removeHiddenLeadIn', () => {
  let dir;
  const SIGNAL_AT = 7;
  const quiet = ['-hide_banner', '-loglevel', 'error', '-y'];
  const beep = `aevalsrc='if(between(t,${SIGNAL_AT},${SIGNAL_AT + 0.1}),sin(2*PI*1000*t),0)':s=48000`;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'clipper-leadin-'));
    const flash = `drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='between(t,${SIGNAL_AT},${SIGNAL_AT + 0.0999})'`;
    // Once without B-frames, as AV1 from YouTube is, and once with them, as its H.264 is.
    for (const [name, bFrames] of [['picture.mp4', '0'], ['picture-b.mp4', '3']]) {
      await run('ffmpeg', [...quiet, '-f', 'lavfi', '-i', `color=c=black:s=320x180:r=30,${flash}`, '-t', '14',
        '-c:v', 'libx264', '-g', '150', '-keyint_min', '150', '-sc_threshold', '0', '-bf', bFrames, '-pix_fmt', 'yuv420p', path.join(dir, name)]);
    }
    await run('ffmpeg', [...quiet, '-f', 'lavfi', '-i', beep, '-t', '14', '-c:a', 'aac', path.join(dir, 'sound.mp4')]);
    // Sound in 4 s blocks, so a cut can only start at the block before.
    await run('ffmpeg', [...quiet, '-f', 'lavfi', '-i', beep, '-t', '14', '-c:a', 'libopus', '-b:a', '64k',
      '-cluster_time_limit', '4000', '-cluster_size_limit', '4000000', path.join(dir, 'blocks.webm')]);
  }, 60_000);
  afterAll(() => rm(dir, { recursive: true, force: true }));

  /** Cut picture and sound from `start` without encoding, each from its own file, as the downloader does. */
  async function cutPart(name, start, pictureFile, soundFile) {
    const file = path.join(dir, name);
    await run('ffmpeg', [...quiet, '-ss', String(start), '-t', '6', '-i', path.join(dir, pictureFile), '-ss', String(start), '-t', '6', '-i', path.join(dir, soundFile),
      '-map', '0:v', '-map', '1:a', '-c', 'copy', file]);
    return file;
  }
  /** Where the flash and the beep are, read as the file asks to be played or from its very first packet. */
  async function signals(file, ignoreMarks, hasSound = true) {
    const input = [...(ignoreMarks ? ['-ignore_editlist', '1'] : []), '-i', file];
    const picture = await run('ffmpeg', ['-hide_banner', ...input, '-an', '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-']);
    let time = null;
    let flash = null;
    for (const line of picture.stderr.split('\n')) {
      const pts = /pts_time:(-?[\d.]+)/.exec(line);
      if (pts) time = Number(pts[1]);
      if (flash === null && Number(/YAVG=([\d.]+)/.exec(line)?.[1]) > 100) flash = time;
    }
    if (!hasSound) return { flash, beep: null };
    const sound = await run('ffmpeg', ['-hide_banner', ...input, '-vn', '-af', 'silencedetect=n=-40dB:d=0.05', '-f', 'null', '-']);
    return { flash, beep: Number(/silence_end: ([\d.]+)/.exec(sound.stderr)?.[1]) };
  }
  const frames = async (file, ignoreMarks) => (await run('ffmpeg', [...quiet, ...(ignoreMarks ? ['-ignore_editlist', '1'] : []), '-i', file, '-map', '0:v:0', '-f', 'md5', '-'])).stdout.trim();
  const ONE_FRAME = 1 / 30;

  it.each([
    // Asked from 6 s: the picture goes back 1 s to its keyframe, the sound hardly at all.
    { name: 'the picture has the longer lead-in', start: 6, pictureFile: 'picture.mp4', soundFile: 'sound.mp4', early: 1, longer: 'picture' },
    // Asked from 5.5 s: the picture goes back 0.5 s, the sound to the start of its block.
    { name: 'the sound has the longer lead-in', start: 5.5, pictureFile: 'picture.mp4', soundFile: 'blocks.webm', early: 0.5, longer: 'sound' },
    { name: 'the picture has the longer lead-in and B-frames', start: 6, pictureFile: 'picture-b.mp4', soundFile: 'sound.mp4', early: 1, longer: 'picture' },
    { name: 'the sound has the longer lead-in and the picture B-frames', start: 5.5, pictureFile: 'picture-b.mp4', soundFile: 'blocks.webm', early: 0.5, longer: 'sound' },
  ])('makes the lead-in ordinary video when $name', async ({ start, pictureFile, soundFile, early, longer }) => {
    const file = await cutPart(`part-${longer}-${pictureFile}`, start, pictureFile, soundFile);
    const picture = await leadInOf(file, 'v:0');
    const sound = await leadInOf(file, 'a:0');
    // With B-frames the first picture is two frames after zero; that is not lead-in.
    expect(picture.lead - picture.rawStart).toBeCloseTo(early, 2);
    if (longer === 'sound') expect(sound.lead).toBeGreaterThan(picture.lead + 0.5);
    else expect(sound.lead).toBeLessThan(0.1);
    const before = await frames(file, true);

    expect(await removeHiddenLeadIn(file)).toBeCloseTo(early, 2);

    // Nothing is hidden any more: the file reads the same either way.
    const after = await leadInOf(file, 'v:0');
    expect(after.lead - after.rawStart).toBeLessThan(0.001);
    expect((await leadInOf(file, 'a:0')).lead).toBeLessThan(0.03);
    // The flash and the beep are together, where the source has them.
    const at = SIGNAL_AT - start + picture.lead;
    for (const ignoreMarks of [false, true]) {
      const found = await signals(file, ignoreMarks);
      expect(found.flash).toBeCloseTo(at, 2);
      expect(Math.abs(found.beep - found.flash)).toBeLessThan(ONE_FRAME);
    }
    // The picture was copied, not encoded again.
    expect(await frames(file, false)).toBe(before);
    expect(await frames(file, true)).toBe(before);
    // A second pass finds nothing to do.
    expect(await removeHiddenLeadIn(file)).toBe(0);
  }, 60_000);

  it.each(['picture.mp4', 'picture-b.mp4'])('leaves a file with nothing hidden as it is (%s)', async (pictureFile) => {
    const file = path.join(dir, `clean-${pictureFile}`);
    await run('ffmpeg', [...quiet, '-i', path.join(dir, pictureFile), '-i', path.join(dir, 'sound.mp4'), '-map', '0:v', '-map', '1:a', '-c', 'copy', '-t', '6', file]);
    const before = await stat(file);
    expect(await removeHiddenLeadIn(file)).toBe(0);
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
  }, 60_000);

  it('handles a part with no sound', async () => {
    const file = path.join(dir, 'silent.mp4');
    await run('ffmpeg', [...quiet, '-ss', '6', '-t', '6', '-i', path.join(dir, 'picture.mp4'), '-c', 'copy', file]);
    expect(await removeHiddenLeadIn(file)).toBeCloseTo(1, 2);
    expect((await signals(file, true, false)).flash).toBeCloseTo(2, 2);
    expect((await signals(file, false, false)).flash).toBeCloseTo(2, 2);
  }, 60_000);
});
