// Brings part of a video, or a whole one, into the videos folder from a YouTube
// or Twitch link (Twitch since 2026-11-23).
//
// This is the one way video comes in from outside, and it is narrow on purpose:
// links to one video only (on Twitch a past broadcast), a range or the whole video
// of at most 3 hours, and only from a channel the owner has marked as agreed in
// the sources list.
import { lstatSync } from 'node:fs';
import { access, chmod, mkdir, readdir, rename, rm, statfs } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clipSlug } from './cut.js';
import { rangeStamp } from './part.js';
import { probe } from './probe.js';
import { startRangeRelay } from './rangeRelay.js';
import { isStopped, run } from './run.js';
import { agreedSourceOf, channelKey } from './sources.js';
import { checkFetchRange, checkWholeLength, fileLabel, MAX_FETCH_SECONDS, MAX_WHOLE_SECONDS, videoLink, videoUrl } from './fetchLink.js';
import { twitchChannel } from './twitch.js';
import { formatClock } from './time.js';

/** @typedef {import('./sources.js').Source} Source */

/**
 * The program that talks to YouTube and Twitch. Tests pass a stand-in.
 *
 * @typedef {object} Downloader
 * @property {() => Promise<boolean>} isInstalled
 * @property {(url: string) => Promise<{ site?: 'youtube' | 'twitch', id: string, title: string, channel: string, channelId: string, handle: string, login?: string, duration: number, live?: string, chat?: boolean }>} info
 *   `live` is the stream's state: "is_live" while it is going on. `login` is a Twitch video's channel
 * @property {(job: { url: string, start: number, end: number, whole?: boolean, dir: string, name: string, onStep?: (step: string) => void }) => Promise<{ slow?: string } | void>} download
 *   writes `<dir>/<name>.mp4`; `slow` says why the fast way was not used, when it was not
 * @property {(job: { url: string, dir: string, name: string }) => Promise<string>} [chat]
 *   fetches only a video's chat replay into `<dir>/<name>.live_chat.json` and returns that path
 * @property {(url: string) => Promise<Array<{ text: string, likes: number }>>} [comments]
 *   a video's top comments: only their words and like counts, never who wrote them
 * @property {(url: string) => Promise<{ site?: 'youtube' | 'twitch', name: string, channelId: string, handle: string, login?: string, pictureUrl: string, subscribers?: number | null }>} channel
 *   what the site says about a channel, for its profile picture and subscriber (on Twitch, follower) count (see pictures.js)
 * @property {(url: string) => Promise<{ site?: 'youtube' | 'twitch', live: boolean, videoId?: string, title?: string, channelId?: string, handle?: string, login?: string, viewers?: number, started?: number }>} live
 *   whether a channel is broadcasting right now, and which stream (see live.js)
 */

// Room allowed per second of video at up to 1080p, for the free-space check.
const BYTES_PER_SECOND = 1_500_000;

/**
 * How long a download of `seconds` of video may take before it is given up. The slow way
 * comes at a little under playback speed (11 minutes for 20 on 2026-11-21), so a fixed
 * limit would end a long part half done. Stop ends it sooner whenever the owner wants.
 *
 * @param {number} seconds   the length asked for
 */
export function downloadTimeout(seconds) {
  // A whole number: a video's own length is not one (3502.8 s on 2026-11-24), and a time limit
  // with a fraction is refused outright, which failed the fast download and the slow one alike.
  return Math.ceil(Math.max(30 * 60, 1.2 * seconds + 15 * 60) * 1000);
}

// Reading a chat replay goes from the start, piece by piece: an 11-hour stream with 54,000
// messages took tens of minutes. Allowed up to three hours; Stop ends it sooner.
const CHAT_TIMEOUT = 3 * 60 * 60 * 1000;

// The link and range checks live in a file of their own, which the Download page also uses.
export { MAX_FETCH_SECONDS, MAX_WHOLE_SECONDS, videoUrl };

/** Free bytes on the disk that holds `dir`, or null when it cannot be told. */
const diskFree = (dir) => statfs(dir).then((disk) => disk.bavail * disk.bsize, () => null);

