// The compilation builder, with the real ffmpeg. These are the request's
// acceptance checks: unlike clips and cards joined into one file that plays
// in sync, at the right length, with a description beside it.
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveCardPng, saveMatch } from '../src/cards/match.js';
import { buildCompilation, creditLayout, creditSubtitles } from '../src/compilation/build.js';
import { buildDescription, cardTitle, chapterTime } from '../src/compilation/description.js';
import { automaticSounds, BUILT_IN, builtInSoundFile, DEFAULT_SOUND, isSoundChoice, listSoundFiles, soundInfo, soundSeconds } from '../src/compilation/sounds.js';
import { deleteCompilation, listCompilations, newCompilationId, parseTimeline, readTimeline, saveTimeline } from '../src/compilation/timeline.js';
import { probe } from '../src/probe.js';
import { run } from '../src/run.js';

let dir;
let dataDir;
const ff = (args) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const video = (name) => path.join(dir, 'videos', name);
// Given relative to where the tests run, as a caller might: the engine must still find the files.
const resolveVideo = async (library, name) => path.relative(process.cwd(), video(name));

const match = {
  id: 'm1', home: 'FC Barcelona', away: 'Manchester United', competition: '', date: '', colours: { home: '#a50044', away: '#da291c' },
  cards: [
    { id: 'goal', type: 'goal', team: 'home', scorer: 'Lewandowski', assist: '', minute: 12, added: null, goalType: 'penalty', homeScore: 1, awayScore: 0 },
    { id: 'full', type: 'fulltime', homeScore: 1, awayScore: 0, homeScorers: [], awayScorers: [] },
  ],
};

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'clipper-compilation-'));
  dataDir = path.join(dir, 'data');
  await mkdir(path.join(dir, 'videos'));
  // Three clips of different size and frame rate. The second has no sound.
  // The third is tall, an MKV, and has a white flash and a beep 1.5 s in.
  await ff(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=60', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video('a.mp4')]);
  await ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=25', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', video('b.mp4')]);
  await ff(['-f', 'lavfi', '-i', "color=c=black:s=1080x1920:r=24,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='between(t,1.5,1.62)'", '-f', 'lavfi', '-i', "aevalsrc='if(between(t,1.5,1.6),sin(2*PI*1000*t),0)':s=48000", '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video('c.mkv')]);

  await saveMatch(dataDir, match);
  for (const [size, shape] of [['landscape', '1920x1080'], ['portrait', '1080x1920']]) {
    const png = path.join(dir, `${size}.png`);
    await ff(['-f', 'lavfi', '-i', `color=c=navy:s=${shape}`, '-frames:v', '1', png]);
    for (const card of match.cards) await saveCardPng(dataDir, 'm1', card.id, size, await readFile(png));
  }
}, 120_000);

afterAll(() => rm(dir, { recursive: true, force: true }));

/** Time of the first frame brighter than the picture started out, after `from`. */
async function flashAt(file, from) {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', file, '-an', '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-']);
  let time = null;
  for (const line of stderr.split('\n')) {
    const pts = /pts_time:([\d.]+)/.exec(line);
    if (pts) time = Number(pts[1]);
    const level = /YAVG=([\d.]+)/.exec(line);
    // The tall clip is boxed inside the wide frame, so a white flash lifts the average only part of the way.
    if (level && time > from && Number(level[1]) > 60) return time;
  }
  return null;
}

async function soundAt(file, from) {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', file, '-vn', '-af', 'silencedetect=n=-35dB:d=0.05', '-f', 'null', '-']);
  return [...stderr.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1])).find((t) => t > from) ?? null;
}

/** How loud a stretch of a file is, in dB. Digital silence is about -91. */
async function level(file, from, seconds) {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-ss', String(from), '-t', String(seconds), '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
  return Number(/mean_volume: (-?[\d.]+) dB/.exec(stderr)[1]);
}

/**
 * How red a part of one frame is: about 240 for pure red, 128 for anything grey, black or white.
 * `frame` is the frame's number from 0, and `part` an ffmpeg crop such as "iw/2:ih:iw/2:0".
 */
async function redness(file, frame, part) {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', file, '-an', '-vf', `select='eq(n,${frame})',crop=${part},signalstats,metadata=print:key=lavfi.signalstats.VAVG`, '-frames:v', '1', '-f', 'null', '-']);
  return Number(/VAVG=([\d.]+)/.exec(stderr)[1]);
}
const LEFT = 'iw/2:ih:0:0';
const RIGHT = 'iw/2:ih:iw/2:0';
const TOP = 'iw:ih/2:0:0';
const BOTTOM = 'iw:ih/2:0:ih/2';

const timeline = (changes = {}) => parseTimeline({
  id: 'goals', name: 'Goal reactions', preset: 'landscape',
  items: [
    { id: 'i1', kind: 'card', matchId: 'm1', cardId: 'goal', seconds: 3 },
    { id: 'i2', kind: 'video', library: 'in', name: 'a.mp4', credit: 'StreamerOne' },
    { id: 'i3', kind: 'video', library: 'in', name: 'b.mp4', credit: 'Streamer Two' },
    { id: 'i4', kind: 'card', matchId: 'm1', cardId: 'full', seconds: 2 },
    { id: 'i5', kind: 'video', library: 'in', name: 'c.mkv', start: 0.5, end: 3.5, credit: 'streamerone' },
  ],
  ...changes,
});

