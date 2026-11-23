// The checks on what is asked of `fetch`: which video, and how much of it.
// Kept free of Node imports so the Download page can run the same checks
// as the engine before anything is sent (src/fetch.js uses them too).
import { formatClock } from './time.js';

// A whole video, when the owner asks for one: a watchalong is two to three hours.
// The cap catches a link to a stream that ran all day.
export const MAX_WHOLE_SECONDS = 3 * 3600;
// A part was at most 20 minutes until 2026-11-21, when the owner asked for longer ranges;
// it now has the whole video's cap, so a part of a long stream is never refused where the
// same video whole would not be.
export const MAX_FETCH_SECONDS = MAX_WHOLE_SECONDS;

/**
 * @typedef {object} VideoLink
 * @property {'youtube' | 'twitch'} site
 * @property {string} id    YouTube's 11-character id, or a Twitch video's number
 * @property {string} url   the plain address, rebuilt from the id
 * @property {string} fileId   the id as it goes into a fetched file's name: the YouTube id, or "tw" and the Twitch number
 */

const problem = () => new Error('Give a link to one YouTube video, such as https://www.youtube.com/watch?v=..., or one Twitch video, such as https://www.twitch.tv/videos/...');

/**
 * Check a link and say which one video it points to. A playlist, channel or
 * clip link is refused. Twitch video links were added on 2026-11-23; only a
 * past broadcast's address (/videos/<number>) is taken, never a live channel.
 *
 * @param {string} text
 * @returns {VideoLink}
 */
export function videoLink(text) {
  let url;
  try {
    url = new URL(String(text).trim());
  } catch {
    throw problem();
  }
  if (url.protocol !== 'https:' || url.username || url.port) throw problem();
  if (['www.twitch.tv', 'twitch.tv', 'm.twitch.tv'].includes(url.hostname)) {
    const id = /^\/videos\/(\d{1,15})\/?$/.exec(url.pathname)?.[1];
    if (!id) throw problem();
    return { site: 'twitch', id, url: `https://www.twitch.tv/videos/${id}`, fileId: `tw${id}` };
  }
  let id = null;
  if (url.hostname === 'youtu.be') id = url.pathname.slice(1);
  else if (['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(url.hostname)) {
    id = url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(?:live|shorts)\/([^/]+)\/?$/.exec(url.pathname)?.[1] ?? null;
  }
  if (!id || !/^[\w-]{11}$/.test(id)) throw problem();
  return { site: 'youtube', id, url: `https://www.youtube.com/watch?v=${id}`, fileId: id };
}

/**
 * Check a link and return the plain address of the one video it points to,
 * on YouTube or Twitch.
 *
 * @param {string} text
 * @returns {string}
 */
export function videoUrl(text) {
  return videoLink(text).url;
}

/**
 * The same check, for what only YouTube has: a chat replay the tool fetches
 * itself, and comments. A Twitch link is refused with what to do instead.
 *
 * @param {string} text
 * @returns {string}
 */
export function youtubeVideoUrl(text) {
  const link = videoLink(text);
  if (link.site !== 'youtube') {
    throw new Error('Twitch does not let this tool read a stream\'s chat. Save the chat with TwitchDownloader and import the file instead.');
  }
  return link.url;
}

/**
 * Check that a video can be fetched whole, from the length the site gives.
 *
 * @param {number} duration   seconds
 * @returns {number} the length in seconds
 */
export function checkWholeLength(duration) {
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('The site did not say how long this video is, so it cannot be fetched whole. Give a start and an end instead.');
  }
  if (duration > MAX_WHOLE_SECONDS) {
    throw new Error(`A whole video can be at most ${MAX_WHOLE_SECONDS / 3600} hours long; this one is ${formatClock(duration)}. Give a start and an end instead.`);
  }
  return duration;
}

/**
 * Check the range of a fetch, in seconds. Throws the message the owner sees.
 *
 * @param {number} start
 * @param {number} end
 * @returns {number} the length in seconds
 */
export function checkFetchRange(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    throw new Error('Give the start and the end of the part you want; the end must be after the start.');
  }
  if (end - start > MAX_FETCH_SECONDS) {
    throw new Error(`A fetch can be at most ${MAX_FETCH_SECONDS / 3600} hours long; this range is ${formatClock(end - start)}.`);
  }
  return end - start;
}
