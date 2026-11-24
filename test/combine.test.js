// Combining two videos side by side, with the real ffmpeg: which video is on
// which side, which part of each shows, the frame the main video takes the
// whole screen, and picture and sound still in step afterwards.
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCombination } from '../src/combine/build.js';
import { combinedFile, combinedResult, deleteCombination, listCombinations, newCombinationId, parseCombination, readCombination, saveCombination } from '../src/combine/combination.js';
import { COMBINE_SIZES, halves, lineUp, rangeOf, shownPart, syncStart, timing } from '../src/combine/layout.js';
import { probe } from '../src/probe.js';
import { run } from '../src/run.js';

describe('the sums of a combined video', () => {
  const wide = COMBINE_SIZES.landscape;
  const tall = COMBINE_SIZES.portrait;

  it('splits a wide frame left and right, and a tall one top and bottom', () => {
    expect(halves(wide)).toEqual({ wide: true, left: { x: 0, y: 0, width: 960, height: 1080 }, right: { x: 960, y: 0, width: 960, height: 1080 } });
    expect(halves(tall)).toEqual({ wide: false, left: { x: 0, y: 0, width: 1080, height: 960 }, right: { x: 0, y: 960, width: 1080, height: 960 } });
  });

  it('gives the main video half, 60 or 70 percent of the split screen, on whichever side it is', () => {
    expect(halves(wide, 'left', 60)).toMatchObject({ left: { x: 0, width: 1152 }, right: { x: 1152, width: 768 } });
    expect(halves(wide, 'right', 70)).toMatchObject({ left: { x: 0, width: 576 }, right: { x: 576, width: 1344 } });
    expect(halves(tall, 'left', 70)).toMatchObject({ left: { y: 0, height: 1344, width: 1080 }, right: { y: 1344, height: 576 } });
    expect(halves(wide, 'right', 50)).toEqual(halves(wide));
    // A video covers whatever part it is given: a 16:9 one fills a 1344x1080 part at 1920x1080.
    expect(shownPart({ width: 1280, height: 720 }, halves(wide, 'left', 70).left)).toEqual({ width: 1920, height: 1080, x: 288, y: 0 });
  });

  it('makes a video cover its half and keeps the part asked for', () => {
    const half = halves(wide).left;
    const source = { width: 1280, height: 720 };
    // A 16:9 video covers a 960x1080 half at 1920x1080: half of its width shows.
    expect(shownPart(source, half)).toEqual({ width: 1920, height: 1080, x: 480, y: 0 });
    expect(shownPart(source, half, { x: 0 })).toMatchObject({ x: 0 });
    expect(shownPart(source, half, { x: 1 })).toMatchObject({ x: 960 });
    // Enlarged twice, it sticks out both ways, and both positions count.
    expect(shownPart(source, half, { zoom: 2, x: 0.25, y: 1 })).toEqual({ width: 3840, height: 2160, x: 720, y: 1080 });
    // A tall video in a wide half sticks out up and down instead.
    expect(shownPart({ width: 1080, height: 1920 }, half, { y: 0 })).toEqual({ width: 960, height: 1708, x: 0, y: 0 });
    // Nonsense is held to the nearest sensible value, and the result always covers the half.
    expect(shownPart(source, half, { zoom: 99, x: -3, y: Number.NaN })).toEqual({ width: 7680, height: 4320, x: 0, y: 0 });
    expect(shownPart({ width: 961, height: 1081 }, half).width).toBeGreaterThanOrEqual(960);
  });

  it('works out the main video\'s start from the two sync marks, and says when it cannot', () => {
    // A goal 12.4 s into its clip, the shout 225.2 s into the reaction: the reaction starts at 212.8, and they meet 12.4 s in.
    expect(syncStart({ start: 100, mark: 225.2 }, { start: null, mark: 12.4 })).toEqual({ start: 212.8, meet: 12.4 });
    // The other video's own start counts: from 2 s in, the goal is 10.4 s into the result.
    expect(syncStart({ mark: 225.2 }, { start: 2, mark: 12.4 })).toEqual({ start: 214.8, meet: 10.4 });
    // A mark missing on either: nothing to line up.
    expect(syncStart({ mark: 5 }, { mark: null })).toBeNull();
    expect(syncStart({ start: 3 }, { mark: 2 })).toBeNull();
    // Too little of the main video before its mark, or the other's mark before its start.
    expect(syncStart({ mark: 8 }, { mark: 12 })).toEqual({ problem: expect.stringMatching(/needs 4\.00 s more/) });
    expect(syncStart({ mark: 8 }, { start: 5, mark: 3 })).toEqual({ problem: expect.stringMatching(/before its start/) });
    // lineUp puts the worked-out start on the main video only, and leaves everything else.
    const lined = lineUp({ main: 'right', left: { name: 'goal', start: null, mark: 12.4 }, right: { name: 'react', start: 0, end: 300, mark: 225.2 } });
    expect(lined.right).toEqual({ name: 'react', start: 212.8, end: 300, mark: 225.2 });
    expect(lined.left).toEqual({ name: 'goal', start: null, mark: 12.4 });
    expect(lineUp({ main: 'left', left: { start: 4 }, right: { start: 1 } })).toEqual({ left: { start: 4 }, right: { start: 1 }, sync: null });
  });

  it('holds a part to what the file has, and counts lengths in whole frames', () => {
    expect(rangeOf({ start: null, end: null }, 10)).toEqual({ start: 0, seconds: 10 });
    expect(rangeOf({ start: 2, end: 30 }, 10)).toEqual({ start: 2, seconds: 8 });
    expect(rangeOf({ start: 12, end: 3 }, 10)).toEqual({ start: 10, seconds: 0 });
    // The screen is split for as long as the other video runs, and never longer than the whole.
    expect(timing(10.01, 5.02)).toEqual({ seconds: 10, split: 5 + 1 / 30 });
    expect(timing(3, 8)).toEqual({ seconds: 3, split: 3 });
  });
});

