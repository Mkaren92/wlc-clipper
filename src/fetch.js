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
import { startRangeRelay } from './rangeRelay.js';
import { isStopped, run } from './run.js';
import { agreedSourceOf } from './sources.js';
import { checkFetchRange, checkWholeLength, MAX_FETCH_SECONDS, MAX_WHOLE_SECONDS, videoUrl } from './fetchLink.js';
import { formatClock } from './time.js';

/** @typedef {import('./sources.js').Source} Source */

/**
 * The program that talks to YouTube. Tests pass a stand-in.
 *
 * @typedef {object} Downloader
 * @property {() => Promise<boolean>} isInstalled
 * @property {(url: string) => Promise<{ id: string, title: string, channel: string, channelId: string, handle: string, duration: number, live?: string }>} info
 *   `live` is YouTube's word for a stream's state: "is_live" while it is going on
 * @property {(job: { url: string, start: number, end: number, whole?: boolean, dir: string, name: string, onStep?: (step: string) => void }) => Promise<{ slow?: string } | void>} download
 *   writes `<dir>/<name>.mp4`; `slow` says why the fast way was not used, when it was not
 * @property {(url: string) => Promise<{ name: string, channelId: string, handle: string, pictureUrl: string, subscribers?: number | null }>} channel
 *   what YouTube says about a channel, for its profile picture and subscriber count (see pictures.js)
 * @property {(url: string) => Promise<{ live: boolean, videoId?: string, title?: string, channelId?: string, handle?: string, viewers?: number, started?: number }>} live
 *   whether a channel is broadcasting right now, and which stream (see live.js)
 */

// Room allowed per second of video at up to 1080p, for the free-space check.
const BYTES_PER_SECOND = 1_500_000;

// The link and range checks live in a file of their own, which the Download page also uses.
export { MAX_FETCH_SECONDS, MAX_WHOLE_SECONDS, videoUrl };

/**
 * Fetch a time range of a video into `outDir`, or the whole video.
 *
 * @param {object} options
 * @param {string} options.url
 * @param {number} [options.start]    seconds into the video; not used with `whole`
 * @param {number} [options.end]
 * @param {boolean} [options.whole]   the whole video, up to MAX_WHOLE_SECONDS
 * @param {Source[]} options.sources
 * @param {string} options.outDir   the videos folder
 * @param {Downloader} [options.downloader]
 * @param {(step: string) => void} [options.onStep]
 * @returns {Promise<{ name: string, file: string, seconds: number, early: number, source: Source, title: string, slow: string | null }>}
 *   `early` is how many seconds before the asked start the file begins; `slow` says why it came the slow way, if it did
 */
export async function fetchVideo({ url, start, end, whole = false, sources, outDir, downloader = ytDlp(), onStep = () => {} }) {
  const link = videoUrl(url);
  if (!whole) checkFetchRange(start, end);
  if (!(await downloader.isInstalled())) {
    throw new Error('The downloader is not installed. Run "npm run setup" to install it.');
  }

  onStep('looking');
  const video = await downloader.info(link);
  // The channel is read from the video itself, so a link cannot claim to be someone else's.
  const source = agreedSourceOf(sources, video);
  if (!source) {
    throw new Error(`This video is from "${video.channel}", which is not in your sources list. Only a channel that has agreed, and that you have added there, can be fetched from.`);
  }
  // A stream that is still going has no fixed beginning to count a range from.
  // The downloader can only record it as it happens, at the speed it plays,
  // and it ignores both the start and the end: it would run until the disk is full.
  if (video.live === 'is_live') {
    throw new Error('This video is live right now, so a part of it cannot be fetched. Wait until the stream has ended and YouTube shows it as an ordinary video, then fetch the part.');
  }
  if (video.live === 'is_upcoming') throw new Error('This stream has not started yet, so there is nothing to fetch.');
  if (video.live === 'post_live') {
    throw new Error('This stream has only just ended and YouTube is still preparing it. Try again later, once it plays as an ordinary video.');
  }
  if (whole) {
    // The range is the video's own length, as YouTube gives it. ffmpeg is not told to stop,
    // so a part of a second that the length leaves off is not lost.
    start = 0;
    end = checkWholeLength(video.duration);
  } else if (video.duration && end > video.duration + 1) {
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
  const how = await downloader.download({ url: link, start, end, whole, dir, name, onStep }).catch(async (error) => {
    // A download that failed or was stopped leaves pieces behind, named by the tool. They are removed.
    for (const left of await readdir(dir).catch(() => [])) {
      if (left.startsWith(`${name}.`)) await rm(path.join(dir, left), { force: true });
    }
    throw error;
  });
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
  return { name: `${name}.mp4`, file, seconds: made.duration, early, source, title: video.title, slow: how?.slow ?? null };
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

// At most 1080p, as an MP4 the rest of the tool reads.
const FORMAT = 'bv*[height<=1080]+ba/b[height<=1080]/b';

/**
 * Fetch a range the fast way: the downloader only says where the streams are,
 * and ffmpeg cuts the range out of them, reading through the relay. The
 * command is the one the downloader itself gives ffmpeg (`-ss` and `-t`
 * before each `-i`, picture and sound copied), so the file is the same:
 * on 2026-11-21 every frame of a 2-minute part matched the downloader's own
 * file, in 3.2 s instead of 71 s.
 *
 * @param {{ call: (args: string[], options?: object) => Promise<{ stdout: string }>, url: string, start: number, end: number, whole?: boolean, file: string }} job
 */
export async function relayDownload({ call, url, start, end, whole = false, file }) {
  const { stdout } = await call(['--skip-download', '--dump-single-json', '-f', FORMAT, '--', url], { timeout: 60_000 });
  const data = JSON.parse(stdout);
  const formats = data.requested_formats ?? [data];
  const streams = formats.map((format) => format.url);
  if (streams.length < 1 || streams.length > 2) throw new Error('Unexpected streams.');
  // The same headers the downloader would give ffmpeg with these addresses.
  const relay = await startRangeRelay(streams, { headers: formats[0].http_headers ?? data.http_headers ?? {} });
  const partial = `${file}.part`;
  try {
    // A whole video is read from start to end; a part is cut with -ss and -t before each -i.
    const inputs = relay.urls.flatMap((address) => (whole ? ['-i', address] : ['-ss', String(start), '-t', String(end - start), '-i', address]));
    const maps = streams.length === 2 ? ['-map', '0:v:0', '-map', '1:a:0'] : ['-map', '0:v:0', '-map', '0:a:0?'];
    await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...inputs, ...maps, '-c', 'copy', '-f', 'mp4', partial], { timeout: (whole ? 90 : 30) * 60 * 1000 });
    await rename(partial, file);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  } finally {
    await relay.close();
  }
}

