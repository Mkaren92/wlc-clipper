import { copyFile, link, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { checkRange, clipSlug } from './cut.js';
import { probe } from './probe.js';
import { run } from './run.js';

/**
 * Save a part of a video as it is: the chosen time range at the original
 * size and frame rate, with every audio track, and nothing drawn on it. No
 * reframing, no hook, no captions, no transcription.
 *
 * All parts go into one folder, apart from the clips, as single files named
 * after the source and the range: `1_1m00s-1m30s.mp4`.
 *
 * @param {object} options
 * @param {string} options.source
 * @param {number} options.start
 * @param {number} options.end
 * @param {string} [options.outDir]
 * @returns {Promise<{ file: string, name: string, width: number, height: number, fps: number, seconds: number }>}
 */
export async function savePart({ source, start, end, outDir = './parts' }) {
  const sourcePath = path.resolve(source);
  const info = await probe(sourcePath);
  checkRange(start, end, info.duration);

  const dir = path.resolve(outDir);
  await mkdir(dir, { recursive: true });
  const name = freeName(await readdir(dir), partName(sourcePath, start, end));
  const file = path.join(dir, name);
  // Written under another name first, so a failed run leaves no broken file.
  const partial = path.join(dir, `.${name}.partial.mp4`);

  try {
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      // Both before -i, so exactly the wanted range is read (see render.js).
      '-ss', start.toFixed(3),
      '-t', (end - start).toFixed(3),
      '-i', sourcePath,
      '-map', '0:v:0',
      '-map', '0:a?',
      // The picture is encoded again, not copied: copying can only start at
      // a keyframe, which would begin the part up to several seconds early.
      // The scale step only rounds an odd width or height down to even,
      // which the encoder needs; it changes nothing else.
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      partial,
    ]);
    await rename(partial, file);
  } finally {
    await rm(partial, { force: true });
  }

  const result = await probe(file);
  return {
    file,
    name,
    width: result.width,
    height: result.height,
    fps: result.fps,
    seconds: Math.round(result.duration * 1000) / 1000,
  };
}

/**
 * The file name for a part: the source's name and the range, for example
 * `1_1m00s-1m30s.mp4`.
 *
 * @param {string} source
 * @param {number} start
 * @param {number} end
 */
export function partName(source, start, end) {
  const base = clipSlug(path.basename(source, path.extname(source))) || 'video';
  return `${base}_${rangeStamp(start)}-${rangeStamp(end)}.mp4`;
}

/** Seconds as a compact time for a file name: 1m00s, 1m02.5s, 1h02m03s. */
export function rangeStamp(seconds) {
  const tenths = Math.round(seconds * 10);
  const s = (tenths % 600) / 10;
  const m = Math.floor(tenths / 600) % 60;
  const h = Math.floor(tenths / 36000);
  const two = (n) => (n < 10 ? `0${n}` : String(n));
  return `${h > 0 ? `${h}h${two(m)}` : m}m${two(s)}s`;
}

/** `name`, or `name_2`, `name_3`... if a file of that name is already there. */
function freeName(taken, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, -ext.length);
  let free = name;
  for (let n = 2; taken.includes(free); n++) free = `${stem}_${n}${ext}`;
  return free;
}

/**
 * Make a part one of the videos, so clips can be cut from it like from any video
 * (asked for on 2026-11-23). The part stays where it is: the video is a second name
 * for the same file (a hard link), so it takes no more room and a compilation that
 * uses the part keeps working; deleting either leaves the other. Where a link
 * cannot be made (another disk), it is copied.
 *
 * @param {{ partsDir: string, inDir: string, name: string }} options   `name`: a part's plain file name
 * @returns {Promise<{ video: string, linked: boolean, already: boolean }>}
 *   `video`: its name among the videos; `already`: it was there before
 */
export async function partToVideo({ partsDir, inDir, name }) {
  if (typeof name !== 'string' || name !== path.basename(name) || name.startsWith('.') || path.extname(name).toLowerCase() !== '.mp4') {
    throw new Error('No such part.');
  }
  const part = path.join(partsDir, name);
  const partInfo = await stat(part).catch(() => null);
  if (!partInfo?.isFile()) throw new Error('No such part.');
  await mkdir(inDir, { recursive: true });

  // The same name if it is free, or if it is already this very file; else a number is added.
  const base = name.slice(0, -4);
  for (let n = 1; ; n++) {
    const video = n === 1 ? name : `${base}_${n}.mp4`;
    const target = path.join(inDir, video);
    const there = await stat(target).catch(() => null);
    if (there) {
      if (there.ino === partInfo.ino && there.dev === partInfo.dev) return { video, linked: true, already: true };
      continue;
    }
    try {
      await link(part, target);
      return { video, linked: true, already: false };
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      // Another disk, or a file system without links: a copy, written under a hidden name first.
      const partial = path.join(inDir, `.${video}.partial`);
      try {
        await copyFile(part, partial);
        await rename(partial, target);
      } catch (copyError) {
        await rm(partial, { force: true });
        throw copyError;
      }
      return { video, linked: false, already: false };
    }
  }
}