describe('a saved combination', () => {
  let dir;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'clipper-combination-'));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('fills in what is left out, and refuses what it does not know', () => {
    const bare = parseCombination({ id: 'a', name: ' Goal ', left: { library: 'in', name: 'a.mp4' } });
    expect(bare).toEqual({
      id: 'a', name: 'Goal', preset: 'landscape', main: 'left', mainShare: 50, sound: 'low', right: null,
      left: { library: 'in', name: 'a.mp4', start: null, end: null, mark: null, zoom: 1, x: 0.5, y: 0.5 },
    });
    // A combination saved before sync marks existed loads with none.
    expect(parseCombination({ id: 'a', name: 'x', left: { library: 'in', name: 'a.mp4', start: 3, end: null, zoom: 1, x: 0.5, y: 0.5 } }).left.mark).toBeNull();
    expect(() => parseCombination({ id: 'a', name: 'x', delay: 2 })).toThrow(/not valid/);
    expect(() => parseCombination({ id: 'a', name: 'x', left: { library: 'etc', name: 'passwd' } })).toThrow(/not valid/);
    expect(() => parseCombination({ id: 'a', name: 'x', left: { library: 'in', name: 'a.mp4', zoom: 9 } })).toThrow(/not valid/);
    expect(() => parseCombination({ id: '../a', name: 'x' })).toThrow(/not valid/);
    expect(parseCombination({ id: 'a', name: 'x', mainShare: 70 }).mainShare).toBe(70);
    expect(() => parseCombination({ id: 'a', name: 'x', mainShare: 55 })).toThrow(/50, 60 or 70 percent/);
  });

  it('is saved, listed by name, and deleted with everything made from it', async () => {
    expect(await listCombinations(dir)).toEqual([]);
    const id = await newCombinationId(dir, 'Goal: Yamal!');
    expect(id).toBe('goal-yamal');
    await saveCombination(dir, { id, name: 'Goal: Yamal!' });
    expect(await newCombinationId(dir, 'Goal: Yamal!')).toBe('goal-yamal-2');
    await saveCombination(dir, { id: 'another', name: 'Another' });
    expect((await listCombinations(dir)).map((one) => one.id)).toEqual(['another', 'goal-yamal']);
    expect(await combinedResult(dir, await readCombination(dir, id))).toBeNull(); // nothing generated yet

    await deleteCombination(dir, id);
    expect(await readdir(path.join(dir, 'combinations'))).toEqual(['another']);
    await expect(deleteCombination(dir, id)).rejects.toThrow(/No such combination/);
    await expect(readCombination(dir, '../another')).rejects.toThrow(/No such combination/);
  });
});

