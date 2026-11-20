// Fetching part of a video, with a stand-in for the downloader. These tests
// never reach YouTube.
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDescription } from '../src/compilation/description.js';
import { fetchVideo, leadInOf, removeHiddenLeadIn, videoUrl } from '../src/fetch.js';
import { run } from '../src/run.js';
import { channelAddress, checkPictureUrl, creditPictures, fetchPicture, fetchPictures, listPictures, listSubscribers, PICTURE_PIXELS, pictureFile, removeOtherPictures, syncSource } from '../src/pictures.js';
import { checkLive } from '../src/live.js';
import { agreedSourceOf, channelKey, creditLinks, parseSources, readSources, removeSource, saveSources, setSourceClubs } from '../src/sources.js';

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
    // A channel is added only once it has agreed, so an entry with no status is one that can be fetched from.
    expect(parseSources([{ id: 'x', name: 'X', url: 'https://www.youtube.com/@x' }])).toEqual([{ id: 'x', name: 'X', url: 'https://www.youtube.com/@x', status: 'agreed', note: '', clubs: [] }]);

    // The clubs a streamer supports: up to three names, each once.
    const withClubs = (clubs) => parseSources([{ id: 'x', name: 'X', url: 'https://www.youtube.com/@x', clubs }])[0].clubs;
    expect(withClubs(['Barcelona', ' Arsenal ', 'Barcelona'])).toEqual(['Barcelona', 'Arsenal']);
    expect(withClubs(['A', 'B', 'C'])).toEqual(['A', 'B', 'C']);
    expect(() => withClubs(['A', 'B', 'C', 'D'])).toThrow(/at most 3 clubs/);
    expect(() => withClubs([''])).toThrow(/not valid/);
    expect(() => withClubs('Barcelona')).toThrow(/not valid/);
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
      await expect(ask({ downloader: downloader(video) })).rejects.toThrow(new RegExp(`from "${video.channel}", which is not in your sources list`));
    }
    await expect(ask({ sources: [] })).rejects.toThrow(/not in your sources list/);
    expect(calls.length).toBe(before);
  });

  it('refuses a stream that is still live, has not started, or has only just ended, and downloads nothing', async () => {
    // A live stream cannot be cut: the downloader would record it as it happens and never stop.
    const before = calls.length;
    await expect(ask({ downloader: downloader({ live: 'is_live', duration: 0 }) })).rejects.toThrow(/live right now.*Wait until the stream has ended/);
    await expect(ask({ downloader: downloader({ live: 'is_upcoming', duration: 0 }) })).rejects.toThrow(/has not started yet/);
    await expect(ask({ downloader: downloader({ live: 'post_live' }) })).rejects.toThrow(/only just ended/);
    expect(calls.length).toBe(before);
    // A stream that ended and is an ordinary video now is fetched like any other.
    const done = await ask({ downloader: downloader({ live: 'was_live' }), start: 300, end: 330 });
    expect(done.name).toBe('northstand_dQw4w9WgXcQ_5m00s-5m30s.mp4');
  });

  it('leaves nothing behind when the download fails or is stopped', async () => {
    const failing = { ...downloader(), download: async (job) => {
      // What a stopped download leaves: a half-written file and the downloader's own notes.
      await writeFile(path.join(job.dir, `${job.name}.mp4.part`), 'half a video');
      await writeFile(path.join(job.dir, `${job.name}.f312.mp4.ytdl`), 'notes');
      throw new Error('The download failed. Try again.');
    } };
    await writeFile(path.join(dir, 'northstand_other.mp4.part'), 'someone else\'s');
    await expect(ask({ downloader: failing, start: 600, end: 615 })).rejects.toThrow(/The download failed/);
    expect((await readdir(dir)).filter((name) => name.includes('10m00s'))).toEqual([]);
    expect(await readdir(dir)).toContain('northstand_other.mp4.part'); // only this fetch's own pieces are removed
    await rm(path.join(dir, 'northstand_other.mp4.part'));
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

// The profile pictures of channels in the list. A stand-in answers for
// YouTube and another for the picture itself, so nothing here leaves the machine.
describe('channel pictures', () => {
  let dir;
  let picture;
  const asked = [];
  const northstand = sources[0];
  const kopend = sources[1];
  const youtube = (answer = {}) => ({
    channel: async (url) => {
      asked.push(url);
      return { name: 'Northstand', channelId: 'UCxxx', handle: '@NorthStandTV', pictureUrl: 'https://yt3.googleusercontent.com/made-up-picture=s900', ...answer };
    },
  });
  const download = async () => picture;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'clipper-pictures-'));
    const file = path.join(dir, 'wide.jpg');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=900x600', '-frames:v', '1', file]);
    picture = await (await import('node:fs/promises')).readFile(file);
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('asks about the channel by an address rebuilt from the list, never as typed', () => {
    expect(channelAddress({ name: 'X', url: 'https://www.youtube.com/@NorthStandTV/' })).toBe('https://www.youtube.com/@northstandtv');
    expect(channelAddress(kopend)).toBe('https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa');
    expect(() => channelAddress({ name: 'X', url: 'https://example.com/@x' })).toThrow(/no channel address/);
  });

  it('takes a picture only from where YouTube serves channel pictures', () => {
    expect(checkPictureUrl('https://yt3.googleusercontent.com/abc=s900')).toBe('https://yt3.googleusercontent.com/abc=s900');
    expect(checkPictureUrl('https://yt3.ggpht.com/abc')).toBe('https://yt3.ggpht.com/abc');
    for (const bad of ['http://yt3.googleusercontent.com/abc', 'https://example.com/a.png', 'https://yt3.googleusercontent.com.example.com/a', 'https://user@yt3.ggpht.com/a', 'https://yt3.ggpht.com:8443/a', 'file:///etc/passwd', '', undefined]) {
      expect(() => checkPictureUrl(bad), String(bad)).toThrow(/picture/);
    }
  });

  it('keeps a round picture of fixed size, made here from what came', async () => {
    const file = await fetchPicture({ source: northstand, dataDir: dir, downloader: youtube(), download });
    expect(file).toBe(pictureFile(dir, 'northstand'));
    expect(asked.at(-1)).toBe('https://www.youtube.com/@northstandtv');
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,pix_fmt', '-of', 'csv=p=0', file]);
    expect(stdout.trim()).toBe(`png,${PICTURE_PIXELS},${PICTURE_PIXELS},rgba`);
    // Round: a corner is clear and the middle is not.
    const alpha = async (x, y) => {
      const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', file, '-vf', `crop=2:2:${x}:${y},alphaextract,signalstats,metadata=print:key=lavfi.signalstats.YAVG`, '-f', 'null', '-']);
      return Number(/YAVG=([\d.]+)/.exec(stderr)[1]);
    };
    expect(await alpha(2, 2)).toBeLessThan(20);
    expect(await alpha(PICTURE_PIXELS / 2, PICTURE_PIXELS / 2)).toBeGreaterThan(230);
    // Nothing else is left in the folder: not the bytes that came, nor anything half made.
    expect(await readdir(path.dirname(file))).toEqual(['northstand.png']);
  });

  it('refuses a picture from another channel, a bad address, or something that is no picture', async () => {
    const attempt = (options) => fetchPicture({ source: northstand, dataDir: dir, downloader: youtube(), download, ...options });
    await expect(attempt({ downloader: youtube({ name: 'Somebody Else', handle: '@somebody', channelId: 'UCqqq' }) })).rejects.toThrow(/leads to another channel, "Somebody Else"/);
    await expect(attempt({ downloader: youtube({ pictureUrl: 'https://example.com/a.png' }) })).rejects.toThrow(/not at an address this tool takes pictures from/);
    await expect(attempt({ downloader: youtube({ pictureUrl: '' }) })).rejects.toThrow(/gave no picture/);
    await expect(attempt({ download: async () => Buffer.from('<html>not a picture</html>') })).rejects.toThrow(/not a picture that can be read/);
    // A channel that has not agreed is not asked about at all.
    const before = asked.length;
    await expect(attempt({ source: sources[2] })).rejects.toThrow(/not a channel that has agreed/);
    expect(asked.length).toBe(before);
    // The picture fetched earlier is still there and whole.
    expect(await readdir(path.join(dir, 'source-pictures'))).toEqual(['northstand.png']);
  });

  it('fetches for every channel that has agreed, and says which could not be fetched', async () => {
    const byChannel = { channel: async (url) => (url.includes('@northstandtv')
      ? { name: 'Northstand', channelId: 'UCxxx', handle: '@northstandtv', pictureUrl: 'https://yt3.ggpht.com/a' }
      : { name: 'Kopend', channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa', handle: '@kopend', pictureUrl: '' }) };
    const steps = [];
    const result = await fetchPictures({ sources, dataDir: dir, downloader: byChannel, download, onStep: (step, detail) => steps.push(detail.name) });
    expect(result).toEqual({ fetched: ['Northstand'], failed: [{ name: 'Kopend', error: 'YouTube gave no picture for this channel.' }] });
    expect(steps).toEqual(['Northstand', 'Kopend']); // the two that have agreed, and neither of the others

    expect(Object.keys(await listPictures(dir, sources))).toEqual(['northstand']);
    // For credits, by the name in lower case, and only for channels that have agreed.
    expect(await creditPictures(dir, sources)).toEqual({ northstand: pictureFile(dir, 'northstand') });
    // A channel taken out of the list takes its picture with it.
    await removeOtherPictures(dir, sources.slice(1));
    expect(await readdir(path.join(dir, 'source-pictures'))).toEqual([]);
  });

  it('keeps the subscriber count YouTube gave, with when it was read, and drops it with the channel', async () => {
    const data = path.join(dir, 'counts');
    await fetchPicture({ source: northstand, dataDir: data, downloader: youtube({ subscribers: 18000 }), download });
    const counts = await listSubscribers(data, sources);
    expect(Object.keys(counts)).toEqual(['northstand']);
    expect(counts.northstand.count).toBe(18000);
    expect(Math.abs(Date.now() - Date.parse(counts.northstand.checked))).toBeLessThan(60_000);

    // A channel that hides its count, or nonsense in its place, leaves the last known count as it is.
    for (const subscribers of [null, undefined, -5, 12.5, 'many']) {
      await fetchPicture({ source: northstand, dataDir: data, downloader: youtube({ subscribers }), download });
      expect((await listSubscribers(data, sources)).northstand.count).toBe(18000);
    }
    await fetchPicture({ source: northstand, dataDir: data, downloader: youtube({ subscribers: 18400 }), download });
    expect((await listSubscribers(data, sources)).northstand.count).toBe(18400);
    // The count is kept even when the picture cannot be had.
    await expect(fetchPicture({ source: northstand, dataDir: data, downloader: youtube({ subscribers: 19000, pictureUrl: '' }), download })).rejects.toThrow(/gave no picture/);
    expect((await listSubscribers(data, sources)).northstand.count).toBe(19000);
    // Nothing is kept for a channel that turned out to be another one.
    await expect(fetchPicture({ source: kopend, dataDir: data, downloader: youtube({ subscribers: 5 }), download })).rejects.toThrow(/leads to another channel/);
    expect(Object.keys(await listSubscribers(data, sources))).toEqual(['northstand']);

    // Only channels in the list are answered for, and a removed channel's count goes with its picture.
    expect(await listSubscribers(data, sources.slice(1))).toEqual({});
    await removeOtherPictures(data, sources.slice(1));
    expect(await listSubscribers(data, sources)).toEqual({});
    // A file that cannot be read is no counts at all, not an error.
    await writeFile(path.join(data, 'source-subscribers.json'), 'not json');
    expect(await listSubscribers(data, sources)).toEqual({});
  });

  // "Sync" on a row: the owner pastes an address and the rest is filled in.
  it('fills a channel in from its address: the name when none was typed, the picture, and a place in the saved list', async () => {
    const data = path.join(dir, 'sync');
    const calls = asked.length;
    const sync = (source, answer) => syncSource({ source, dataDir: data, downloader: youtube(answer), download });

    const added = await sync({ id: 'snew', url: ' https://www.youtube.com/@NorthStandTV ', name: '' }, { name: 'North\n Stand  TV\u0007' });
    expect(added).toEqual({ source: { id: 'snew', name: 'North Stand TV', url: 'https://www.youtube.com/@NorthStandTV', status: 'agreed', note: '', clubs: [] }, named: true, picture: true, pictureError: '' });
    expect(await readSources(data)).toEqual([added.source]);
    expect(await readdir(path.join(data, 'source-pictures'))).toEqual(['snew.png']);
    expect(asked.length).toBe(calls + 1); // YouTube was asked once for both the name and the picture

    // A name the owner typed is kept, and the note written earlier stays, and so do the clubs marked on the channel.
    await saveSources(data, [{ ...added.source, note: 'Said yes by email', clubs: ['Barcelona'] }]);
    const kept = await sync({ id: 'snew', url: 'https://www.youtube.com/@northstandtv', name: 'Northstand' }, { name: 'Another Name' });
    expect(kept).toMatchObject({ source: { name: 'Northstand', note: 'Said yes by email', clubs: ['Barcelona'] }, named: false, picture: true });
    // Clubs chosen on the row and not yet saved come along with the sync; too many are refused, and nothing is saved.
    const chosen = await sync({ id: 'snew', url: 'https://www.youtube.com/@northstandtv', name: 'Northstand', clubs: ['Arsenal', 'Inter'] }, {});
    expect(chosen.source.clubs).toEqual(['Arsenal', 'Inter']);
    await expect(sync({ id: 'snew', url: 'https://www.youtube.com/@northstandtv', name: 'Northstand', clubs: ['A', 'B', 'C', 'D'] }, {})).rejects.toThrow(/at most 3 clubs/);
    expect((await readSources(data))[0].clubs).toEqual(['Arsenal', 'Inter']);
    expect(await readSources(data)).toHaveLength(1);

    // The channel is saved even when its picture cannot be had, and the reason is given.
    const bare = await sync({ id: 'kop', url: 'https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa' }, { name: 'Kopend', channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa', handle: '@kopend', pictureUrl: '' });
    expect(bare).toMatchObject({ source: { id: 'kop', name: 'Kopend' }, picture: false, pictureError: 'YouTube gave no picture for this channel.' });
    expect((await readSources(data)).map((source) => source.id)).toEqual(['snew', 'kop']);

    // Refused, with nothing saved: no address, a channel already in the list, another channel, no name, a bad id.
    const before = asked.length;
    await expect(sync({ id: 'x', url: 'https://example.com/@x' })).rejects.toThrow(/Give the channel address first/);
    await expect(sync({ id: 'x', url: 'https://www.youtube.com/@NORTHSTANDTV' })).rejects.toThrow(/already in your list, as "Northstand"/);
    expect(asked.length).toBe(before); // neither reached YouTube
    await expect(sync({ id: 'x', url: 'https://www.youtube.com/@someoneelse' })).rejects.toThrow(/leads to another channel, "Northstand"/);
    await expect(sync({ id: 'x', url: 'https://www.youtube.com/@someoneelse' }, { handle: '@someoneelse', name: ' \n ' })).rejects.toThrow(/gave no name/);
    await expect(sync({ id: '../x', url: 'https://www.youtube.com/@someoneelse' }, { handle: '@someoneelse', name: 'Someone' })).rejects.toThrow(/not valid/);
    expect((await readSources(data)).map((source) => source.id)).toEqual(['snew', 'kop']);
    expect((await readdir(path.join(data, 'source-pictures'))).sort()).toEqual(['snew.png']);
  });
});

// Which channels are live. A stand-in answers for YouTube.
describe('who is live', () => {
  const asked = [];
  const answers = {
    'https://www.youtube.com/@northstandtv': { live: true, videoId: 'dQw4w9WgXcQ', title: ' Barca v United\n LIVE\u0007 watchalong ', channelId: 'UCxxx', handle: '@NorthStandTV', viewers: 1234, started: 1795174296 },
    'https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa': { live: false },
  };
  const youtube = (changes = {}) => ({ live: async (url) => {
    asked.push(url);
    const answer = { ...answers, ...changes }[url];
    if (answer instanceof Error) throw answer;
    return answer;
  } });

  it('asks only about channels that have agreed, by an address rebuilt from the list', async () => {
    const found = await checkLive({ sources, downloader: youtube() });
    expect(asked.sort()).toEqual(['https://www.youtube.com/@northstandtv', 'https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa'].sort());
    expect(Object.keys(found).sort()).toEqual(['kopend', 'northstand']); // not the two that have not agreed
    expect(found.kopend).toEqual({ live: false });
    // What YouTube said is trimmed to one plain line, and the start time is given as a time.
    expect(found.northstand).toEqual({ live: true, videoId: 'dQw4w9WgXcQ', title: 'Barca v United LIVE watchalong', viewers: 1234, started: '2026-11-20T11:31:36.000Z' });
  });

  it('does not call a channel live on an answer that is another channel\'s, or has no usable video id', async () => {
    const address = 'https://www.youtube.com/@northstandtv';
    const other = await checkLive({ sources, downloader: youtube({ [address]: { ...answers[address], channelId: 'UCqqq', handle: '@somebody' } }) });
    expect(other.northstand).toEqual({ live: false });
    const odd = await checkLive({ sources, downloader: youtube({ [address]: { ...answers[address], videoId: '../../etc' } }) });
    expect(odd.northstand).toEqual({ live: false });
    // Numbers that are not numbers are left out, not passed on.
    const loose = await checkLive({ sources, downloader: youtube({ [address]: { ...answers[address], viewers: 'many', started: undefined } }) });
    expect(loose.northstand).toMatchObject({ live: true, viewers: null, started: null });
  });

  it('says "not known" for a channel that could not be checked, and still answers for the rest', async () => {
    const found = await checkLive({ sources, downloader: youtube({ 'https://www.youtube.com/@northstandtv': new Error('The channel could not be checked.') }) });
    expect(found).toEqual({ northstand: { live: null }, kopend: { live: false } });
    expect(await checkLive({ sources: [], downloader: youtube() })).toEqual({});
  });
});

// What the owner marks on a channel is saved for that channel alone, and every save keeps a copy of the list as it was.
describe('changing one channel, and the copies kept', () => {
  let dir;
  const list = () => readSources(dir).then((all) => Object.fromEntries(all.map((one) => [one.id, one.clubs])));
  const copies = () => readdir(path.join(dir, 'backups', 'sources')).then((names) => names.sort(), () => []);

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'clipper-one-channel-'));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('sets one channel\'s clubs and leaves every other channel as it is on disk', async () => {
    await saveSources(dir, sources);
    await setSourceClubs(dir, 'northstand', ['Barcelona']);
    await setSourceClubs(dir, 'kopend', ['Liverpool']);
    expect(await list()).toEqual({ northstand: ['Barcelona'], kopend: ['Liverpool'], terrace: [], dave: [] });
    // The case that loses work: a page still holding the list from before those two were set changes a third.
    // It reaches only the channel it names, so the first two keep their clubs.
    await setSourceClubs(dir, 'terrace', ['Arsenal']);
    expect(await list()).toEqual({ northstand: ['Barcelona'], kopend: ['Liverpool'], terrace: ['Arsenal'], dave: [] });
    await setSourceClubs(dir, 'northstand', []);
    expect((await list()).northstand).toEqual([]);

    await expect(setSourceClubs(dir, 'nobody', ['Arsenal'])).rejects.toThrow(/No such channel/);
    await expect(setSourceClubs(dir, 'kopend', ['A', 'B', 'C', 'D'])).rejects.toThrow(/at most 3 clubs/);
    await expect(setSourceClubs(dir, 'kopend', 'Liverpool')).rejects.toThrow(/not valid/);
    expect((await list()).kopend).toEqual(['Liverpool']); // a refused change changes nothing
  });

  it('removes one channel and leaves the others, with what was marked on them', async () => {
    await removeSource(dir, 'dave');
    expect(await list()).toEqual({ northstand: [], kopend: ['Liverpool'], terrace: ['Arsenal'] });
    await expect(removeSource(dir, 'dave')).rejects.toThrow(/No such channel/);
  });

  it('keeps a copy of the list as it was before each change, and can be gone back to', async () => {
    const kept = await copies();
    expect(kept.length).toBeGreaterThanOrEqual(5); // one for each change made above
    // The newest copy is the list just before the last change: "dave" is still in it.
    const last = JSON.parse(await readFile(path.join(dir, 'backups', 'sources', kept.at(-1)), 'utf8'));
    expect(last.map((one) => one.id)).toContain('dave');
    // A save that changes nothing keeps no copy.
    await saveSources(dir, await readSources(dir));
    expect(await copies()).toEqual(kept);
    // Even a whole list written over with nothing can be got back.
    await saveSources(dir, []);
    const before = JSON.parse(await readFile(path.join(dir, 'backups', 'sources', (await copies()).at(-1)), 'utf8'));
    expect(Object.fromEntries(before.map((one) => [one.id, one.clubs]))).toEqual({ northstand: [], kopend: ['Liverpool'], terrace: ['Arsenal'] });
  });

  it('keeps only the newest copies', async () => {
    for (let n = 0; n < 45; n++) await saveSources(dir, [{ id: 'x', name: `Name ${n}`, url: 'https://www.youtube.com/@x' }]);
    const kept = await copies();
    expect(kept).toHaveLength(40);
    expect(JSON.parse(await readFile(path.join(dir, 'backups', 'sources', kept.at(-1)), 'utf8'))[0].name).toBe('Name 43');
  });
});
