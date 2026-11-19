// Brings part of a video into the videos folder from a YouTube link.
//
// This is the one place the tool takes anything from outside, and it is
// narrow on purpose: YouTube links only, a time range and not a whole
// video, and only from a channel the owner has marked as agreed in the
// sources list.
import { access, mkdir, readdir, rename, rm, statfs } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clipSlug } from './cut.js';
import { rangeStamp } from './part.js';
import { probe } from './probe.js';
import { run } from './run.js';
import { agreedSourceOf } from './sources.js';
import { formatClock } from './time.js';

/** @typedef {import('./sources.js').Source} Source */

/**
 * The program that talks to YouTube. Tests pass a stand-in.
 *
 * @typedef {object} Downloader
 * @property {() => Promise<boolean>} isInstalled
 * @property {(url: string) => Promise<{ id: string, title: string, channel: string, channelId: string, handle: string, duration: number }>} info
 * @property {(job: { url: string, start: number, end: number, dir: string, name: string }) => Promise<void>} download
 *   writes `<dir>/<name>.mp4`
 */

// Long enough for any goal reaction, short enough that a slip cannot fill the disk.
export const MAX_FETCH_SECONDS = 20 * 60;
// Room allowed per second of video at up to 1080p, for the free-space check.
const BYTES_PER_SECOND = 1_500_000;

/**
 * Check a link and return the plain address of the one video it points to.
 * A playlist or channel link is refused.
 *
 * @param {string} text
 * @returns {string}
 */
export function videoUrl(text) {
  const problem = () => new Error('Give a link to one YouTube video, such as https://www.youtube.com/watch?v=...');
  let url;
  try {
    url = new URL(String(text).trim());
  } catch {
    throw problem();
  }
  if (url.protocol !== 'https:') throw problem();
  let id = null;
  if (url.hostname === 'youtu.be') id = url.pathname.slice(1);
  else if (['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(url.hostname)) {
    id = url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(?:live|shorts)\/([^/]+)\/?$/.exec(url.pathname)?.[1] ?? null;
  }
  if (!id || !/^[\w-]{11}$/.test(id)) throw problem();
  return `https://www.youtube.com/watch?v=${id}`;
}

/**
 * Fetch a time range of a video into `outDir`.
 *
 * @param {object} options
 * @param {string} options.url
 * @param {number} options.start    seconds into the video
 * @param {number} options.end
 * @param {Source[]} options.sources
 * @param {string} options.outDir   the videos folder
 * @param {Downloader} [options.downloader]
 * @param {(step: string) => void} [options.onStep]
 * @returns {Promise<{ name: string, file: string, seconds: number, early: number, source: Source, title: string }>}
 *   `early` is how many seconds before the asked start the file begins
 */
export async function fetchVideo({ url, start, end, sources, outDir, downloader = ytDlp(), onStep = () => {} }) {
  const link = videoUrl(url);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    throw new Error('Give the start and the end of the part you want; the end must be after the start.');
  }
  if (end - start > MAX_FETCH_SECONDS) {
    throw new Error(`A fetch can be at most ${MAX_FETCH_SECONDS / 60} minutes long; this range is ${formatClock(end - start)}.`);
  }
  if (!(await downloader.isInstalled())) {
    throw new Error('The downloader is not installed. Run "npm run setup" to install it.');
  }

  onStep('looking');
  const video = await downloader.info(link);
  // The channel is read from the video itself, so a link cannot claim to be someone else's.
  const source = agreedSourceOf(sources, video);
  if (!source) {
    throw new Error(`This video is from "${video.channel}", which is not marked as agreed in your sources list. Only channels that have agreed can be fetched from.`);
  }
  if (video.duration && end > video.duration + 1) {
    throw new Error(`The video is only ${formatClock(video.duration)} long, but the end is set to ${formatClock(end)}.`);
  }

  const dir = path.resolve(outDir);
  await mkdir(dir, { recursive: true });
  const disk = await statfs(dir).catch(() => null);
  const needed = (end - start) * BYTES_PER_SECOND + 200_000_000;
  if (disk && disk.bavail * disk.bsize < needed) {
    throw new Error(`There may not be enough free disk space for this: about ${(needed / 1e9).toFixed(1)} GB is needed.`);
  }

  // Named by the tool from the channel, the video's id and the range. The id
  // is the one checked in the link, not the one the downloader reports.
  const id = new URL(link).searchParams.get('v');
  const base = `${filePrefix(source.name)}_${id}_${rangeStamp(start)}-${rangeStamp(end)}`;
  const taken = await readdir(dir);
  let name = base;
  for (let n = 2; taken.includes(`${name}.mp4`); n++) name = `${base}_${n}`;

  onStep('fetching');
  await downloader.download({ url: link, start, end, dir, name });
  const file = path.join(dir, `${name}.mp4`);
  await access(file).catch(() => {
    throw new Error('The download finished but no video file was written. Try again.');
  });
  onStep('tidying');
  // A part that cannot be put right is not left among the videos.
  const early = await removeHiddenLeadIn(file).catch(async () => {
    await rm(file, { force: true });
    throw new Error('The downloaded video could not be prepared, so it was not kept. Try again.');
  });
  const made = await probe(file);
  return { name: `${name}.mp4`, file, seconds: made.duration, early, source, title: video.title };
}

/**
 * What a fetched file's name starts with, made from the channel's name. The
 * compilation page uses it to fill in the credit of a fetched video.
 *
 * @param {string} channelName
 */
export function filePrefix(channelName) {
  return clipSlug(channelName) || 'video';
}