describe('making a combined video', () => {
  let dir;
  let dataDir;
  const ff = (args) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  const video = (name) => path.join(dir, 'videos', name);
  // Given relative to where the tests run, as a caller might: the engine must still find the files.
  const resolveVideo = async (library, name) => path.relative(process.cwd(), video(name));

  // A black video with a white flash and a beep 1.5 s in: the reaction.
  const flash = { library: 'in', name: 'flash.mp4', start: 0.5, end: 3.5 };
  // Red on its left half and blue on its right, with a tone: the thing reacted to.
  const colours = { library: 'in', name: 'colours.mp4', start: 0, end: 1 };
  const combination = (changes = {}) => parseCombination({ id: 'made', name: 'Made', left: colours, right: flash, main: 'right', ...changes });
  const make = async (changes) => {
    const saved = await saveCombination(dataDir, combination(changes));
    return { saved, ...(await buildCombination({ combination: saved, dataDir, resolveVideo })) };
  };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'clipper-combine-'));
    dataDir = path.join(dir, 'data');
    await mkdir(path.join(dir, 'videos'));
    const encode = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'];
    await ff(['-f', 'lavfi', '-i', "color=c=black:s=1280x720:r=30,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='between(t,1.5,1.62)'", '-f', 'lavfi', '-i', "aevalsrc='if(between(t,1.5,1.6),sin(2*PI*1000*t),0)':s=48000", '-t', '4', ...encode, '-c:a', 'aac', video('flash.mp4')]);
    await ff(['-f', 'lavfi', '-i', 'color=c=red:s=640x720:r=60', '-f', 'lavfi', '-i', 'color=c=blue:s=640x720:r=60', '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=44100', '-filter_complex', '[0:v][1:v]hstack=inputs=2[v]', '-map', '[v]', '-map', '2:a', '-t', '3', ...encode, '-c:a', 'aac', video('colours.mp4')]);
    await ff(['-f', 'lavfi', '-i', 'color=c=green:s=640x480:r=25', '-t', '2', ...encode, video('quiet.mp4')]);
  }, 60_000);
  afterAll(() => rm(dir, { recursive: true, force: true }));

  /** Average of one colour channel (U is high for blue, V for red; both are 128 for black, white and grey) in part of a frame. */
  async function colour(file, frame, part, channel) {
    const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', file, '-an', '-vf', `select='eq(n,${frame})',crop=${part},signalstats,metadata=print:key=lavfi.signalstats.${channel}AVG`, '-frames:v', '1', '-f', 'null', '-']);
    return Number(new RegExp(`${channel}AVG=([\\d.]+)`).exec(stderr)[1]);
  }
  const red = (file, frame, part) => colour(file, frame, part, 'V');
  const blue = (file, frame, part) => colour(file, frame, part, 'U');
  const LEFT = 'iw/2:ih:0:0';
  const RIGHT = 'iw/2:ih:iw/2:0';
  const TOP = 'iw:ih/2:0:0';
  const BOTTOM = 'iw:ih/2:0:ih/2';

  async function flashAt(file) {
    const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', file, '-an', '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-']);
    let time = null;
    for (const line of stderr.split('\n')) {
      const pts = /pts_time:([\d.]+)/.exec(line);
      if (pts) time = Number(pts[1]);
      const level = /YAVG=([\d.]+)/.exec(line);
      if (level && Number(level[1]) > 150) return time;
    }
    return null;
  }
  async function beepAt(file) {
    const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', file, '-vn', '-af', 'highpass=f=700,silencedetect=n=-35dB:d=0.05', '-f', 'null', '-']);
    return [...stderr.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]))[0] ?? null;
  }
  async function level(file, from, seconds) {
    const { stderr } = await run('ffmpeg', ['-hide_banner', '-ss', String(from), '-t', String(seconds), '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
    return Number(/mean_volume: (-?[\d.]+) dB/.exec(stderr)[1]);
  }

  it('shows both videos side by side, then the main one alone from the frame the other ends', async () => {
    const built = await make();
    expect(built.file).toBe(combinedFile(dataDir, 'made'));
    expect([built.seconds, built.split]).toEqual([3, 1]);
    const info = await probe(built.file);
    expect([info.width, info.height, info.fps, info.audioStreams]).toEqual([1920, 1080, 30, 1]);
    expect(Math.abs(info.duration - 3)).toBeLessThan(0.05);

    // While split: the middle of the other video on the left (red meets blue there), the main one (black) on the right.
    expect(await red(built.file, 10, 'iw/4:ih:0:0')).toBeGreaterThan(200);
    expect(await blue(built.file, 10, 'iw/4:ih:iw/4:0')).toBeGreaterThan(200);
    expect(Math.abs((await red(built.file, 10, RIGHT)) - 128)).toBeLessThan(6);
    // To the frame: the last split frame is 29, and from frame 30 the main video has the whole screen.
    expect(await red(built.file, 29, 'iw/4:ih:0:0')).toBeGreaterThan(200);
    expect(Math.abs((await red(built.file, 30, LEFT)) - 128)).toBeLessThan(6);
    expect(Math.abs((await blue(built.file, 30, LEFT)) - 128)).toBeLessThan(6);

    // The main video's flash and beep, 1.5 s into its file, are 1.0 s into the result and still together.
    const seen = await flashAt(built.file);
    expect(Math.abs(seen - 1)).toBeLessThan(1 / 30 + 0.005);
    expect(Math.abs(seen - (await beepAt(built.file)))).toBeLessThan(1 / 30 + 0.01);

    // What was made is remembered, so a change to the settings can be told from a change of name.
    expect(await combinedResult(dataDir, built.saved)).toMatchObject({ changedSince: false });
    expect(await combinedResult(dataDir, { ...built.saved, name: 'Another name' })).toMatchObject({ changedSince: false });
    expect(await combinedResult(dataDir, combination({ sound: 'off' }))).toMatchObject({ changedSince: true });
    expect((await readdir(path.join(dataDir, 'combinations', 'made'))).sort()).toEqual(['combination.json', 'combined.mp4', 'made-from.json']);
  }, 240_000);

  it('lines the two videos up at their sync marks: both marked moments on the same frame', async () => {
    // The thing reacted to: a flash 0.8 s into a 2-second file. The reaction: flash.mp4, its flash 1.5 s in.
    const goal = path.join(dir, 'videos', 'goal.mp4');
    await ff(['-f', 'lavfi', '-i', "color=c=black:s=1280x720:r=30,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='between(t,0.8,0.92)'", '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', goal]);
    // The main video's own start (0.5) is overruled by the marks: it starts at 1.5 - 0.8 = 0.7.
    const built = await make({ left: { library: 'in', name: 'goal.mp4', start: null, end: null, mark: 0.8 }, right: { ...flash, mark: 1.5 } });
    // The goal clip plays whole (2 s), then the reaction runs on to its end (4 - 0.7 = 3.3 s; its saved end, 3.5, gives 2.8).
    expect(built.split).toBe(2);
    expect(Math.abs(built.seconds - 2.8)).toBeLessThan(0.05);
    // Each half flashes at 0.8 s into the result, on the same frame.
    const flashIn = async (crop) => {
      const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', built.file, '-an', '-vf', `crop=${crop},signalstats,metadata=print:key=lavfi.signalstats.YAVG`, '-f', 'null', '-']);
      let time = null;
      for (const line of stderr.split('\n')) {
        const pts = /pts_time:([\d.]+)/.exec(line);
        if (pts) time = Number(pts[1]);
        const lit = /YAVG=([\d.]+)/.exec(line);
        if (lit && Number(lit[1]) > 150) return time;
      }
      return null;
    };
    const [left, right] = [await flashIn(LEFT), await flashIn(RIGHT)];
    expect(Math.abs(left - 0.8)).toBeLessThan(1 / 30 + 0.005);
    expect(Math.abs(right - left)).toBeLessThan(0.001);
    // The reaction's sound is still with its picture.
    expect(Math.abs((await beepAt(built.file)) - right)).toBeLessThan(1 / 30 + 0.01);
  }, 240_000);

  it('says so, before making anything, when the main video has too little before its mark', async () => {
    // The reaction's flash is 1.5 s in; a goal marked 2 s after its start would need the reaction to start 0.5 s before its file does.
    await expect(make({ left: { library: 'in', name: 'colours.mp4', start: 0, end: null, mark: 2 }, right: { ...flash, mark: 1.5 } }))
      .rejects.toThrow(/needs 0\.50 s more before its sync mark/);
  });

  it('shows the part of a video that was asked for, and puts the main video on the side asked for', async () => {
    const leftEdge = await make({ left: { ...colours, x: 0 } });
    expect(await red(leftEdge.file, 10, LEFT)).toBeGreaterThan(200);
    const rightEdge = await make({ left: { ...colours, x: 1 } });
    expect(await blue(rightEdge.file, 10, LEFT)).toBeGreaterThan(200);
    // Enlarged twice and held to the top left, only the red half is in view.
    const zoomed = await make({ left: { ...colours, zoom: 2, x: 0, y: 0 } });
    expect(await red(zoomed.file, 10, LEFT)).toBeGreaterThan(200);

    // The same two videos the other way round: the main one on the left, the colours on the right.
    const swapped = await make({ left: flash, right: { ...colours, x: 0 }, main: 'left' });
    expect(Math.abs((await red(swapped.file, 10, LEFT)) - 128)).toBeLessThan(6);
    expect(await red(swapped.file, 10, RIGHT)).toBeGreaterThan(200);
    expect([swapped.seconds, swapped.split]).toEqual([3, 1]);
    // And with the colours as the main video: it sets the length, and stays when the other has ended.
    const other = await make({ left: { ...colours, start: 0, end: 3, x: 0 }, right: { ...flash, start: 0, end: 2 }, main: 'left' });
    expect([other.seconds, other.split]).toEqual([3, 2]);
    expect(await red(other.file, 75, 'iw/4:ih:iw/8:0')).toBeGreaterThan(200); // whole screen: red on the left half of the frame
    expect(await blue(other.file, 75, 'iw/4:ih:5*iw/8:0')).toBeGreaterThan(200);
  }, 240_000);

  it('gives the main video the larger part when asked, and still switches on the same frame', async () => {
    // The main video (black) on the right with 70 percent: the colours have the left 576 of 1920 pixels.
    const built = await make({ left: { ...colours, x: 0 }, mainShare: 70 });
    expect(await red(built.file, 10, '500:ih:30:0')).toBeGreaterThan(200); // inside the other video's part
    expect(Math.abs((await red(built.file, 10, '1300:ih:600:0')) - 128)).toBeLessThan(6); // the main video's part
    expect(Math.abs((await red(built.file, 30, '500:ih:30:0')) - 128)).toBeLessThan(6); // whole screen from frame 30
    const info = await probe(built.file);
    expect([info.width, info.height]).toEqual([1920, 1080]);
    // A video made before this choice existed is not marked as changed: the missing setting is its default.
    await writeFile(path.join(dataDir, 'combinations', 'made', 'made-from.json'), JSON.stringify({ ...combination({ left: { ...colours, x: 0 } }), name: undefined, mainShare: undefined }));
    expect(await combinedResult(dataDir, combination({ left: { ...colours, x: 0 } }))).toMatchObject({ changedSince: false });
    expect(await combinedResult(dataDir, built.saved)).toMatchObject({ changedSince: true });
  }, 240_000);

  it('splits a tall video top and bottom', async () => {
    const tall = await make({ preset: 'portrait', left: { ...colours, x: 0 } });
    const info = await probe(tall.file);
    expect([info.width, info.height]).toEqual([1080, 1920]);
    expect(await red(tall.file, 10, TOP)).toBeGreaterThan(200); // "left" is the top
    expect(Math.abs((await red(tall.file, 10, BOTTOM)) - 128)).toBeLessThan(6);
  }, 240_000);

  it('mixes the sound as asked, and gives a video with no sound a silent track', async () => {
    // The tone of the other video is heard while the screen is split and gone after.
    // Each is measured before the next is made: they are the same combination, so the same file.
    const even = await make({ sound: 'even' });
    const evenLevel = await level(even.file, 0.2, 0.6);
    expect(await level(even.file, 2.2, 0.6)).toBeLessThan(-60); // after the split only the main video, silent there
    const low = await make({ sound: 'low' });
    const lower = evenLevel - (await level(low.file, 0.2, 0.6));
    expect(lower).toBeGreaterThan(5); // "low" is clearly under "even"
    expect(lower).toBeLessThan(11);
    const off = await make({ sound: 'off' });
    expect(await level(off.file, 0.2, 0.6)).toBeLessThan(-60);

    const quiet = { library: 'in', name: 'quiet.mp4' };
    const silent = await make({ left: quiet, right: { ...quiet, end: 1 }, main: 'left' });
    expect((await probe(silent.file)).audioStreams).toBe(1);
    expect(await level(silent.file, 0, 2)).toBeLessThan(-80);
    // A silent main video still carries the other's sound.
    const carried = await make({ left: quiet, right: colours, main: 'left', sound: 'even' });
    expect(await level(carried.file, 0.2, 0.6)).toBeGreaterThan(-40);
  }, 300_000);

  it('says what is missing before making anything', async () => {
    const attempt = (changes) => buildCombination({ combination: combination({ id: 'bad', ...changes }), dataDir, resolveVideo });
    await expect(attempt({ right: null })).rejects.toThrow(/Choose the video for the right side first/);
    await expect(attempt({ right: { ...flash, start: 3.9, end: 4 } })).rejects.toThrow(/main video's part is shorter than half a second/);
    await expect(attempt({ left: { ...colours, start: 3, end: 3 } })).rejects.toThrow(/other video's part is empty/);
    await expect(attempt({ left: { library: 'in', name: 'missing.mp4' } })).rejects.toThrow(/Cannot read/);
    expect(await readdir(path.join(dataDir, 'combinations'))).toEqual(['made']); // the failed ones left nothing
  });
});