/**
 * Fetch a time range of a video into `outDir`, or the whole video.
 *
 * @param {object} options
 * @param {string} options.url
 * @param {number} [options.start]    seconds into the video; not used with `whole`
 * @param {number} [options.end]
 * @param {boolean} [options.whole]   the whole video, up to MAX_WHOLE_SECONDS
 * @param {string} [options.label]    the owner's own name for the file, put in front of the name the tool makes
 * @param {Source[]} options.sources
 * @param {string} options.outDir   the videos folder
 * @param {Downloader} [options.downloader]
 * @param {(step: string) => void} [options.onStep]
 * @param {(dir: string) => Promise<number | null>} [options.freeSpace]   free bytes on the disk that holds
 *   `dir`, or null when it cannot be told; replaced in tests, which must not depend on this machine's disk
 * @returns {Promise<{ name: string, file: string, seconds: number, early: number, source: Source, title: string, slow: string | null }>}
 *   `early` is how many seconds before the asked start the file begins; `slow` says why it came the slow way, if it did
 */
export async function fetchVideo({ url, start, end, whole = false, label = '', sources, outDir, downloader = ytDlp(), onStep = () => {}, freeSpace = diskFree }) {
  const checked = videoLink(url);
  const link = checked.url;
  const site = checked.site === 'twitch' ? 'Twitch' : 'YouTube';
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
    throw new Error(`This video is live right now, so a part of it cannot be fetched. Wait until the stream has ended and ${site} shows it as an ordinary video, then fetch the part.`);
  }
  if (video.live === 'is_upcoming') throw new Error('This stream has not started yet, so there is nothing to fetch.');
  if (video.live === 'post_live') {
    throw new Error(`This stream has only just ended and ${site} is still preparing it. Try again later, once it plays as an ordinary video.`);
  }
  if (whole) {
    // The range is the video's own length, as the site gives it. ffmpeg is not told to stop,
    // so a part of a second that the length leaves off is not lost.
    start = 0;
    end = checkWholeLength(video.duration);
  } else if (video.duration && end > video.duration + 1) {
    throw new Error(`The video is only ${formatClock(video.duration)} long, but the end is set to ${formatClock(end)}.`);
  }

  const dir = path.resolve(outDir);
  await mkdir(dir, { recursive: true });
  const free = await freeSpace(dir);
  const needed = (end - start) * BYTES_PER_SECOND + 200_000_000;
  if (free !== null && free < needed) {
    throw new Error(`There may not be enough free disk space for this: about ${(needed / 1e9).toFixed(1)} GB is needed.`);
  }

  // Named by the tool from the channel, the video's id and the range. The id
  // is the one checked in the link, not the one the downloader reports. The
  // owner's own name, if one was given, goes in front, after a space.
  const own = fileLabel(label);
  const base = `${own ? `${own} ` : ''}${filePrefix(source.name)}_${checked.fileId}_${rangeStamp(start)}-${rangeStamp(end)}`;
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
export async function relayDownload({ call, url, start, end, whole = false, file, lookup = null }) {
  // `lookup` gives the stream's addresses kept from a moment ago, so several parts of one stream ask once.
  const data = lookup ? await lookup(url) : JSON.parse((await call(['--skip-download', '--dump-single-json', '-f', FORMAT, '--', url], { timeout: 60_000 })).stdout);
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
    await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...inputs, ...maps, '-c', 'copy', '-f', 'mp4', partial], { timeout: downloadTimeout(end - start) });
    await rename(partial, file);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  } finally {
    await relay.close();
  }
}

