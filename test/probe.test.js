import { describe, expect, it } from 'vitest';
import { readProbeJson } from '../src/probe.js';

const video = { codec_type: 'video', width: 1920, height: 1080, avg_frame_rate: '60/1' };
const audio = { codec_type: 'audio' };

describe('readProbeJson', () => {
  it('reads size, frame rate, duration and audio tracks', () => {
    const info = readProbeJson('a.mp4', { streams: [video, audio, audio], format: { duration: '40.000000' } });
    expect(info).toEqual({
      path: 'a.mp4',
      width: 1920,
      height: 1080,
      fps: 60,
      duration: 40,
      audioStreams: 2,
      isVertical: false,
    });
  });

  it('reads fractional frame rates', () => {
    const stream = { ...video, avg_frame_rate: '30000/1001' };
    expect(readProbeJson('a.mp4', { streams: [stream], format: { duration: '1' } }).fps).toBe(29.97);
  });

  it('swaps width and height for footage stored sideways', () => {
    const rotated = { ...video, side_data_list: [{ rotation: -90 }] };
    const info = readProbeJson('a.mp4', { streams: [rotated], format: { duration: '1' } });
    expect([info.width, info.height, info.isVertical]).toEqual([1080, 1920, true]);
  });

  it('ignores cover art and rejects a file with no video', () => {
    const cover = { ...video, disposition: { attached_pic: 1 } };
    expect(() => readProbeJson('a.mp3', { streams: [cover, audio], format: { duration: '1' } })).toThrow(
      /no video stream/,
    );
  });
});
