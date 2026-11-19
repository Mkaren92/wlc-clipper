// The compilation builder, with the real ffmpeg. These are the request's
// acceptance checks: unlike clips and cards joined into one file that plays
// in sync, at the right length, with a description beside it.
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveCardPng, saveMatch } from '../src/cards/match.js';
import { buildCompilation, creditSubtitles } from '../src/compilation/build.js';
import { buildDescription, cardTitle, chapterTime } from '../src/compilation/description.js';
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

    // The flash and beep are 1.5 s into the last clip, which starts 0.5 s in and follows 10 s of other items.
    const flash = await flashAt(built.file, 9);
    const beep = await soundAt(built.file, 9);
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
});

describe('saved compilations', () => {
  it('saves, lists, reads and deletes a timeline', async () => {
    const saved = await saveTimeline(dataDir, { id: 'kept', name: 'Kept', items: [{ id: 'a', kind: 'card', matchId: 'm1', cardId: 'goal' }] });
    expect(saved).toMatchObject({ preset: 'landscape', items: [{ seconds: 3 }] });
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
  });
});
