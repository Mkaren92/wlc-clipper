// Plain parts of a video, cut with the real ffmpeg.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { partName, savePart } from '../src/part.js';
import { probe } from '../src/probe.js';
import { run } from '../src/run.js';

let dir;
let source;
// A white flash and a beep, both 2 seconds in. The source has two audio
// tracks and a keyframe only every 5 seconds, so a part that starts at 1.3 s
// cannot begin on a keyframe.
const SIGNAL_AT = 2;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'clipper-part-'));
  source = path.join(dir, 'My Game.mp4');
  const flash = `drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='between(t,${SIGNAL_AT},${SIGNAL_AT + 0.0999})'`;
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=1280x720:r=60,${flash}`,
    '-f', 'lavfi', '-i', `aevalsrc='if(between(t,${SIGNAL_AT},${SIGNAL_AT + 0.1}),sin(2*PI*1000*t),0)':s=48000`,
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000',
    '-t', '6', '-map', '0:v', '-map', '1:a', '-map', '2:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '300', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    source,
  ]);
}, 60_000);

afterAll(() => rm(dir, { recursive: true, force: true }));

async function firstBrightFrame(file) {
  const { stderr } = await run('ffmpeg', [
    '-hide_banner', '-i', file, '-an', '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-',
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

async function firstSound(file) {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', file, '-vn', '-map', '0:a:0', '-af', 'silencedetect=n=-40dB:d=0.05', '-f', 'null', '-']);
  const match = /silence_end: ([\d.]+)/.exec(stderr);
  return match ? Number(match[1]) : null;
}

describe('savePart', () => {
  it('keeps the size, frame rate and audio tracks, and starts exactly where asked', async () => {
    const outDir = path.join(dir, 'parts');
    const part = await savePart({ source, start: 1.3, end: 4.3, outDir });

    expect(part).toMatchObject({ name: 'my-game_0m01.3s-0m04.3s.mp4', width: 1280, height: 720, fps: 60 });
    expect(Math.abs(part.seconds - 3)).toBeLessThan(0.1);
    const info = await probe(part.file);
    expect([info.width, info.height, info.fps, info.audioStreams]).toEqual([1280, 720, 60, 2]);

    // The flash and the beep land where the source had them, to within a frame.
    const expected = SIGNAL_AT - 1.3;
    expect(Math.abs((await firstBrightFrame(part.file)) - expected)).toBeLessThan(1 / 30);
    expect(Math.abs((await firstSound(part.file)) - expected)).toBeLessThan(1 / 30);

    // One finished file, and nothing left over from writing it.
    expect(await readdir(outDir)).toEqual(['my-game_0m01.3s-0m04.3s.mp4']);
  }, 120_000);

  it('does not overwrite a part with the same range', async () => {
    const outDir = path.join(dir, 'parts-twice');
    const first = await savePart({ source, start: 0, end: 1, outDir });
    const second = await savePart({ source, start: 0, end: 1, outDir });
    expect([first.name, second.name]).toEqual(['my-game_0m00s-0m01s.mp4', 'my-game_0m00s-0m01s_2.mp4']);
  }, 120_000);

  it('rejects a range past the end of the video', async () => {
    await expect(savePart({ source, start: 4, end: 30, outDir: dir })).rejects.toThrow(/only 0:06\.00 long/);
  });
});

describe('partName', () => {
  it.each([
    ['/videos/1.mp4', 60, 90, '1_1m00s-1m30s.mp4'],
    ['Stream Recording (final).mkv', 3723.5, 3780, 'stream-recording-final_1h02m03.5s-1h03m00s.mp4'],
    ['???.mp4', 0, 5, 'video_0m00s-0m05s.mp4'],
  ])('names a part of %j from %d to %d as %j', (file, start, end, name) => {
    expect(partName(file, start, end)).toBe(name);
  });
});