// A lead-in shorter than this is the ordinary start-up of a sound encoder, which every player handles.
const ORDINARY_LEAD_IN = 0.1;

/**
 * How much of a stream is hidden before its marked start. The same packet is
 * read twice, once as the file asks to be played and once from the very first
 * packet; the difference between the two times is the lead-in.
 *
 * @param {string} file
 * @param {'v:0' | 'a:0'} stream
 * @returns {Promise<{ lead: number, rawStart: number } | null>} null when the file has no such stream
 */
export async function leadInOf(file, stream) {
  const packets = async (options) => {
    const { stdout } = await run('ffprobe', ['-v', 'error', ...options, '-select_streams', stream, '-show_entries', 'packet=pts_time,pos', '-of', 'json', file]);
    return (JSON.parse(stdout).packets ?? []).filter((packet) => Number.isFinite(Number(packet.pts_time)) && packet.pos !== undefined);
  };
  const [marked] = await packets(['-read_intervals', '%+#1']);
  if (!marked) return null;
  // The same packet is found by its place in the file. It is near the start, so the first minute is read first.
  let raw = await packets(['-ignore_editlist', '1', '-read_intervals', '%+60']);
  let same = raw.find((packet) => packet.pos === marked.pos);
  if (!same) {
    raw = await packets(['-ignore_editlist', '1']);
    same = raw.find((packet) => packet.pos === marked.pos);
  }
  if (!same) throw new Error('The downloaded video could not be read. Try again.');
  return { lead: Number(same.pts_time) - Number(marked.pts_time), rawStart: Math.min(...raw.slice(0, 50).map((packet) => Number(packet.pts_time))) };
}

/**
 * Rewrite a downloaded part so that nothing in it is hidden.
 *
 * A part cut without encoding again begins at the picture's last keyframe
 * before the asked start, and the sound begins somewhere else again. The file
 * marks both lead-ins as "skip this", and players disagree about how to do
 * that: the fetched file this was found on had 2.97 s of picture and 4.98 s of
 * sound hidden, and played with the sound almost 3 s away from the picture.
 *
 * So the lead-in is made ordinary video instead. The picture is copied as it
 * is, from its first frame, and the sound is cut or padded to begin at that
 * same instant. The file then starts a little before the asked time and plays
 * the same everywhere.
 *
 * @param {string} file   rewritten in place
 * @returns {Promise<number>} seconds of picture now shown before the asked start
 */
export async function removeHiddenLeadIn(file) {
  const picture = await leadInOf(file, 'v:0');
  if (!picture) return 0;
  const sound = await leadInOf(file, 'a:0');
  // A video with B-frames has its first picture a frame or two after zero
  // even when nothing is hidden, so that offset is not counted as lead-in.
  const hidden = picture.lead - picture.rawStart;
  if (hidden < 0.001 && (!sound || sound.lead - sound.rawStart < ORDINARY_LEAD_IN)) return 0;

  // With the marks ignored, both streams are read from their first packet.
  // This is how far the sound has to move to line up with the picture read
  // that way: cut when positive, silence added when negative.
  const shift = sound ? sound.lead - picture.lead : 0;
  // Not a video's name, so the videos list never shows it.
  const partial = `${file}.partial`;
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ignore_editlist', '1', '-i', file,
    '-map', '0:v:0', '-c:v', 'copy',
    ...(sound ? [
      '-map', '0:a:0',
      '-af', `asetpts=PTS-(${shift.toFixed(6)})/TB,atrim=start=0,aresample=async=1:first_pts=0`,
      '-c:a', 'aac', '-b:a', '192k',
    ] : []),
    '-movflags', '+faststart', '-f', 'mp4', partial,
  ], { timeout: 30 * 60 * 1000 }).catch(async () => {
    await rm(partial, { force: true });
    throw new Error('The downloaded video could not be prepared. Try again.');
  });
  await rename(partial, file);
  return Math.max(0, hidden);
}

/**
 * The real downloader: yt-dlp, installed into the project's .venv by
 * `npm run setup`.
 *
 * @returns {Downloader}
 */
export function ytDlp() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const python = process.env.CLIPPER_PYTHON ?? path.join(root, '.venv', 'bin', 'python');
  const call = (args, options) => run(python, ['-m', 'yt_dlp', '--no-playlist', '--no-warnings', ...args], options);

  return {
    async isInstalled() {
      return call(['--version']).then(() => true, () => false);
    },
    async info(url) {
      // The link goes after "--", so it can never be read as an option.
      const { stdout } = await call(['--skip-download', '--dump-single-json', '--', url]).catch(() => {
        throw new Error('The video could not be looked up. Check the link, and that it is public.');
      });
      const data = JSON.parse(stdout);
      return {
        id: data.id, title: data.title ?? '', channel: data.channel ?? data.uploader ?? 'Unknown channel',
        channelId: data.channel_id ?? '', handle: data.uploader_id ?? '', duration: Number(data.duration) || 0,
      };
    },
    async download({ url, start, end, dir, name }) {
      await call([
        '--download-sections', `*${start}-${end}`,
        // At most 1080p, as an MP4 the rest of the tool reads.
        '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b',
        '--merge-output-format', 'mp4',
        '-P', dir,
        '-o', `${name}.%(ext)s`,
        '--', url,
      ], { timeout: 30 * 60 * 1000 }).catch(() => {
        throw new Error('The download failed. Try again; if it keeps failing, the downloader may need updating with "npm run setup".');
      });
    },
  };
}
