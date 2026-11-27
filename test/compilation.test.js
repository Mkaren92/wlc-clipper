// The compilation builder, with the real ffmpeg. These are the request's
// acceptance checks: unlike clips and cards joined into one file that plays
// in sync, at the right length, with a description beside it.
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { soundKindOf } from '../src/cards/config.js';
import { saveCardPng, saveMatch } from '../src/cards/match.js';
import { buildCompilation, creditLayout, creditSubtitles } from '../src/compilation/build.js';
import { buildDescription, cardTitle, chapterProblem, chaptersOf, chapterTime, countHashtags, DEFAULT_POST, MAX_TAGS_LENGTH, suggestHashtags, suggestTags, tagsLength, tagsOf, titleIdeas } from '../src/compilation/description.js';
import { automaticSounds, CARD_KINDS, isSoundChoice, listSoundFiles, resolveSound, soundSeconds } from '../src/compilation/sounds.js';
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

    // With no sounds folder a card has no sound: the tool has none of its own (2026-11-24).
    expect(await level(built.file, 0.3, 1.5)).toBeLessThan(-70);
    expect(await level(built.file, 8.15, 1.5)).toBeLessThan(-70);

    // The flash and beep are 1.5 s into the last clip, which starts 0.5 s in and follows 10 s of other items.
    // A silent card comes before it, and the two must still be in step.
    const flash = await flashAt(built.file, 9);
    const beep = await soundAt(built.file, 10.2);
    expect(Math.abs(flash - 11)).toBeLessThan(0.1);
    expect(Math.abs(flash - beep)).toBeLessThan(1 / 30 + 0.005);

    expect(await readFile(path.join(dataDir, 'compilations', 'goals', 'description.txt'), 'utf8')).toBe(built.description);
    expect(built.description).toBe([
      'TIMESTAMP', '00:00 FC Barcelona 1-0 Manchester United', '00:08 FULL TIME FC Barcelona 1-0 Manchester United', '',
      '----------------', 'FAN CHANNELS IN THE VIDEO 🎥', DEFAULT_POST.fanText, '', 'StreamerOne', 'Streamer Two', '',
      '----------------', DEFAULT_POST.callToAction, '',
    ].join('\n'));
    // What the chapters were worked out from is kept beside the video: each item's real length, and the timeline as it was.
    const made = JSON.parse(await readFile(path.join(dataDir, 'compilations', 'goals', 'made.json'), 'utf8'));
    expect(made.from).toEqual(timeline().items);
    expect(made.items.map((item) => [item.kind, Math.round(item.seconds), item.credit ?? item.title])).toEqual([
      ['card', 3, 'FC Barcelona 1-0 Manchester United'], ['video', 3, 'StreamerOne'], ['video', 2, 'Streamer Two'], ['card', 2, 'FULL TIME FC Barcelona 1-0 Manchester United'], ['video', 3, 'streamerone'],
    ]);
    expect(buildDescription(made.items, {}, timeline().post)).toBe(built.description);

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
    expect(third.description.split('\n')).toContain('A new name');

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
    // Nobody is credited, so the part about fan channels is left out, with its heading.
    expect(built.description).not.toContain('FAN CHANNELS');
    expect(built.description.startsWith('TIMESTAMP\n00:00 FC Barcelona 1-0 Manchester United\n')).toBe(true);
  }, 240_000);

  it('plays a sound under a card, and keeps the length a card was given', async () => {
    const soundsDir = path.join(dir, 'sounds');
    await mkdir(soundsDir, { recursive: true });
    // An owner's file as awkward as they come: mono, a low sample rate, half a second long.
    await ff(['-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=22050', '-t', '0.5', '-ac', '1', path.join(soundsDir, 'my horn.wav')]);
    await ff(['-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000', '-t', '4.6', path.join(soundsDir, 'chord.wav')]);
    // Named after the kind of card, so a full-time card set to "auto" plays it.
    await ff(['-f', 'lavfi', '-i', 'sine=frequency=1500:sample_rate=48000', '-t', '2.9', path.join(soundsDir, 'fulltime.wav')]);
    const sounded = timeline({ id: 'sounded', items: [
      { id: 'i1', kind: 'card', matchId: 'm1', cardId: 'goal', seconds: 2, sound: 'file:chord.wav' }, // 4.6 s of sound: longer than the card
      { id: 'i2', kind: 'card', matchId: 'm1', cardId: 'full', seconds: 5 }, // the whistle is 2.9 s: shorter than the card
      { id: 'i3', kind: 'card', matchId: 'm1', cardId: 'goal', seconds: 1, sound: 'none' },
      { id: 'i4', kind: 'card', matchId: 'm1', cardId: 'goal', seconds: 2, sound: 'file:my horn.wav' },
      { id: 'i5', kind: 'video', library: 'in', name: 'c.mkv', start: 0.5, end: 3.5, credit: '' },
    ] });
    expect(sounded.items.map((item) => item.sound)).toEqual(['file:chord.wav', 'auto', 'none', 'file:my horn.wav', undefined]);
    const built = await buildCompilation({ timeline: sounded, dataDir, resolveVideo, soundsDir });

    // Every card is exactly as long as asked, whatever the length of its sound.
    expect(built.items.map((item) => Math.round(item.seconds * 100) / 100)).toEqual([2, 5, 1, 2, 3]);
    expect(Math.abs(built.seconds - 13)).toBeLessThan(0.2);

    expect(await level(built.file, 0.1, 1.4)).toBeGreaterThan(-40); // the chord, cut off as its card ends
    expect(await level(built.file, 3.3, 1)).toBeGreaterThan(-45); // the whistle's long note
    expect(await level(built.file, 6.3, 1.5)).toBeLessThan(-70); // the whistle is over; the card is still shown
    expect(await level(built.file, 7.1, 0.8)).toBeLessThan(-70); // the card with no sound
    expect(await level(built.file, 8.05, 0.4)).toBeGreaterThan(-40); // the owner's file
    // A sound starts when its card does: this card starts at 8 s, after a second of silence.
    expect(Math.abs((await soundAt(built.file, 7.2)) - 8)).toBeLessThan(0.06);
    expect(await level(built.file, 9, 0.9)).toBeLessThan(-70); // and silence once it has played

    // A sound under the card before it does not move the next clip: its flash and beep are still together.
    const flash = await flashAt(built.file, 10);
    const beep = await soundAt(built.file, 10.2);
    expect(Math.abs(flash - 11)).toBeLessThan(0.1);
    expect(Math.abs(flash - beep)).toBeLessThan(1 / 30 + 0.005);

    // Changing one card's sound makes only that card again.
    const changed = timeline({ id: 'sounded', items: sounded.items.map((item) => (item.id === 'i3' ? { ...item, sound: 'file:fulltime.wav' } : item)) });
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
    await ff(['-f', 'lavfi', '-i', 'sine=frequency=350:sample_rate=48000', '-t', '2.3', path.join(soundsDir, 'goal.wav')]);
    await ff(['-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000', '-t', '4.6', path.join(soundsDir, 'chord.wav')]);
    const voice = await soundSeconds(path.join(soundsDir, 'goal.wav'));
    const fitted = timeline({ id: 'fitted', items: [
      { id: 'i1', kind: 'card', matchId: 'm1', cardId: 'goal' }, // "auto": the file named goal
      { id: 'i2', kind: 'card', matchId: 'm1', cardId: 'full', sound: 'file:chord.wav' }, // 4.6 s
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

  it('uses a file named after the kind of card, and is silent for a kind that has none', async () => {
    const soundsDir = path.join(dir, 'own-sounds');
    await mkdir(soundsDir, { recursive: true });
    // No card has a sound of its own until the owner supplies one.
    expect(await automaticSounds(soundsDir)).toEqual({ goal: 'none', red: 'none', fulltime: 'none' });
    // A file named for the intro card, which is gone, is nobody's sound; nor is a video, which once went behind a card.
    await ff(['-f', 'lavfi', '-i', 'sine=frequency=400:sample_rate=48000', '-t', '0.5', path.join(soundsDir, 'intro.wav')]);
    await writeFile(path.join(soundsDir, 'red.mp4'), 'a video');
    await ff(['-f', 'lavfi', '-i', 'sine=frequency=700:sample_rate=48000', '-t', '0.8', path.join(soundsDir, 'GOAL.wav')]);
    await ff(['-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000', '-t', '0.6', path.join(soundsDir, 'fulltime.wav')]);
    await writeFile(path.join(soundsDir, 'goalkeeper.wav'), 'not the goal sound');
    expect(await automaticSounds(soundsDir)).toEqual({ goal: 'file:GOAL.wav', red: 'none', fulltime: 'file:fulltime.wav' });
    expect(await listSoundFiles(soundsDir)).toEqual(['fulltime.wav', 'GOAL.wav', 'goalkeeper.wav', 'intro.wav']);
    expect(await automaticSounds(undefined)).toEqual({ goal: 'none', red: 'none', fulltime: 'none' });
    // A missed penalty is a goal card, but "Automatic" is silent under it, though GOAL.wav is there.
    const miss = { type: 'goal', goalType: 'penalty-miss' };
    expect(soundKindOf(miss)).toBe('missed');
    expect(soundKindOf({ type: 'goal', goalType: 'penalty' })).toBe('goal');
    expect(await resolveSound({ choice: 'auto', cardType: soundKindOf(miss), soundsDir })).toBeNull();

    const own = timeline({ id: 'own', items: [
      { id: 'i1', kind: 'card', matchId: 'm1', cardId: 'goal' },
      { id: 'i2', kind: 'card', matchId: 'm1', cardId: 'full' },
    ] });
    const built = await buildCompilation({ timeline: own, dataDir, resolveVideo, soundsDir });
    // The cards are as long as the owner's two files.
    expect(Math.abs(built.items[0].seconds - 0.8)).toBeLessThan(0.04);
    expect(Math.abs(built.items[1].seconds - 0.6)).toBeLessThan(0.04);
    // With no sounds folder at all the same cards are silent, and shown for the usual 3 seconds.
    const silent = await buildCompilation({ timeline: timeline({ ...own, id: 'own-silent' }), dataDir, resolveVideo });
    expect(silent.items.map((item) => Math.round(item.seconds * 100) / 100)).toEqual([3, 3]);
    expect(await level(silent.file, 0.5, 2)).toBeLessThan(-70);
  }, 240_000);

  it('leans the logo of a goal card to the right, then to the left, three times, and stands it straight', async () => {
    // A match of its own, so the other tests' cards stay without the pieces and are made as before.
    await saveMatch(dataDir, { ...match, id: 'm2' });
    // The card's picture is the cards' own background, in its exact colours: the dark green with a
    // lighter stripe every 240, each pixel written as the numbers it has on a card.
    const green = path.join(dir, 'swing-card.png');
    const stripe = (light, dark) => `'if(lt(mod(X,240),120),${light},${dark})'`;
    await ff(['-f', 'lavfi', '-i', `nullsrc=s=1920x1080,format=rgb24,geq=r=${stripe(18, 10)}:g=${stripe(33, 26)}:b=${stripe(27, 20)}`, '-frames:v', '1', green]);
    const navy = await readFile(green);
    // The moving logo as the card maker would save it: a square of 324 (the 270 logo with room to lean),
    // here a white bar standing upright in its middle, on nothing.
    const bar = path.join(dir, 'bar.png');
    await ff(['-f', 'lavfi', '-i', 'color=c=black@0.0:s=324x324,format=rgba,drawbox=x=152:y=20:w=20:h=284:color=white:t=fill:replace=1', '-frames:v', '1', bar]);
    await saveCardPng(dataDir, 'm2', 'goal', 'landscape', navy);
    const card = { id: 'i1', kind: 'card', matchId: 'm2', cardId: 'goal', seconds: 3 };
    const make = (items = [card], more = {}) => buildCompilation({ timeline: timeline({ id: 'swing', items }), dataDir, resolveVideo, ...more });
    const bright = async (file, frame, part) => {
      const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', file, '-an', '-vf', `select='eq(n,${frame})',crop=${part},signalstats,metadata=print:key=lavfi.signalstats.YAVG`, '-frames:v', '1', '-f', 'null', '-']);
      return Number(/YAVG=([\d.]+)/.exec(stderr)[1]);
    };
    // The home club's logo stands at 400, 745 on the wide card, so its square begins at 238, 583.
    // Two patches beside the top of the bar: the bar is in neither while it stands straight.
    const RIGHT_OF_BAR = '30:60:414:610';
    const LEFT_OF_BAR = '30:60:356:610';
    const ON_BAR = '12:200:394:645';

    // Without the two pieces the card is a still picture, as it always was.
    const plain = await make();
    for (const frame of [3, 16, 25]) expect(await bright(plain.file, frame, ON_BAR)).toBeLessThan(40);

    // The pieces are refused unless they are what the card's own drawing says: a logo of 324, a card-sized rest.
    await expect(saveCardPng(dataDir, 'm2', 'goal', 'landscape', navy, 'logo')).rejects.toThrow(/PNG of 324x324/);
    await expect(saveCardPng(dataDir, 'm2', 'goal', 'landscape', await readFile(bar), 'still')).rejects.toThrow(/PNG of 1920x1080/);
    await expect(saveCardPng(dataDir, 'm2', 'full', 'landscape', navy, 'still')).rejects.toThrow(/No logo moves/);
    await expect(saveCardPng(dataDir, 'm2', 'goal', 'landscape', navy, 'sideways')).rejects.toThrow(/no piece of that name/);
    await saveCardPng(dataDir, 'm2', 'goal', 'landscape', navy, 'still');
    await saveCardPng(dataDir, 'm2', 'goal', 'landscape', await readFile(bar), 'logo');

    const built = await make();
    expect(built.items[0].reused).toBe(false);
    expect(Math.abs(built.items[0].seconds - 3)).toBeLessThan(0.05);
    // Straight before it starts (0.4 s in) and after the third time (2.2 s in): the bar is where it was saved.
    for (const frame of [3, 75, 88]) {
      expect(await bright(built.file, frame, ON_BAR), `frame ${frame}`).toBeGreaterThan(200);
      expect(await bright(built.file, frame, RIGHT_OF_BAR), `frame ${frame}`).toBeLessThan(40);
      expect(await bright(built.file, frame, LEFT_OF_BAR), `frame ${frame}`).toBeLessThan(40);
    }
    // Each lean takes 0.6 s: furthest right 0.15 s into it, furthest left 0.45 s into it. Three times.
    for (const start of [0.4, 1.0, 1.6]) {
      const right = Math.round((start + 0.15) * 30);
      const left = Math.round((start + 0.45) * 30);
      expect(await bright(built.file, right, RIGHT_OF_BAR), `right at frame ${right}`).toBeGreaterThan(80);
      expect(await bright(built.file, right, LEFT_OF_BAR), `right at frame ${right}`).toBeLessThan(40);
      expect(await bright(built.file, left, LEFT_OF_BAR), `left at frame ${left}`).toBeGreaterThan(80);
      expect(await bright(built.file, left, RIGHT_OF_BAR), `left at frame ${left}`).toBeLessThan(40);
    }
    // The logo has no dark square around it, and the card around it is the colour it has when
    // nothing moves: the same patch of the same picture, measured in both videos. This is a
    // coarse guard only. The fault it is here for (the stripes three levels of blue away, see
    // docs/decisions.md) was found by comparing frames before video compression, and this check
    // did not catch it when the first way of laying the logo on was put back.
    const colour = async (file, frame, part) => {
      const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', file, '-an', '-vf', `select='eq(n,${frame})',crop=${part},signalstats,metadata=print`, '-frames:v', '1', '-f', 'null', '-']);
      return ['YAVG', 'UAVG', 'VAVG'].map((key) => Number(new RegExp(`${key}=([\\d.]+)`).exec(stderr)[1]));
    };
    // Beside the bar inside the logo's square, a lighter stripe, a darker one, and a wide piece across several.
    for (const part of ['40:40:250:600', '60:60:30:450', '60:60:150:450', '600:200:1000:200']) {
      const [moving, still] = [await colour(built.file, 16, part), await colour(plain.file, 16, part)];
      moving.forEach((value, i) => expect(Math.abs(value - still[i]), `${part}: ${moving} against ${still}`).toBeLessThan(0.6));
    }
    // Nothing changed, so nothing is made again.
    expect((await make()).items[0].reused).toBe(true);

    // With a sound under the card, as the owner's cards have, it leans the same and the card is as long as its sound.
    const wavs = path.join(dir, 'swing-wavs');
    await mkdir(wavs, { recursive: true });
    await ff(['-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000', '-t', '4', path.join(wavs, 'goal.wav')]);
    const sounded = await make([{ ...card, seconds: undefined }], { soundsDir: wavs });
    expect(Math.abs(sounded.items[0].seconds - 4)).toBeLessThan(0.05);
    expect(await bright(sounded.file, 17, RIGHT_OF_BAR)).toBeGreaterThan(80);
    expect(await bright(sounded.file, 26, LEFT_OF_BAR)).toBeGreaterThan(80);
    expect(await bright(sounded.file, 100, ON_BAR)).toBeGreaterThan(200);
    expect(await level(sounded.file, 0.5, 3)).toBeGreaterThan(-40);

    // Pieces older than the card's picture were saved for another drawing of the card (a page from
    // before the pieces existed saved the card since): the card is shown still, with the picture it has now.
    await saveCardPng(dataDir, 'm2', 'goal', 'landscape', navy);
    const stale = await make();
    expect(stale.items[0].reused).toBe(false);
    for (const frame of [3, 16, 25]) expect(await bright(stale.file, frame, ON_BAR)).toBeLessThan(40);

    // Saving the match keeps the pieces with the card, and drops them with it.
    await saveMatch(dataDir, { ...match, id: 'm2' });
    expect((await readdir(path.join(dataDir, 'matches', 'm2', 'cards'))).sort()).toEqual(['goal-landscape-logo.png', 'goal-landscape-still.png', 'goal-landscape.png']);
    await saveMatch(dataDir, { ...match, id: 'm2', cards: [] });
    expect(await readdir(path.join(dataDir, 'matches', 'm2', 'cards'))).toEqual([]);
  }, 240_000);

  it('plays no video behind a card any more: a card saved with one says to choose another sound', async () => {
    const soundsDir = path.join(dir, 'video-sounds');
    await mkdir(soundsDir, { recursive: true });
    // A video with sound, as the intro once had, and a music file that carries a cover picture.
    await ff(['-f', 'lavfi', '-i', 'color=c=black:s=960x540:r=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(soundsDir, 'goal.mp4')]);
    await ff(['-f', 'lavfi', '-i', 'sine=frequency=440', '-i', path.join(dir, 'landscape.png'), '-t', '1', '-map', '0:a', '-map', '1:v', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic', path.join(soundsDir, 'song.mp3')]);

    // A video in the sounds folder is not a sound: it is not offered, and it is not the "auto" sound of its kind.
    expect(await listSoundFiles(soundsDir)).toEqual(['song.mp3']);
    expect((await automaticSounds(soundsDir)).goal).toBe('none');
    // A compilation saved while a video could be chosen still opens, and making it says what to do.
    const card = { id: 'i1', kind: 'card', matchId: 'm1', cardId: 'goal' };
    const saved = timeline({ id: 'over-video', items: [{ ...card, sound: 'file:goal.mp4' }] });
    expect(saved.items[0].sound).toBe('file:goal.mp4');
    await expect(buildCompilation({ timeline: saved, dataDir, resolveVideo, soundsDir })).rejects.toThrow(/Item 1: its sound "goal.mp4" is a video, and a video behind a card was removed\. Choose another sound/);

    // A music file with a cover picture is a sound and nothing more: the card is as long as the song and plays it.
    expect(Math.abs((await soundSeconds(path.join(soundsDir, 'song.mp3'))) - 1)).toBeLessThan(0.1);
    const song = await buildCompilation({ timeline: timeline({ id: 'over-video', items: [{ ...card, sound: 'file:song.mp3' }] }), dataDir, resolveVideo, soundsDir });
    expect(Math.abs(song.items[0].seconds - 1)).toBeLessThan(0.1);
    expect(await level(song.file, 0.1, 0.8)).toBeGreaterThan(-40);
    const final = await probe(song.file);
    expect([final.width, final.height, final.fps]).toEqual([1920, 1080, 30]);
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
    // The three sounds the tool once made are gone (2026-11-24); a card saved with one says so.
    await expect(card('builtin:tragic')).rejects.toThrow(/Item 1: its sound "tragic" was one the tool made, and those were removed\. Choose another sound/);
    // Without a sounds folder a file is refused.
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
  it('has no sound of its own: every kind of card is silent until the owner gives it a file', async () => {
    expect(CARD_KINDS).toEqual(['goal', 'red', 'fulltime']);
    for (const cardType of CARD_KINDS) {
      expect(await resolveSound({ choice: 'auto', cardType, soundsDir: path.join(dir, 'no-such-folder') })).toBeNull();
      expect(await resolveSound({ choice: 'none', cardType })).toBeNull();
    }
    await expect(resolveSound({ choice: 'builtin:goal', cardType: 'goal' })).rejects.toThrow(/was one the tool made, and those were removed/);
    // A video was once a card's sound and its moving background; that was removed too, and says so.
    await expect(resolveSound({ choice: 'file:intro.mp4', cardType: 'goal', soundsDir: dir })).rejects.toThrow(/is a video, and a video behind a card was removed/);
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
    // A video does not count any more: it once gave a card its sound and a moving background.
    expect(await listSoundFiles(folder)).toEqual(['A.wav', 'b.mp3']);
    expect(await listSoundFiles(path.join(dir, 'no-such-folder'))).toEqual([]);
    expect(await listSoundFiles(undefined)).toEqual([]);
  });
});

describe('description', () => {
  const items = [
    { kind: 'video', seconds: 12.4, credit: 'Ana' },
    { kind: 'card', seconds: 3, title: 'HOM 1-0 AWY' },
    { kind: 'video', seconds: 50, credit: 'ana' },
    { kind: 'video', seconds: 4000, credit: 'Ben' },
    { kind: 'card', seconds: 3, title: 'FULL TIME HOM 1-0 AWY' },
  ];

  it('writes the whole text for under the video: chapters, fan channels, goal footage, the call to action, and the owner\'s last lines', () => {
    const post = {
      title: 'A TITLE | MATCH REACTIONS', fanText: 'Subscribe to them.', footageText: 'Tell me if it is yours.', footage: ' https://www.youtube.com/@goals \n\n@other ',
      callToAction: 'Like for more!', keywords: 'One, Two and more.', hashtags: '#Home #Away', music: 'Music by Somebody',
    };
    expect(buildDescription(items, { ana: 'https://www.youtube.com/@ana' }, post)).toBe([
      // A chapter starts at each card; the video does not open with one, so one is added at 00:00.
      'TIMESTAMP', '00:00 START', '00:12 HOM 1-0 AWY', '1:07:45 FULL TIME HOM 1-0 AWY', '',
      // Each streamer once, in the order they first appear: a channel as its address, anyone else by name.
      '----------------', 'FAN CHANNELS IN THE VIDEO 🎥', 'Subscribe to them.', '', 'https://www.youtube.com/@ana', 'Ben', '',
      '----------------', 'SOURCE GOAL FOOTAGE 🎥', 'Tell me if it is yours.', '', 'https://www.youtube.com/@goals', '@other', '',
      '----------------', 'Like for more!', 'A TITLE | MATCH REACTIONS', '',
      '----------------', 'One, Two and more.', '', '#Home #Away', '', 'Music by Somebody', '',
    ].join('\n'));
  });

  it('leaves out every part that has nothing in it, and starts from neutral sentences of its own', () => {
    // With nothing typed: the chapters, the channels under the standing sentence, the call to action.
    expect(buildDescription(items)).toBe([
      'TIMESTAMP', '00:00 START', '00:12 HOM 1-0 AWY', '1:07:45 FULL TIME HOM 1-0 AWY', '',
      '----------------', 'FAN CHANNELS IN THE VIDEO 🎥', DEFAULT_POST.fanText, '', 'Ana', 'Ben', '',
      '----------------', DEFAULT_POST.callToAction, '',
    ].join('\n'));
    // The standing text names nobody: no title, no footage, no keywords, no hashtags, no music.
    expect([DEFAULT_POST.title, DEFAULT_POST.footage, DEFAULT_POST.keywords, DEFAULT_POST.hashtags, DEFAULT_POST.music]).toEqual(['', '', '', '', '']);
    // Before the video is made there are no chapter times, and the channels come from the timeline as it stands.
    expect(buildDescription([], {}, { callToAction: '' }, ['Cara'])).toBe(`FAN CHANNELS IN THE VIDEO 🎥\n${DEFAULT_POST.fanText}\n\nCara\n`);
    // After the timeline changes, the channels are the timeline's and the times are still the made video's.
    expect(buildDescription(items, {}, { callToAction: '' }, ['Cara']).split('\n').slice(0, 9)).toEqual(['TIMESTAMP', '00:00 START', '00:12 HOM 1-0 AWY', '1:07:45 FULL TIME HOM 1-0 AWY', '', '----------------', 'FAN CHANNELS IN THE VIDEO 🎥', DEFAULT_POST.fanText, '']);
    expect(buildDescription([], {}, { callToAction: '', fanText: '' })).toBe('');
    // Goal footage sources are only ever typed: with none, their sentence is not written either.
    expect(buildDescription([], {}, { callToAction: '', footageText: 'Tell me.' })).toBe('');
  });

  it('writes chapter times and card titles, with a team\'s short name only when the owner gave one', () => {
    expect([chapterTime(0), chapterTime(59.9), chapterTime(61), chapterTime(3723)]).toEqual(['00:00', '00:59', '01:01', '1:02:03']);
    const goal = match.cards[0];
    const red = { type: 'red', team: 'away', player: 'Martínez', minute: 67, added: null, redType: 'second-yellow' };
    expect(cardTitle(match, goal)).toBe('FC Barcelona 1-0 Manchester United');
    expect(cardTitle(match, red)).toBe("RED CARD Martínez (Manchester United, 67', second yellow)");
    expect(cardTitle(match, match.cards[1])).toBe('FULL TIME FC Barcelona 1-0 Manchester United');
    expect(cardTitle(match, { ...goal, goalType: 'penalty-miss', team: 'away', scorer: 'Fernandes', minute: 70, added: null }))
      .toBe("PENALTY MISSED Fernandes (Manchester United, 70'), FC Barcelona 1-0 Manchester United");
    const short = { ...match, short: { home: 'BAR', away: ' ' } };
    expect(cardTitle(short, { ...goal, homeScore: 2, awayScore: 1 })).toBe('BAR 2-1 Manchester United');
    expect(cardTitle({ ...match, short: { home: 'BAR', away: 'MUN' } }, red)).toBe("RED CARD Martínez (MUN, 67', second yellow)");
  });

  it('says when YouTube would not show the chapters: fewer than three, or one under ten seconds', () => {
    const chapters = chaptersOf(items);
    expect(chapters.map((chapter) => [Math.round(chapter.at), chapter.title, Math.round(chapter.seconds)])).toEqual([[0, 'START', 12], [12, 'HOM 1-0 AWY', 4053], [4065, 'FULL TIME HOM 1-0 AWY', 3]]);
    // The full-time card ends the video, so its chapter is three seconds long.
    expect(chapterProblem(chapters)).toMatch(/each lasts at least 10 seconds; "FULL TIME HOM 1-0 AWY" lasts 3/);
    expect(chapterProblem(chaptersOf([...items, { kind: 'video', seconds: 30, credit: '' }]))).toBe('');
    expect(chapterProblem(chaptersOf(items.slice(0, 3)))).toMatch(/at least 3; this video has 2/);
    // A video that opens with a card has its first chapter there, with no "START".
    expect(chaptersOf(items.slice(1)).map((chapter) => chapter.title)).toEqual(['HOM 1-0 AWY', 'FULL TIME HOM 1-0 AWY']);
  });

  it('works hashtags out from the match, and counts them', () => {
    const tags = suggestHashtags({ home: 'FC Barcelona', away: 'Real Madrid', competition: 'La Liga' });
    expect(tags).toBe('#FCBarcelona #RealMadrid #LaLiga #FCBarcelonaVsRealMadrid #FanReactions #FootballFans #MatchReactions #Football #FCBarcelonaFans #RealMadridFans');
    for (const tag of tags.split(' ')) expect(tag).toMatch(/^#[\p{L}\p{N}]+$/u);
    expect(countHashtags(tags)).toBe(10);
    expect(suggestHashtags({ home: 'A', away: 'B' })).toBe('#A #B #AVsB #FanReactions #FootballFans #MatchReactions #Football #AFans #BFans');
    expect(suggestHashtags({ home: '', away: '', competition: '' })).toBe('#FanReactions #FootballFans #MatchReactions #Football');
    expect([countHashtags(''), countHashtags(undefined), countHashtags('no tags, 1 # alone'), countHashtags('#one\n#two #Երեք3')]).toEqual([0, 0, 0, 3]);
  });

  it('works tags for the upload form out from the match, within what YouTube takes', () => {
    const game = { home: 'Real Madrid', away: 'PSV Eindhoven', competition: 'Champions League' };
    const tags = suggestTags(game, { home: 5, away: 1 }, ['Streamer One', 'Another, "Channel"']);
    // Plain words in lower case, the fixture first, each once.
    expect(tags.slice(0, 3)).toEqual(['real madrid vs psv eindhoven', 'psv eindhoven vs real madrid', 'real madrid 5-1 psv eindhoven']);
    expect(tags).toEqual(expect.arrayContaining(['real madrid fans', 'psv eindhoven fan reactions', 'champions league', 'fan reactions', 'watchalong']));
    expect(new Set(tags).size).toBe(tags.length);
    for (const tag of tags) expect(tag).toMatch(/^[^,<>"A-Z]+$/);
    // YouTube counts the commas, and two more characters for each tag with a space in it: 500 in all.
    expect(tagsLength('Foo-Baz')).toBe(7);
    expect(tagsLength('Foo Baz')).toBe(9);
    expect(tagsLength('one, two words,three')).toBe(3 + 1 + 11 + 1 + 5);
    expect(tagsLength(tags.join(', '))).toBeLessThanOrEqual(MAX_TAGS_LENGTH);
    // The list stops before it would pass that, the general ones and the streamers going first.
    const long = suggestTags({ home: 'Borussia Mönchengladbach', away: 'Wolverhampton Wanderers', competition: 'UEFA Europa Conference League' }, { home: 2, away: 2 }, ['Somebody']);
    expect(tagsLength(long.join(', '))).toBeLessThanOrEqual(MAX_TAGS_LENGTH);
    expect(long[0]).toBe('borussia mönchengladbach vs wolverhampton wanderers');
    expect(long).not.toContain('somebody');
    // With little room taken, the streamers are tags too, without the commas and quotes a name may hold.
    const few = suggestTags({ home: 'A', away: 'B' }, null, ['Streamer One', 'Another, "Channel"']);
    expect(few).toEqual(expect.arrayContaining(['a vs b', 'streamer one', 'another channel']));
    expect(few.join(' ')).not.toMatch(/\d-\d/);
    // A typed box is read by its commas and line ends, each tag once whatever its capitals.
    expect(tagsOf(' One, two words ,\none,, THREE ')).toEqual(['One', 'two words', 'THREE']);
    expect([tagsOf(''), tagsOf(undefined), tagsLength('')]).toEqual([[], [], 0]);
    // Tags are for their own box of the upload form: they are not written into the description.
    expect(buildDescription([], {}, { callToAction: 'Like!', tags: 'one, two' })).toBe('Like!\n');
  });

  it('offers title ideas that are true to the score', () => {
    const game = { home: 'Barcelona', away: 'Real Madrid' };
    const all = (score) => titleIdeas(game, score).join('\n');
    for (const score of [{ home: 5, away: 0 }, { home: 2, away: 1 }, { home: 0, away: 2 }, { home: 1, away: 1 }, { home: 0, away: 0 }, null]) {
      const ideas = titleIdeas(game, score);
      expect(ideas.length).toBeGreaterThanOrEqual(2);
      for (const idea of ideas) {
        expect(idea.length, idea).toBeLessThanOrEqual(100);
        expect(idea, idea).toMatch(/BARCELONA|Barcelona/);
        // The score is in every idea, written home first or winner first.
        if (score) expect(idea.includes(`${score.home}-${score.away}`) || idea.includes(`${Math.max(score.home, score.away)}-${Math.min(score.home, score.away)}`), idea).toBe(true);
      }
    }
    // Only a heavy defeat is a thrashing; a draw has no winner, loser, or anybody destroyed.
    expect(all({ home: 5, away: 0 })).toMatch(/REAL MADRID FANS SHOCKED .* 5-0 THRASHING BY BARCELONA/);
    expect(all({ home: 0, away: 4 })).toMatch(/BARCELONA FANS SHOCKED .* 4-0 THRASHING BY REAL MADRID/);
    for (const score of [{ home: 2, away: 1 }, { home: 3, away: 1 }, { home: 1, away: 1 }, { home: 0, away: 0 }]) expect(all(score)).not.toMatch(/THRASHING|DESTROY|HUMILIAT/);
    for (const score of [{ home: 1, away: 1 }, { home: 0, away: 0 }]) expect(all(score)).not.toMatch(/GUTTED|HEARTBROKEN|FURIOUS|WIN OVER|EDGE IT/);
    expect(all({ home: 0, away: 0 })).not.toMatch(/GOAL/);
    // With no score yet, none is written.
    expect(all(null)).not.toMatch(/\d-\d/);
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