/** Whether an address the tool built is on Twitch. */
const isTwitch = (url) => {
  try {
    return ['www.twitch.tv', 'twitch.tv', 'm.twitch.tv'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
};
/** The login in a Twitch channel's address, or undefined. */
const twitchLogin = (url) => {
  const key = channelKey(url);
  return key && 'twitch' in key ? key.twitch : undefined;
};

// A Twitch past broadcast comes as one stream with picture and sound together, at most 1080p.
const TWITCH_FORMAT = 'b[height<=1080]/b';
// Where Twitch serves past broadcasts from (seen on 2026-11-23: a CloudFront host). Anywhere else is refused.
const TWITCH_STREAM_HOSTS = /^([a-z0-9-]+\.)+(cloudfront\.net|ttvnw\.net)$/;

/**
 * Check a Twitch stream's address before ffmpeg is given it: it comes from outside.
 *
 * @param {string} address
 * @returns {string}
 */
export function checkTwitchStream(address) {
  let url;
  try {
    url = new URL(String(address));
  } catch {
    throw new Error('Twitch gave no stream for this video.');
  }
  if (url.protocol !== 'https:' || !TWITCH_STREAM_HOSTS.test(url.hostname) || url.username || url.port) {
    throw new Error('Twitch gave a stream at an address this tool does not take video from.');
  }
  return url.href;
}

/**
 * Fetch a range of a Twitch past broadcast, or the whole of it. Twitch keeps a
 * broadcast as small pieces of a few seconds listed in a playlist, so ffmpeg
 * reads only the pieces the range needs, and no relay is used.
 *
 * Measured on 2026-11-23 on a 4-hour broadcast: with `-t` before `-i` (as the
 * downloader itself does it) both ffmpeg and the downloader gave 122 s for a
 * 60 s range, because the playlist reader does not stop where the input is
 * told to. With `-t` on the output it gave 60.0 s, from the same first frame
 * as the downloader's file, in 3 s (the downloader's own way took 9 s).
 * A whole broadcast is also given its length, so a broadcast still being
 * recorded is not read on as it grows.
 *
 * @param {{ call: (args: string[], options?: object) => Promise<{ stdout: string }>, url: string, start: number, end: number, whole?: boolean, file: string }} job
 */
export async function twitchDownload({ call, url, start, end, whole = false, file }) {
  const { stdout } = await call(['--skip-download', '--dump-single-json', '-f', TWITCH_FORMAT, '--', url], { timeout: 60_000 });
  const data = JSON.parse(stdout);
  if (data.requested_formats) throw new Error('Unexpected streams.');
  const stream = checkTwitchStream(data.url);
  const headers = data.http_headers ?? {};
  const agent = typeof headers['User-Agent'] === 'string' ? ['-user_agent', headers['User-Agent']] : [];
  const partial = `${file}.part`;
  try {
    await run('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      // Only https, so a playlist cannot point ffmpeg at a file on this computer.
      '-protocol_whitelist', 'https,tls,tcp,crypto',
      ...agent,
      ...(whole ? [] : ['-ss', String(start)]),
      '-i', stream,
      '-t', String(whole ? end + 1 : end - start),
      '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-f', 'mp4', partial,
    ], { timeout: downloadTimeout(end - start) });
    await rename(partial, file);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

/**
 * Where the owner's YouTube sign-in is kept: a cookies file in the Netscape format
 * that browsers' "cookies.txt" exporters write. Asked for by the owner on
 * 2026-11-21, when YouTube refused every lookup with "confirm you're not a bot".
 *
 * It is the owner's login, so: it lives in `data/` (git-ignored, and not in the
 * "My data" file, which takes only files it names), it is made readable by the
 * owner only, its contents are never read or printed by this tool, and only its
 * path is handed to the downloader. CLIPPER_YOUTUBE_COOKIES points elsewhere.
 *
 * @param {string} root   the project folder
 * @returns {string}
 */
export function youtubeCookiesFile(root) {
  return process.env.CLIPPER_YOUTUBE_COOKIES || path.join(root, 'data', 'youtube-cookies.txt');
}

/**
 * YouTube gives a video's addresses only after a JavaScript puzzle is solved, and asks for it
 * whenever the downloader is signed in (seen on 2026-11-23: with the sign-in, "n challenge solving
 * failed ... Only images are available", and every lookup failed). The downloader solves it with
 * the yt-dlp team's own solver scripts (the `yt-dlp-ejs` package, installed by `npm run setup`,
 * never fetched at run time) run by a JavaScript runtime: the Node this tool runs on, named by its
 * full path so no other is picked up.
 */
const SOLVER = ['--js-runtimes', `node:${process.execPath}`];

/** The downloader's sign-in options: none without a cookies file, and never for a link or a folder. */
async function cookiesArgs(file) {
  let info;
  try {
    info = lstatSync(file);
  } catch {
    return [];
  }
  if (!info.isFile()) return [];
  // Only the owner may read it, whoever else uses this computer.
  if ((info.mode & 0o077) !== 0) await chmod(file, 0o600).catch(() => {});
  return ['--cookies', file];
}

/** Whether the downloader is signed in to YouTube, for the pages to say so. */
export function isSignedIn(root = fileURLToPath(new URL('..', import.meta.url))) {
  try {
    return lstatSync(youtubeCookiesFile(root)).isFile();
  } catch {
    return false;
  }
}

/**
 * YouTube's own refusal, when that is why the downloader failed, in our words.
 * Seen on 2026-11-21 after a day of many lookups: every video answered "Sign in
 * to confirm you're not a bot", and the old message blamed the link.
 *
 * @param {unknown} error   what run() threw; its message ends with the program's last lines
 * @returns {Error | null}
 */
export function youtubeRefusal(error) {
  const text = String(/** @type {Error} */ (error)?.message ?? '');
  if (/confirm you.?re not a bot/i.test(text)) {
    return new Error(isSignedIn()
      ? 'YouTube is asking to confirm this is not a bot even with your YouTube sign-in. The cookies file may be out of date: save it again from the browser (see the README, "Signing in to YouTube"), or try again later. The link itself is fine.'
      : 'YouTube is asking to confirm this is not a bot, so it is not answering the downloader for now. This usually passes by itself within a few hours. To get past it now, sign the downloader in to YouTube (see the README, "Signing in to YouTube"). The link itself is fine.');
  }
  if (/HTTP Error 429|Too Many Requests/i.test(text)) {
    return new Error('YouTube says too many requests came from this connection. Wait a while and try again.');
  }
  return null;
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
  const cookies = youtubeCookiesFile(root);
  // `signedIn: false` for the questions asked about every channel again and again (the live
  // check, pictures and subscriber counts): asked for on 2026-11-23, so the account in the
  // cookies file makes a handful of requests a day, for downloads, chat and comments, and not
  // hundreds an hour, which is what gets an account flagged.
  const call = async (args, options, { signedIn = true } = {}) => {
    // Signed in when the owner has saved a cookies file; looked for on every call, so adding
    // or removing it needs no restart. Only its path is passed, never its contents.
    const signIn = signedIn ? await cookiesArgs(cookies) : [];
    return run(python, ['-m', 'yt_dlp', '--no-playlist', '--no-warnings', ...SOLVER, ...signIn, ...args], options);
  };
  // Twitch's answers about a channel (twitch.js); tests replace the whole downloader instead.
  const twitch = (login) => twitchChannel(login);
  // A stream's addresses, kept for half an hour: YouTube's stay valid for hours, and asking takes about 4 s.
  const streams = new Map();
  const lookup = async (url) => {
    const kept = streams.get(url);
    if (kept && Date.now() - kept.at < 30 * 60 * 1000) return kept.data;
    const { stdout } = await call(['--skip-download', '--dump-single-json', '-f', FORMAT, '--', url], { timeout: 60_000 });
    const data = JSON.parse(stdout);
    streams.set(url, { at: Date.now(), data });
    return data;
  };

  return {
    async isInstalled() {
      return call(['--version']).then(() => true, () => false);
    },
    async info(url) {
      // The link goes after "--", so it can never be read as an option.
      const { stdout } = await call(['--skip-download', '--dump-single-json', '--', url]).catch((error) => {
        throw youtubeRefusal(error) ?? new Error('The video could not be looked up. Check the link, and that it is public.');
      });
      const data = JSON.parse(stdout);
      if (isTwitch(url)) {
        // A Twitch past broadcast names its channel only by login (seen on 2026-11-23: uploader_id
        // "darealboeshi", no channel id). It has no chat the tool can read.
        const login = String(data.uploader_id ?? '').toLowerCase();
        return {
          site: 'twitch', id: String(data.id ?? ''), title: data.title ?? '', channel: data.uploader ?? (login || 'Unknown channel'),
          channelId: '', handle: '', login, duration: Number(data.duration) || 0,
          live: typeof data.live_status === 'string' ? data.live_status : '', chat: false,
        };
      }
      return {
        id: data.id, title: data.title ?? '', channel: data.channel ?? data.uploader ?? 'Unknown channel',
        channelId: data.channel_id ?? '', handle: data.uploader_id ?? '', duration: Number(data.duration) || 0,
        // "is_live", "is_upcoming", "post_live" (just ended, not yet prepared), "was_live" or "not_live".
        live: typeof data.live_status === 'string' ? data.live_status : '',
        // Whether YouTube offers a chat replay (a finished stream with chat on).
        chat: Boolean(data.subtitles?.live_chat),
      };
    },
    async chat({ url, dir, name }) {
      // Only the chat replay: --skip-download keeps the video itself from being fetched.
      // Checked on a real stream on 2026-11-21: it writes <name>.live_chat.json, one JSON object a line.
      await call(['--skip-download', '--write-subs', '--sub-langs', 'live_chat', '-P', dir, '-o', `${name}.%(ext)s`, '--', url], { timeout: CHAT_TIMEOUT }).catch((error) => {
        throw youtubeRefusal(error) ?? new Error('The chat replay could not be fetched. Try again; if it keeps failing, run "npm run setup" to update the downloader.');
      });
      const file = path.join(dir, `${name}.live_chat.json`);
      await access(file).catch(() => {
        throw new Error('YouTube gave no chat replay for this video.');
      });
      return file;
    },
    async comments(url) {
      // The top 500 comments with their replies left out: about 3 s. Only their words and like
      // counts are kept, never who wrote them (src/chat/comments.js reads timestamps from them).
      const { stdout } = await call([
        '--skip-download', '--write-comments', '--extractor-args', 'youtube:max_comments=500,500,0,0;comment_sort=top', '--dump-single-json', '--', url,
      ], { timeout: 180_000 }).catch((error) => {
        throw youtubeRefusal(error) ?? new Error('The comments could not be read.');
      });
      const data = JSON.parse(stdout);
      return (Array.isArray(data.comments) ? data.comments : []).map((comment) => ({ text: String(comment?.text ?? '').slice(0, 500), likes: Number(comment?.like_count) || 0 }));
    },
    async channel(url) {
      const login = twitchLogin(url);
      if (login) {
        const channel = await twitch(login);
        return { site: 'twitch', name: channel.name, channelId: '', handle: '', login: channel.login, pictureUrl: channel.pictureUrl, subscribers: channel.followers };
      }
      // Only the channel's own details: no videos are listed, and nothing is downloaded.
      const { stdout } = await call(['--skip-download', '--flat-playlist', '--playlist-items', '0', '--dump-single-json', '--', url], undefined, { signedIn: false }).catch((error) => {
        throw youtubeRefusal(error) ?? new Error('The channel could not be looked up. Check its address.');
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
      const login = twitchLogin(url);
      if (login) {
        const channel = await twitch(login).catch(() => {
          throw new Error('The channel could not be checked.');
        });
        const stream = channel.stream;
        return stream
          ? { site: 'twitch', live: true, login: channel.login, title: stream.title, viewers: stream.viewers ?? undefined, started: stream.started ?? undefined }
          : { site: 'twitch', live: false, login: channel.login };
      }
      // A channel's "/live" address leads to the stream it is broadcasting. Nothing is downloaded.
      let stdout;
      try {
        ({ stdout } = await call(['--skip-download', '--dump-single-json', '--', `${url}/live`], { timeout: 45_000 }, { signedIn: false }));
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
      if (isTwitch(url)) {
        // Twitch is read the one way, tried twice. The downloader's own way is no fallback here:
        // it gave twice the asked length (see twitchDownload).
        for (let attempt = 1; ; attempt++) {
          try {
            await twitchDownload({ call, url, start, end, whole, file: path.join(dir, `${name}.mp4`) });
            return {};
          } catch (error) {
            if (isStopped() || attempt === 2) throw isStopped() ? error : failed();
          }
        }
      }
      // The fast way first: ffmpeg reads the streams through the relay, which asks YouTube for
      // fixed slices (see rangeRelay.js). It is tried twice, with fresh addresses the second
      // time. If both fail for any reason other than a stop, the downloader's own way is used,
      // which is slow but needs nothing from us, and the reason is kept so the owner sees it.
      let reason = '';
      for (let attempt = 1; attempt <= 2; attempt++) {
        // The second try asks YouTube for fresh addresses.
        if (attempt === 2) streams.delete(url);
        try {
          await relayDownload({ call, url, start, end, whole, file: path.join(dir, `${name}.mp4`), lookup });
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
      ], { timeout: downloadTimeout(end - start) }).catch((error) => {
        if (isStopped()) throw error;
        throw youtubeRefusal(error) ?? failed();
      });
      return { slow: reason };
    },
  };
}