describe('buildCompilation', () => {
  it('joins three unlike clips and two cards into one file, in sync and at the right length', async () => {
    const progress = [];
    const built = await buildCompilation({ timeline: timeline(), dataDir, resolveVideo, onProgress: (p) => progress.push(p) });

    // 3 + 3 + 2 + 2 + 3 seconds.
    expect(Math.abs(built.seconds - 13)).toBeLessThan(0.2);
    expect(built.items.map((item) => Math.round(item.seconds * 10) / 10)).toEqual([3, 3, 2, 2, 3]);
    expect(built.items.every((item) => !item.reused)).toBe(true);
    const final = await probe(built.file);
    expect([final.width, final.height, final.fps, final.audioStreams]).toEqual([1920, 1080, 30, 1]);

    // Both cards have their sound under them: a voice under the goal, a soft whistle under full time.
    expect(await level(built.file, 0.3, 1.5)).toBeGreaterThan(-40);
    expect(await level(built.file, 8.15, 0.25)).toBeGreaterThan(-45);
    // A sound starts when its card does. The whistle's first note eases in from
    // 0.05 s into its sound, and its card starts at 8 s, after a clip with no sound.
    expect(Math.abs((await soundAt(built.file, 7.5)) - 8.08)).toBeLessThan(0.06);

    // The flash and beep are 1.5 s into the last clip, which starts 0.5 s in and follows 10 s of other items.
    // The card before it has a whistle under it, cut off as the card ends, and the two must still be in step.
    const flash = await flashAt(built.file, 9);
    const beep = await soundAt(built.file, 10.2);
    expect(Math.abs(flash - 11)).toBeLessThan(0.1);
    expect(Math.abs(flash - beep)).toBeLessThan(1 / 30 + 0.005);

    expect(await readFile(path.join(dataDir, 'compilations', 'goals', 'description.txt'), 'utf8')).toBe(built.description);
    expect(built.description).toBe([
      'Credits:', '- StreamerOne', '- Streamer Two', '',
      'Chapters:', "0:00 12' Goal: Lewandowski (pen) (FC Barcelona 1–0 Manchester United)", '0:08 Full time: FC Barcelona 1–0 Manchester United', '',
    ].join('\n'));

    expect(progress.filter((p) => p.status === 'done').map((p) => p.index)).toEqual([0, 1, 2, 3, 4]);
    expect(progress.at(-1)).toEqual({ joining: true });
  }, 240_000);

  it('makes again only the segment whose settings changed', async () => {
    const workDir = path.join(dataDir, 'compilations', 'goals', 'work');
    const before = (await readdir(workDir)).filter((name) => name.endsWith('.mp4')).sort();

    const again = await buildCompilation({ timeline: timeline(), dataDir, resolveVideo });
    expect(again.items.every((item) => item.reused)).toBe(true);

    const changed = timeline();
    changed.items[1].credit = 'A new name';
    const third = await buildCompilation({ timeline: changed, dataDir, resolveVideo });
    expect(third.items.map((item) => item.reused)).toEqual([true, false, true, true, true]);
    expect(third.description).toContain('- A new name');

    // The replaced segment is gone, and nothing half-made is left behind.
    const after = (await readdir(workDir)).filter((name) => name.endsWith('.mp4')).sort();
    expect(after).toHaveLength(5);
    expect(after.filter((name) => before.includes(name))).toHaveLength(4);
    expect((await readdir(workDir)).some((name) => name.includes('partial') || name === 'fonts')).toBe(false);
  }, 240_000);

  it('makes a segment again when its source file changes', async () => {
    const file = video('a.mp4');
    const { atime } = await stat(file);
    await utimes(file, atime, new Date(Date.now() + 5000));
    const built = await buildCompilation({ timeline: timeline(), dataDir, resolveVideo });
    expect(built.items.map((item) => item.reused)).toEqual([true, false, true, true, true]);
  }, 240_000);

  it('renders the tall preset with the tall card picture', async () => {
    const tall = timeline({ id: 'tall', preset: 'portrait', items: [
      { id: 'i1', kind: 'card', matchId: 'm1', cardId: 'goal', seconds: 1 },
      { id: 'i2', kind: 'video', library: 'in', name: 'c.mkv', end: 1, credit: '' },
    ] });
    const built = await buildCompilation({ timeline: tall, dataDir: path.relative(process.cwd(), dataDir), resolveVideo });
    const final = await probe(built.file);
    expect([final.width, final.height, final.fps]).toEqual([1080, 1920, 30]);
    expect(Math.abs(built.seconds - 2)).toBeLessThan(0.2);
    expect(built.description).toContain('- (no credits were entered)');
  }, 240_000);

  it('plays a sound under a card, and keeps the length a card was given', async () => {
    const soundsDir = path.join(dir, 'sounds');
    await mkdir(soundsDir, { recursive: true });
    // An owner's file as awkward as they come: mono, a low sample rate, half a second long.
    await ff(['-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=22050', '-t', '0.5', '-ac', '1', path.join(soundsDir, 'my horn.wav')]);
    const sounded = timeline({ id: 'sounded', items: [
      { id: 'i1', kind: 'card', matchId: 'm1', cardId: 'goal', seconds: 2, sound: 'builtin:tragic' }, // 4.6 s of sound: longer than the card
      { id: 'i2', kind: 'card', matchId: 'm1', cardId: 'full', seconds: 5 }, // the whistle is 2.9 s: shorter than the card
      { id: 'i3', kind: 'card', matchId: 'm1', cardId: 'goal', seconds: 1, sound: 'none' },
      { id: 'i4', kind: 'card', matchId: 'm1', cardId: 'goal', seconds: 2, sound: 'file:my horn.wav' },
      { id: 'i5', kind: 'video', library: 'in', name: 'c.mkv', start: 0.5, end: 3.5, credit: '' },
    ] });
    expect(sounded.items.map((item) => item.sound)).toEqual(['builtin:tragic', 'auto', 'none', 'file:my horn.wav', undefined]);
    const built = await buildCompilation({ timeline: sounded, dataDir, resolveVideo, soundsDir });

    // Every card is exactly as long as asked, whatever the length of its sound.
    expect(built.items.map((item) => Math.round(item.seconds * 100) / 100)).toEqual([2, 5, 1, 2, 3]);
    expect(Math.abs(built.seconds - 13)).toBeLessThan(0.2);

    expect(await level(built.file, 0.1, 1.4)).toBeGreaterThan(-40); // the chord, cut off as its card ends
    expect(await level(built.file, 3.3, 1)).toBeGreaterThan(-45); // the whistle's long note
    expect(await level(built.file, 6.3, 1.5)).toBeLessThan(-70); // the whistle is over; the card is still shown
    expect(await level(built.file, 7.1, 0.8)).toBeLessThan(-70); // the card with no sound
    expect(await level(built.file, 8.05, 0.4)).toBeGreaterThan(-40); // the owner's file
    expect(await level(built.file, 9, 0.9)).toBeLessThan(-70); // and silence once it has played

    // A sound under the card before it does not move the next clip: its flash and beep are still together.
    const flash = await flashAt(built.file, 10);
    const beep = await soundAt(built.file, 10.2);
    expect(Math.abs(flash - 11)).toBeLessThan(0.1);
    expect(Math.abs(flash - beep)).toBeLessThan(1 / 30 + 0.005);

    // Changing one card's sound makes only that card again.
    const changed = timeline({ id: 'sounded', items: sounded.items.map((item) => (item.id === 'i3' ? { ...item, sound: 'builtin:whistle' } : item)) });
    const again = await buildCompilation({ timeline: changed, dataDir, resolveVideo, soundsDir });
    expect(again.items.map((item) => item.reused)).toEqual([true, true, false, true, true]);
    expect(await level(again.file, 7.1, 0.8)).toBeGreaterThan(-45);
    // And so does replacing the owner's file with another of the same name.
    await ff(['-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=44100', '-t', '1', path.join(soundsDir, 'my horn.wav')]);
    const third = await buildCompilation({ timeline: changed, dataDir, resolveVideo, soundsDir });
    expect(third.items.map((item) => item.reused)).toEqual([true, true, true, false, true]);
  }, 240_000);

  it('shows a card with no length of its own exactly as long as its sound', async () => {
    const soundsDir = path.join(dir, 'fitted-sounds');
    await mkdir(soundsDir, { recursive: true });
    await ff(['-f', 'lavfi', '-i', 'sine=frequency=500:sample_rate=48000', '-t', '1.7', path.join(soundsDir, 'long shout.wav')]);
    const voice = await soundSeconds(await builtInSoundFile(dataDir, 'goal'));
    const fitted = timeline({ id: 'fitted', items: [
      { id: 'i1', kind: 'card', matchId: 'm1', cardId: 'goal' }, // the voice
      { id: 'i2', kind: 'card', matchId: 'm1', cardId: 'full', sound: 'builtin:tragic' }, // 4.6 s
      { id: 'i3', kind: 'card', matchId: 'm1', cardId: 'goal', sound: 'file:long shout.wav' }, // 1.7 s
      { id: 'i4', kind: 'card', matchId: 'm1', cardId: 'goal', sound: 'none' }, // silent: the usual 3 s
      { id: 'i5', kind: 'video', library: 'in', name: 'c.mkv', start: 0.5, end: 3.5, credit: '' },
    ] });
    expect(fitted.items.slice(0, 4).map((item) => item.seconds)).toEqual([null, null, null, null]);
    const built = await buildCompilation({ timeline: fitted, dataDir, resolveVideo, soundsDir });

    const lengths = built.items.map((item) => item.seconds);
    // Each is its sound's length, rounded up to a whole frame at most.
    for (const [index, sound] of [[0, voice], [1, 4.6], [2, 1.7]]) {
      expect(lengths[index]).toBeGreaterThanOrEqual(sound - 0.005);
      expect(lengths[index]).toBeLessThan(sound + 1 / 30 + 0.03);
    }
    expect(Math.abs(lengths[3] - 3)).toBeLessThan(0.03);

    // The sound is heard to its end: nothing is faded away early. The file's last
    // tenth of a second is still as loud in the video as its middle.
    const third = lengths[0] + lengths[1];
    expect(await level(built.file, third + 1.55, 0.1)).toBeGreaterThan((await level(built.file, third + 0.8, 0.1)) - 3);

    // The clip after four cards of odd lengths still has its flash and beep together.
    const before = lengths.slice(0, 4).reduce((sum, seconds) => sum + seconds, 0);
    const flash = await flashAt(built.file, before);
    const beep = await soundAt(built.file, before + 0.2);
    expect(Math.abs(flash - (before + 1))).toBeLessThan(0.1);
    expect(Math.abs(flash - beep)).toBeLessThan(1 / 30 + 0.005);
  }, 240_000);

  it('uses a file named after the kind of card in place of the built-in sound', async () => {
    const soundsDir = path.join(dir, 'own-sounds');
    await mkdir(soundsDir, { recursive: true });
    // An intro card has no sound of its own until the owner supplies one.
    expect(await automaticSounds(soundsDir)).toEqual({ intro: 'none', goal: 'builtin:goal', red: 'builtin:tragic', fulltime: 'builtin:whistle' });
    await ff(['-f', 'lavfi', '-i', 'sine=frequency=400:sample_rate=48000', '-t', '0.5', path.join(soundsDir, 'intro.wav')]);
    await ff(['-f', 'lavfi', '-i', 'sine=frequency=700:sample_rate=48000', '-t', '0.8', path.join(soundsDir, 'GOAL.wav')]);
    await ff(['-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000', '-t', '0.6', path.join(soundsDir, 'fulltime.wav')]);
    await writeFile(path.join(soundsDir, 'goalkeeper.wav'), 'not the goal sound');
    expect(await automaticSounds(soundsDir)).toEqual({ intro: 'file:intro.wav', goal: 'file:GOAL.wav', red: 'builtin:tragic', fulltime: 'file:fulltime.wav' });
    expect(await automaticSounds(undefined)).toEqual({ intro: 'none', goal: 'builtin:goal', red: 'builtin:tragic', fulltime: 'builtin:whistle' });

    const own = timeline({ id: 'own', items: [
      { id: 'i1', kind: 'card', matchId: 'm1', cardId: 'goal' },
      { id: 'i2', kind: 'card', matchId: 'm1', cardId: 'full' },
    ] });
    const built = await buildCompilation({ timeline: own, dataDir, resolveVideo, soundsDir });
    // The cards are as long as the owner's two files, not as the built-in sounds.
    expect(Math.abs(built.items[0].seconds - 0.8)).toBeLessThan(0.04);
    expect(Math.abs(built.items[1].seconds - 0.6)).toBeLessThan(0.04);
  }, 240_000);

  it('plays a video behind a card, with the card over it and the video\'s own sound', async () => {
    const soundsDir = path.join(dir, 'video-sounds');
    await mkdir(soundsDir, { recursive: true });
    // A 2-second video at 25 frames a second with a white flash and a beep one second in,
    // one with no sound at all, and a music file that carries a cover picture.
    const flash = "color=c=black:s=960x540:r=25,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='between(t,1,1.1)'";
    await ff(['-f', 'lavfi', '-i', flash, '-f', 'lavfi', '-i', "aevalsrc='if(between(t,1,1.1),sin(2*PI*1000*t),0)':s=44100", '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(soundsDir, 'goal.mp4')]);
    await ff(['-f', 'lavfi', '-i', flash, '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path.join(soundsDir, 'silent.mp4')]);
    await ff(['-f', 'lavfi', '-i', 'sine=frequency=440', '-i', path.join(dir, 'landscape.png'), '-t', '1', '-map', '0:a', '-map', '1:v', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic', path.join(soundsDir, 'song.mp3')]);
    await writeFile(path.join(soundsDir, 'goal.wav'), 'a sound of the same name: the video is preferred');

    expect(await soundInfo(path.join(soundsDir, 'goal.mp4'))).toMatchObject({ hasSound: true, hasPicture: true });
    expect(await soundInfo(path.join(soundsDir, 'silent.mp4'))).toMatchObject({ hasSound: false, hasPicture: true });
    expect(await soundInfo(path.join(soundsDir, 'song.mp3'))).toMatchObject({ hasSound: true, hasPicture: false }); // a cover is not a moving picture
    expect(await soundInfo(path.join(soundsDir, 'goal.wav'))).toBeNull();
    expect((await automaticSounds(soundsDir)).goal).toBe('file:goal.mp4');

    const overVideo = (items, id = 'over-video') => buildCompilation({ timeline: timeline({ id, items }), dataDir, resolveVideo, soundsDir });
    const card = { id: 'i1', kind: 'card', matchId: 'm1', cardId: 'goal' };
    const clip = { id: 'i9', kind: 'video', library: 'in', name: 'c.mkv', start: 0.5, end: 3.5, credit: '' };

    // The card needs its see-through picture for this, and says so when it has none.
    await expect(overVideo([card])).rejects.toThrow(/Item 1: the card has no see-through picture yet.*press Save/);
    const clear = path.join(dir, 'clear.png');
    await ff(['-f', 'lavfi', '-i', 'color=c=black@0.0:s=1920x1080,format=rgba', '-frames:v', '1', clear]);
    await saveCardPng(dataDir, 'm1', 'goal', 'landscape', await readFile(clear), true);

    const built = await overVideo([card, clip]);
    // The card lasts as long as the video, and the video shows through it: its flash is seen,
    // one second in, together with its beep.
    expect(Math.abs(built.items[0].seconds - 2)).toBeLessThan(0.05);
    const seen = await flashAt(built.file, 0.2);
    const heard = await soundAt(built.file, 0.2);
    expect(Math.abs(seen - 1)).toBeLessThan(0.06);
    expect(Math.abs(seen - heard)).toBeLessThan(1 / 30 + 0.012);
    // The clip after it is still in step.
    const flashed = await flashAt(built.file, 2.2);
    expect(Math.abs(flashed - 3)).toBeLessThan(0.1);
    expect(Math.abs(flashed - (await soundAt(built.file, 2.3)))).toBeLessThan(1 / 30 + 0.005);
    const final = await probe(built.file);
    expect([final.width, final.height, final.fps]).toEqual([1920, 1080, 30]);

    // Shown for longer than the video runs: the last frame is held, and the sound is not played twice.
    const longer = await overVideo([{ ...card, seconds: 4 }]);
    expect(Math.abs(longer.items[0].seconds - 4)).toBeLessThan(0.05);
    expect(await level(longer.file, 2.3, 1.5)).toBeLessThan(-70);
    expect(await flashAt(longer.file, 1.5)).toBeNull();

    // A video with no sound gives a silent card with a moving background.
    const silent = await overVideo([{ ...card, sound: 'file:silent.mp4' }]);
    expect(Math.abs(silent.items[0].seconds - 2)).toBeLessThan(0.05);
    expect(await level(silent.file, 0, 2)).toBeLessThan(-70);
    expect(Math.abs((await flashAt(silent.file, 0.2)) - 1)).toBeLessThan(0.06);

    // A music file with a cover picture is a sound and nothing more: the ordinary card is used.
    const song = await overVideo([{ ...card, sound: 'file:song.mp3' }]);
    expect(await flashAt(song.file, 0)).toBeNull();
  }, 240_000);

  // A streamer's reaction with the goal they are reacting to beside it. The
  // reaction here is the tall clip: black and silent but for a flash and a
  // beep, which fall one second into the range used. The "goal" is 0.6 s of
  // plain red with a steady tone.
  describe('a second video beside the first', () => {
    const reaction = { id: 'r', kind: 'video', library: 'in', name: 'c.mkv', start: 0.5, end: 3.5, credit: 'Streamer' };
    const goal = { library: 'in', name: 'red.mp4' };
    const make = (items, changes = {}) => buildCompilation({ timeline: timeline({ id: 'beside', items, ...changes }), dataDir, resolveVideo });

    beforeAll(async () => {
      await ff(['-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=25', '-f', 'lavfi', '-i', 'sine=frequency=800:sample_rate=44100', '-t', '0.6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video('red.mp4')]);
    }, 60_000);

    it('splits the screen while the second video runs, then gives it all to the first', async () => {
      const built = await make([{ ...reaction, beside: goal }, { ...reaction, id: 'next', credit: '' }]);
      // The segment is as long as the reaction, whatever the second video's length.
      expect(built.items.map((item) => Math.round(item.seconds * 100) / 100)).toEqual([3, 3]);
      const final = await probe(built.file);
      expect([final.width, final.height, final.fps, final.audioStreams]).toEqual([1920, 1080, 30, 1]);

      // 0.6 s at 30 frames a second is frames 0 to 17. The goal is on the right, the reaction on the left.
      expect(await redness(built.file, 9, RIGHT)).toBeGreaterThan(160);
      expect(await redness(built.file, 9, LEFT)).toBeLessThan(140);
      expect(await redness(built.file, 17, RIGHT)).toBeGreaterThan(160);
      // One frame later the second video is gone and the reaction has the whole screen.
      expect(await redness(built.file, 18, RIGHT)).toBeLessThan(140);
      expect(await redness(built.file, 18, LEFT)).toBeLessThan(140);

      // The reaction played through unbroken: its flash and beep are together, a second in,
      // and the clip after it is still in step.
      const flash = await flashAt(built.file, 0.7);
      expect(Math.abs(flash - 1)).toBeLessThan(0.1);
      expect(Math.abs(flash - (await soundAt(built.file, 0.8)))).toBeLessThan(1 / 30 + 0.005);
      const later = await flashAt(built.file, 3.2);
      expect(Math.abs(later - 4)).toBeLessThan(0.1);
      expect(Math.abs(later - (await soundAt(built.file, 3.3)))).toBeLessThan(1 / 30 + 0.005);

      // The second video's sound is heard while it runs, and not after.
      expect(await level(built.file, 0.1, 0.4)).toBeGreaterThan(-45);
      expect(await level(built.file, 0.7, 0.25)).toBeLessThan(-70);
      // The reaction's own sound is as loud as when it is shown alone (the second clip here).
      expect(Math.abs((await level(built.file, 0.98, 0.15)) - (await level(built.file, 3.98, 0.15)))).toBeLessThan(1.5);
    }, 240_000);

    it('leaves the second video\'s sound out when asked, and makes only that item again', async () => {
      const first = await make([{ ...reaction, beside: goal }, { ...reaction, id: 'next', credit: '' }]);
      expect(first.items.map((item) => item.reused)).toEqual([true, true]);
      const even = await level(first.file, 0.1, 0.4);
      const quiet = await make([{ ...reaction, beside: { ...goal, sound: 'off' } }, { ...reaction, id: 'next', credit: '' }]);
      expect(quiet.items.map((item) => item.reused)).toEqual([false, true]);
      expect(await level(quiet.file, 0.1, 0.4)).toBeLessThan(-70);
      expect(await redness(quiet.file, 9, RIGHT)).toBeGreaterThan(160); // the picture is still there

      // The third choice: heard, but well under the "even" level, with the main video's own sound unchanged.
      const low = await make([{ ...reaction, beside: { ...goal, sound: 'low' } }, { ...reaction, id: 'next', credit: '' }]);
      const lower = even - (await level(low.file, 0.1, 0.4));
      expect(lower).toBeGreaterThan(5);
      expect(lower).toBeLessThan(11);
      expect(Math.abs((await level(low.file, 0.98, 0.15)) - (await level(low.file, 3.98, 0.15)))).toBeLessThan(1.5);
    }, 240_000);

    it('stacks the two in a tall video: the second on top, the first below', async () => {
      const built = await make([{ ...reaction, beside: goal }], { preset: 'portrait' });
      const final = await probe(built.file);
      expect([final.width, final.height]).toEqual([1080, 1920]);
      expect(await redness(built.file, 9, TOP)).toBeGreaterThan(160);
      expect(await redness(built.file, 9, BOTTOM)).toBeLessThan(140);
      expect(await redness(built.file, 18, TOP)).toBeLessThan(140);
    }, 240_000);

    it('uses part of the second video, and cuts it off when the first ends sooner', async () => {
      // A wide test clip with sound as the second video, from 1 s on; the reaction is only one second long.
      const built = await make([{ ...reaction, end: 1.5, beside: { library: 'in', name: 'a.mp4', start: 1 } }]);
      expect(Math.abs(built.items[0].seconds - 1)).toBeLessThan(0.05);
      // Split to the last frame: the right half holds the test picture, which is bright, while the reaction is black.
      const bright = async (frame, part) => {
        const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', built.file, '-an', '-vf', `select='eq(n,${frame})',crop=${part},signalstats,metadata=print:key=lavfi.signalstats.YAVG`, '-frames:v', '1', '-f', 'null', '-']);
        return Number(/YAVG=([\d.]+)/.exec(stderr)[1]);
      };
      expect(await bright(28, RIGHT)).toBeGreaterThan(60);
      expect(await bright(28, LEFT)).toBeLessThan(30);
    }, 240_000);

    it('says what is wrong with the second video before encoding anything', async () => {
      await expect(make([{ ...reaction, beside: { library: 'in', name: 'red.mp4', start: 0.5, end: 0.2 } }])).rejects.toThrow(/Item 1: "red.mp4", shown beside "c.mkv": the end .* must be after the start/);
      await expect(make([{ ...reaction, beside: { library: 'in', name: 'red.mp4', end: 9 } }])).rejects.toThrow(/Item 1: "red.mp4", shown beside "c.mkv", is only 0:00.60 long/);
    });

    it('saves a second video by folder and name, and none by default', () => {
      expect(timeline().items[1].beside).toBeNull();
      const saved = (sound) => parseTimeline({ id: 'x', name: 'X', items: [{ ...reaction, beside: { ...goal, ...(sound === undefined ? {} : { sound }) } }] }).items[0].beside;
      expect(saved()).toEqual({ library: 'in', name: 'red.mp4', start: null, end: null, sound: 'even' });
      // Three choices now. A timeline saved when there were two has true or false, and keeps its meaning.
      expect([saved('low').sound, saved('off').sound, saved(true).sound, saved(false).sound]).toEqual(['low', 'off', 'even', 'off']);
      expect(() => saved('loud')).toThrow(/not valid/);
      expect(() => parseTimeline({ id: 'x', name: 'X', items: [{ ...reaction, beside: { library: 'home', name: 'red.mp4' } }] })).toThrow(/not valid/);
      expect(() => parseTimeline({ id: 'x', name: 'X', items: [{ ...reaction, beside: { library: 'in', name: 'red.mp4', path: '/etc/passwd' } }] })).toThrow(/not valid/);
    });
  });

  // A credited channel's picture beside its name. The picture here is a plain
  // red square and the clip is the black one, so red where the picture
  // belongs can only be the picture.
  describe('a channel\'s picture beside its credit', () => {
    const clip = { id: 'p', kind: 'video', library: 'in', name: 'c.mkv', start: 0.5, end: 3.5, credit: 'North Stand TV' };
    const spot = (size) => {
      const { picture } = creditLayout(size);
      return `${picture.size - 20}:${picture.size - 20}:${picture.x + 10}:${picture.y + 10}`; // the middle of the square it sits in
    };
    const WIDE = spot({ width: 1920, height: 1080 });
    const TALL = spot({ width: 1080, height: 1920 });
    let pictures;
    const make = (items, changes = {}, given = pictures) => buildCompilation({ timeline: timeline({ id: 'pictured', items, ...changes }), dataDir, resolveVideo, pictures: given });

    beforeAll(async () => {
      const file = path.join(dir, 'north-stand.png');
      await ff(['-f', 'lavfi', '-i', 'color=c=red:s=256x256,format=rgba', '-frames:v', '1', file]);
      pictures = { 'north stand tv': file };
      // A black clip with no sound, for the cases where silence is added as one more input.
      await ff(['-f', 'lavfi', '-i', 'color=c=black:s=1280x720:r=30', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', video('quiet.mp4')]);
    }, 60_000);

    it('draws the picture for a credit spelled like the channel, and for no other', async () => {
      const others = [{ ...clip, id: 'q', credit: 'Someone Else' }, { ...clip, id: 'r', credit: '' }];
      const plain = await make([clip, ...others], {}, {});
      expect(await redness(plain.file, 15, WIDE)).toBeLessThan(140); // no pictures given: none drawn

      const built = await make([clip, ...others]);
      // Only the item whose credit has a picture was made again.
      expect(built.items.map((item) => item.reused)).toEqual([false, true, true]);
      expect(await redness(built.file, 15, WIDE)).toBeGreaterThan(160); // "north stand tv", whatever the capitals
      expect(await redness(built.file, 90 + 15, WIDE)).toBeLessThan(140); // another name
      expect(await redness(built.file, 180 + 15, WIDE)).toBeLessThan(140); // no credit at all
      expect(built.items.map((item) => Math.round(item.seconds * 100) / 100)).toEqual([3, 3, 3]);

      // The picture changes nothing else: the flash and the beep are still together, a second in.
      const flash = await flashAt(built.file, 0.7);
      expect(Math.abs(flash - 1)).toBeLessThan(0.1);
      expect(Math.abs(flash - (await soundAt(built.file, 0.8)))).toBeLessThan(1 / 30 + 0.005);
    }, 240_000);

    it('draws it in a tall video, and on a split screen from first frame to last', async () => {
      const tall = await make([clip], { preset: 'portrait' });
      expect(await redness(tall.file, 15, TALL)).toBeGreaterThan(160);

      const split = await make([{ ...clip, beside: { library: 'in', name: 'a.mp4', end: 1, sound: 'off' } }]);
      expect(await redness(split.file, 10, WIDE)).toBeGreaterThan(160); // during the split
      expect(await redness(split.file, 60, WIDE)).toBeGreaterThan(160); // and after it
      expect(Math.abs(split.items[0].seconds - 3)).toBeLessThan(0.05);
    }, 240_000);

    it('draws it on a video with no sound, alone and on a split screen, where silence is one more input', async () => {
      const quiet = { id: 'n', kind: 'video', library: 'in', name: 'quiet.mp4', start: 0, end: 2, credit: 'North Stand TV' };
      const alone = await make([quiet]);
      expect(await redness(alone.file, 15, WIDE)).toBeGreaterThan(160);
      const split = await make([{ ...quiet, beside: { library: 'in', name: 'quiet.mp4', end: 1, sound: 'even' } }]);
      expect(await redness(split.file, 10, WIDE)).toBeGreaterThan(160);
      expect(await redness(split.file, 45, WIDE)).toBeGreaterThan(160);
      expect(await level(split.file, 0.2, 1.5)).toBeLessThan(-70); // and it is silent, with a sound track to join
    }, 240_000);

    it('makes nothing again when the same picture is fetched again, and the clip again when the picture changes', async () => {
      const first = await make([clip]);
      // The same picture, written anew: a later date and nothing else.
      await writeFile(pictures['north stand tv'], await readFile(pictures['north stand tv']));
      expect((await make([clip])).items[0].reused).toBe(true);
      const other = path.join(dir, 'north-stand-new.png');
      await ff(['-f', 'lavfi', '-i', 'color=c=blue:s=256x256,format=rgba', '-frames:v', '1', other]);
      const changed = await make([clip], {}, { 'north stand tv': other });
      expect(changed.items[0].reused).toBe(false);
      expect(await redness(changed.file, 15, WIDE)).toBeLessThan(140);
      expect(first.items[0].seconds).toBe(changed.items[0].seconds);
    }, 240_000);

    it('moves the name to the right of the picture, and leaves it where it was without one', () => {
      const size = { width: 1920, height: 1080 };
      const { margin, nameLeft, picture } = creditLayout(size);
      expect(creditSubtitles('Ana', size, 3)).toContain(`,1,${margin},${margin},${margin},1`);
      expect(creditSubtitles('Ana', size, 3, { withPicture: true })).toContain(`,1,${nameLeft},${margin},${margin},1`);
      expect(nameLeft).toBeGreaterThan(picture.x + picture.size);
      expect(picture.y + picture.size).toBeLessThan(size.height); // the picture is inside the frame
    });
  });

  it('says so when a card\'s sound cannot be used', async () => {
    const soundsDir = path.join(dir, 'sounds');
    await mkdir(soundsDir, { recursive: true });
    await writeFile(path.join(soundsDir, 'empty.mp3'), 'not a sound');
    const card = (sound) => buildCompilation({ timeline: timeline({ id: 'bad', items: [{ id: 'x', kind: 'card', matchId: 'm1', cardId: 'goal', sound }] }), dataDir, resolveVideo, soundsDir });
    await expect(card('file:gone.mp3')).rejects.toThrow(/Item 1: its sound "gone.mp3" is not in the sounds folder/);
    await expect(card('file:empty.mp3')).rejects.toThrow(/Item 1: its sound "empty.mp3" has no sound in it/);
    await expect(card('builtin:trumpet')).rejects.toThrow(/Item 1: its sound "trumpet" is not one of the built-in sounds/);
    // Without a sounds folder a built-in sound still works, and a file is refused.
    await expect(buildCompilation({ timeline: timeline({ id: 'bad', items: [{ id: 'x', kind: 'card', matchId: 'm1', cardId: 'goal', sound: 'file:my horn.wav' }] }), dataDir, resolveVideo }))
      .rejects.toThrow(/needs a sounds folder/);
  });

  it('says which item is wrong before encoding anything', async () => {
    const bad = (items) => buildCompilation({ timeline: timeline({ id: 'bad', items }), dataDir, resolveVideo });
    await expect(bad([])).rejects.toThrow(/Add at least one/);
    await expect(bad([{ id: 'x', kind: 'video', library: 'in', name: 'a.mp4', start: 2, end: 1 }])).rejects.toThrow(/Item 1: "a.mp4": the end .* must be after the start/);
    await expect(bad([{ id: 'x', kind: 'video', library: 'in', name: 'a.mp4', end: 99 }])).rejects.toThrow(/Item 1: "a.mp4" is only 0:03.00 long/);
    await expect(bad([{ id: 'x', kind: 'card', matchId: 'm1', cardId: 'gone' }])).rejects.toThrow(/Item 1: its card was deleted/);
    await expect(bad([{ id: 'x', kind: 'card', matchId: 'nope', cardId: 'goal' }])).rejects.toThrow(/Item 1: its match was deleted/);
    await expect(readdir(path.join(dataDir, 'compilations', 'bad', 'work'))).resolves.toEqual([]);
  });
});

describe('sounds', () => {
  it('has a built-in sound for each kind of card', () => {
    expect(DEFAULT_SOUND).toEqual({ intro: null, goal: 'goal', red: 'tragic', fulltime: 'whistle' });
    for (const id of Object.values(DEFAULT_SOUND).filter(Boolean)) expect(BUILT_IN[id].name.length).toBeGreaterThan(5);
  });

  it.each(Object.keys(BUILT_IN))('makes the built-in sound "%s" once: a sensible length, audible, not clipped', async (id) => {
    const file = await builtInSoundFile(dataDir, id);
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=sample_rate,channels', '-of', 'csv=p=0', file]);
    expect(stdout.trim()).toBe('48000,2');
    const seconds = await soundSeconds(file);
    expect(seconds).toBeGreaterThan(1.5);
    expect(seconds).toBeLessThanOrEqual(BUILT_IN[id].longest + 0.01);
    const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-']);
    expect(Number(/mean_volume: (-?[\d.]+)/.exec(stderr)[1])).toBeGreaterThan(-40);
    expect(Number(/max_volume: (-?[\d.]+)/.exec(stderr)[1])).toBeLessThan(-1);
    expect(await level(file, 0, 0.6)).toBeGreaterThan(-45); // it starts straight away

    // Asked for twice at the same moment, as when the page plays a sound while a
    // video is being made, both get the one good file and nothing half-made is left.
    const fresh = path.join(dir, `twice-${id}`);
    const [one, other] = await Promise.all([builtInSoundFile(fresh, id), builtInSoundFile(fresh, id)]);
    expect(one).toBe(other);
    expect((await stat(one)).size).toBe((await stat(file)).size);
    expect(await readdir(path.dirname(one))).toEqual([path.basename(one)]);

    // Asked for again, the same file is handed back and not made a second time.
    const made = (await stat(file)).mtimeMs;
    expect(await builtInSoundFile(dataDir, id)).toBe(file);
    expect((await stat(file)).mtimeMs).toBe(made);
  }, 60_000);

  // "Ear destroying" was the owner's word for the first whistle: a loud 2950 Hz
  // tone, where hearing is keenest. These hold the new one to being soft.
  it('makes a whistle that is soft: low in pitch, nothing sharp in it, and eased in', async () => {
    const file = await builtInSoundFile(dataDir, 'whistle');
    const band = async (filter) => {
      const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', file, '-af', `${filter},volumedetect`, '-f', 'null', '-']);
      return Number(/mean_volume: (-?[\d.]+)/.exec(stderr)[1]);
    };
    // It lies around 1568 Hz, and almost nothing of it is in the band the old one filled.
    const around = await band('highpass=f=1100,lowpass=f=2100');
    expect(around).toBeGreaterThan(await band('highpass=f=2700,highpass=f=2700') + 15);
    expect(around).toBeGreaterThan(await band('lowpass=f=700,lowpass=f=700') + 15);
    // Its first note starts quietly and grows: the first 30 ms are well under what follows.
    expect(await level(file, 0.05, 0.03)).toBeLessThan((await level(file, 0.2, 0.1)) - 6);
    // And it is played well under the other card sounds.
    expect(BUILT_IN.whistle.quieter).toBeGreaterThanOrEqual(6);
  });

  it('makes a tragic chord that is low and dies away slowly', async () => {
    const file = await builtInSoundFile(dataDir, 'tragic');
    const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', file, '-af', 'highpass=f=2000,highpass=f=2000,volumedetect', '-f', 'null', '-']);
    expect(Number(/mean_volume: (-?[\d.]+)/.exec(stderr)[1])).toBeLessThan(-60); // nothing bright in it
    // The last chord is still sounding three seconds in, and quieter by the end.
    expect(await level(file, 3, 0.4)).toBeGreaterThan(-45);
    expect(await level(file, 4.2, 0.4)).toBeLessThan(await level(file, 2, 0.4));
  });

  it('refuses a built-in sound that does not exist', async () => {
    await expect(builtInSoundFile(dataDir, 'trumpet')).rejects.toThrow(/no built-in sound called "trumpet"/);
    await expect(builtInSoundFile(dataDir, 'constructor')).rejects.toThrow(/no built-in sound/);
  });

  it('knows a sound choice when it sees one, and only plain file names', () => {
    for (const good of ['auto', 'none', 'builtin:cheer', 'file:goal.mp3', 'file:My Crowd (1).WAV', 'file:ուրախ.ogg', 'file:intro.mp4']) expect(isSoundChoice(good), good).toBe(true);
    for (const bad of ['', 'cheer', 'builtin:', 'builtin:../x', 'file:', 'file:../secret.mp3', 'file:a/b.mp3', 'file:.hidden.mp3', 'file:notes.txt', 'file:photo.png', 7, null]) {
      expect(isSoundChoice(bad), String(bad)).toBe(false);
    }
  });

  it('lists only the sound files in the sounds folder', async () => {
    const folder = path.join(dir, 'listed');
    await mkdir(folder);
    for (const name of ['b.mp3', 'A.wav', 'notes.txt', '.hidden.mp3', 'video.mp4', 'photo.png']) await writeFile(path.join(folder, name), 'x');
    // A video counts: it gives a card its sound and a moving background.
    expect(await listSoundFiles(folder)).toEqual(['A.wav', 'b.mp3', 'video.mp4']);
    expect(await listSoundFiles(path.join(dir, 'no-such-folder'))).toEqual([]);
    expect(await listSoundFiles(undefined)).toEqual([]);
  });
});

describe('description', () => {
  it('lists each streamer once and starts the chapters at 0:00', () => {
    const text = buildDescription([
      { kind: 'video', seconds: 12.4, credit: 'Ana' },
      { kind: 'card', seconds: 3, title: 'First goal' },
      { kind: 'video', seconds: 50, credit: 'ana' },
      { kind: 'video', seconds: 4000, credit: 'Ben' },
      { kind: 'card', seconds: 3, title: 'Full time' },
    ]);
    expect(text).toBe('Credits:\n- Ana\n- Ben\n\nChapters:\n0:00 Start\n0:12 First goal\n1:07:45 Full time\n');
  });

  it('writes chapter times and card titles', () => {
    expect([chapterTime(0), chapterTime(59.9), chapterTime(61), chapterTime(3723)]).toEqual(['0:00', '0:59', '1:01', '1:02:03']);
    const red = { type: 'red', team: 'away', player: 'Martínez', minute: 67, added: null, redType: 'second-yellow' };
    expect(cardTitle(match, red)).toBe("67' Red card: Martínez (second yellow)");
    expect(cardTitle(match, { id: 'i', type: 'intro', showScore: false })).toBe('FC Barcelona v Manchester United');
    expect(cardTitle(match, { ...match.cards[0], goalType: 'own-goal', minute: 90, added: 3 })).toBe("90+3' Goal: Lewandowski (og) (FC Barcelona 1–0 Manchester United)");
  });
});

describe('credit label', () => {
  it('is drawn on a canvas the size of the compilation, with control characters removed', () => {
    const wide = creditSubtitles('Streamer{\\b1} One', { width: 1920, height: 1080 }, 12.5);
    expect(wide).toContain('PlayResX: 1920\nPlayResY: 1080');
    expect(wide).toContain('Dialogue: 0,0:00:00.00,0:00:12.50,Credit,,0,0,0,,Streamerb1 One');
    expect(creditSubtitles('x', { width: 1080, height: 1920 }, 1)).toContain('PlayResX: 1080\nPlayResY: 1920');
  });

  it('is drawn on a plate as wide as the name, with a ring for the picture when there is one', () => {
    const size = { width: 1920, height: 1080 };
    const { picture, nameLeft, margin } = creditLayout(size);
    const lines = (text) => text.split('\n').filter((line) => line.startsWith('Dialogue:'));
    const right = (line) => Math.max(...line.split('\\p1}')[1].match(/-?[\d.]+/g).map(Number).filter((n, i) => i % 2 === 0));

    expect(lines(creditSubtitles('Ana', size, 3))).toHaveLength(1); // no width given: the name alone, as for measuring

    const named = lines(creditSubtitles('Ana', size, 3, { nameWidth: 80 }));
    expect(named.map((line) => line.split(',')[0])).toEqual(['Dialogue: 0', 'Dialogue: 1', 'Dialogue: 3']); // shadow, plate, name
    expect(right(named[1])).toBeGreaterThan(margin + 80);
    expect(named[1]).toContain('\\bord2'); // the plate's edge
    expect(named[0]).toContain('\\blur'); // the soft shadow

    const pictured = lines(creditSubtitles('Ana', size, 3, { withPicture: true, nameWidth: 80 }));
    expect(pictured.map((line) => line.split(',')[0])).toEqual(['Dialogue: 0', 'Dialogue: 1', 'Dialogue: 2', 'Dialogue: 3']);
    expect(right(pictured[1])).toBeGreaterThan(nameLeft + 80);
    expect(right(pictured[2])).toBeGreaterThan(picture.x + picture.size); // the ring reaches past the picture
    // A longer name gets a wider plate by as much.
    expect(right(lines(creditSubtitles('Ana', size, 3, { withPicture: true, nameWidth: 280 }))[1]) - right(pictured[1])).toBe(200);
  });
});

describe('saved compilations', () => {
  it('saves, lists, reads and deletes a timeline', async () => {
    const saved = await saveTimeline(dataDir, { id: 'kept', name: 'Kept', items: [{ id: 'a', kind: 'card', matchId: 'm1', cardId: 'goal' }] });
    // A card saved without a sound, as every card was before sounds existed, gets the automatic one.
    // No length either: the card will be shown as long as its sound.
    expect(saved).toMatchObject({ preset: 'landscape', items: [{ seconds: null, sound: 'auto' }] });
    expect((await listCompilations(dataDir)).map((t) => t.id)).toContain('kept');
    expect((await readTimeline(dataDir, 'kept')).name).toBe('Kept');
    expect(await newCompilationId(dataDir, 'Kept')).toBe('kept-2');
    expect(await newCompilationId(dataDir, 'Clásico: goal reactions!')).toBe('clasico-goal-reactions');
    await deleteCompilation(dataDir, 'kept');
    await expect(readTimeline(dataDir, 'kept')).rejects.toThrow(/No such compilation/);
    await expect(readTimeline(dataDir, '../m1')).rejects.toThrow(/No such compilation/);
  });

  it('rejects a timeline that is not well formed', () => {
    expect(() => parseTimeline({ id: 'x', name: 'X', items: [{ id: 'a', kind: 'video', library: 'home', name: 'a.mp4' }] })).toThrow(/not valid/);
    expect(() => parseTimeline({ id: 'x', name: 'X', preset: 'square' })).toThrow(/not valid/);
    expect(() => parseTimeline({ id: 'x', name: '' })).toThrow(/not valid/);
    const card = (sound) => parseTimeline({ id: 'x', name: 'X', items: [{ id: 'a', kind: 'card', matchId: 'm1', cardId: 'goal', sound }] });
    expect(card('file:crowd.mp3').items[0].sound).toBe('file:crowd.mp3');
    expect(() => card('file:../crowd.mp3')).toThrow(/not valid/);
    expect(() => card('loud')).toThrow(/not valid/);
  });
});
