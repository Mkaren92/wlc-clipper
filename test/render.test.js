// The command a clip is made with: on the processor as it always was, or on an NVIDIA card
// (2026-11-23), which changes only how the picture is encoded.
import { describe, expect, it } from 'vitest';
import { clipEncoder, renderArgs } from '../src/render.js';

const job = { source: '/videos/a.mp4', start: 12, seconds: 30, graph: '[0:v]fps=30[v]' };

describe('how a clip is encoded', () => {
  it('uses the processor unless the card is asked for, with the same command as before', () => {
    expect(renderArgs(job)).toEqual([
      '-hide_banner', '-loglevel', 'error', '-y', '-ss', '12.000', '-t', '30.000', '-i', '/videos/a.mp4',
      '-filter_complex', '[0:v]fps=30[v]', '-map', '[v]', '-map', '0:a:0?', '-t', '30.000',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', 'clip.partial.mp4',
    ]);
  });

  it('on the card, changes only the picture settings, and never uses -r', () => {
    const cpu = renderArgs(job);
    const card = renderArgs({ ...job, encoder: 'nvenc' });
    const picture = (args) => args.slice(args.indexOf('-c:v'), args.indexOf('-c:a'));
    expect(picture(card)).toEqual(['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', '19', '-b:v', '0', '-profile:v', 'high', '-pix_fmt', 'yuv420p']);
    const without = (args) => args.filter((arg) => !picture(args).includes(arg));
    expect(without(card)).toEqual(without(cpu));
    expect(card).not.toContain('-r');
  });

  it('keeps the card out when CLIPPER_ENCODER is "cpu"', async () => {
    const before = process.env.CLIPPER_ENCODER;
    process.env.CLIPPER_ENCODER = 'cpu';
    try {
      expect(await clipEncoder()).toBe('cpu');
    } finally {
      if (before === undefined) delete process.env.CLIPPER_ENCODER;
      else process.env.CLIPPER_ENCODER = before;
    }
  });
});
