import { access } from 'node:fs/promises';
import { run } from './run.js';

/** @typedef {import('./types.js').VideoInfo} VideoInfo */

/**
 * Read the facts the pipeline needs from a video file.
 *
 * @param {string} file
 * @returns {Promise<VideoInfo>}
 */
export async function probe(file) {
  try {
    await access(file);
  } catch {
    throw new Error(`Cannot read ${file}. Check the path.`);
  }

  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    file,
  ]);
  return readProbeJson(file, JSON.parse(stdout));
}

/**
 * Turn ffprobe's JSON into a VideoInfo. Kept separate from `probe` so it can
 * be tested without a video file.
 *
 * @param {string} file
 * @param {{ streams?: any[], format?: any }} data
 * @returns {VideoInfo}
 */
export function readProbeJson(file, data) {
  const streams = data.streams ?? [];
  // Cover art in audio files is reported as a video stream; skip it.
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!video) throw new Error(`${file} has no video stream.`);

  const duration = Number(data.format?.duration ?? video.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`ffprobe could not tell how long ${file} is.`);
  }

  // Phone footage is often stored sideways with a rotation flag. ffmpeg turns
  // it upright before filtering, so report the size the filters will see.
  const sideways = Math.abs(readRotation(video)) % 180 === 90;
  const width = sideways ? video.height : video.width;
  const height = sideways ? video.width : video.height;

  return {
    path: file,
    width,
    height,
    fps: readRate(video.avg_frame_rate) || readRate(video.r_frame_rate),
    duration,
    audioStreams: streams.filter((s) => s.codec_type === 'audio').length,
    isVertical: height > width,
  };
}

function readRotation(stream) {
  const fromSideData = (stream.side_data_list ?? []).find((d) => d.rotation !== undefined);
  return Number(fromSideData?.rotation ?? stream.tags?.rotate ?? 0) || 0;
}

/** ffprobe gives rates as a fraction, such as "30000/1001". */
function readRate(text) {
  const [top, bottom = '1'] = String(text ?? '').split('/');
  const rate = Number(top) / Number(bottom);
  return Number.isFinite(rate) ? Math.round(rate * 1000) / 1000 : 0;
}