/**
 * Why the fast way failed, in one short line that is safe to show: the
 * stream addresses carry the owner's IP address, so every address is taken out.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function fastFailure(error) {
  const text = String(/** @type {Error} */ (error)?.message ?? error)
    .replace(/https?:\/\/\S+/g, '<address>')
    .replace(/\s+/g, ' ')
    .trim();
  return (text || 'no reason given').slice(0, 300);
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
        // "is_live", "is_upcoming", "post_live" (just ended, not yet prepared), "was_live" or "not_live".
        live: typeof data.live_status === 'string' ? data.live_status : '',
      };
    },
    async channel(url) {
      // Only the channel's own details: no videos are listed, and nothing is downloaded.
      const { stdout } = await call(['--skip-download', '--flat-playlist', '--playlist-items', '0', '--dump-single-json', '--', url]).catch(() => {
        throw new Error('The channel could not be looked up. Check its address.');
      });
      const data = JSON.parse(stdout);
      // The profile picture is named; the same list also holds the banner in several sizes.
      const picture = (data.thumbnails ?? []).find((thumbnail) => thumbnail.id === 'avatar_uncropped');
      return {
        name: data.channel ?? data.title ?? '', channelId: data.channel_id ?? '', handle: data.uploader_id ?? '', pictureUrl: picture?.url ?? '',
        // YouTube gives this rounded (18,000, not 18,243), and not at all for a channel that hides it.
        subscribers: Number.isFinite(data.channel_follower_count) ? data.channel_follower_count : null,
      };
    },
    async live(url) {
      // A channel's "/live" address leads to the stream it is broadcasting. Nothing is downloaded.
      let stdout;
      try {
        ({ stdout } = await call(['--skip-download', '--dump-single-json', '--', `${url}/live`], { timeout: 45_000 }));
      } catch (error) {
        // "Not live" is an answer, not a failure; so is a stream that is only announced.
        if (/not currently live|will begin in|live event will begin|Premieres in/i.test(error.message)) return { live: false };
        throw new Error('The channel could not be checked.');
      }
      const data = JSON.parse(stdout);
      return {
        live: data.live_status === 'is_live', videoId: data.id ?? '', title: data.title ?? '',
        channelId: data.channel_id ?? '', handle: data.uploader_id ?? '',
        viewers: data.concurrent_view_count, started: data.release_timestamp,
      };
    },
    async download({ url, start, end, whole = false, dir, name, onStep = () => {} }) {
      const failed = () => new Error('The download failed. Try again; if it keeps failing, the downloader may need updating with "npm run setup".');
      // The fast way first: ffmpeg reads the streams through the relay, which asks YouTube for
      // fixed slices (see rangeRelay.js). It is tried twice, with fresh addresses the second
      // time. If both fail for any reason other than a stop, the downloader's own way is used,
      // which is slow but needs nothing from us, and the reason is kept so the owner sees it.
      let reason = '';
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await relayDownload({ call, url, start, end, whole, file: path.join(dir, `${name}.mp4`) });
          return {};
        } catch (error) {
          if (isStopped()) throw error;
          reason = fastFailure(error);
        }
      }
      console.warn(`The fast download did not work (${reason}); using the slower way.`);
      onStep('fetching-slow');
      // A whole video goes through the downloader's own downloader, which asks for slices itself;
      // only a part has to be handed to ffmpeg, which is the slow way.
      await call([
        ...(whole ? [] : ['--download-sections', `*${start}-${end}`]),
        '-f', FORMAT,
        '--merge-output-format', 'mp4',
        '-P', dir,
        '-o', `${name}.%(ext)s`,
        '--', url,
      ], { timeout: (whole ? 90 : 30) * 60 * 1000 }).catch(() => {
        throw failed();
      });
      return { slow: reason };
    },
  };
}
