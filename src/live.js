// Which of the channels in the sources list are live on YouTube or Twitch right now.
//
// One question per channel: YouTube's "/live" address of a channel leads to
// the stream it is broadcasting, or says the channel is not live; Twitch is
// asked about the channel by its login (src/twitch.js, since 2026-11-23). Nothing is
// downloaded, and only channels in the owner's saved list are asked about.
// What comes back is outside text: it is checked and trimmed here before
// anything is shown.
import { channelAddress } from './pictures.js';
import { agreedSourceOf } from './sources.js';

/** @typedef {import('./sources.js').Source} Source */

/**
 * What is known about one channel:
 * `live` is true or false, or null when the channel could not be checked.
 *
 * @typedef {object} LiveState
 * @property {boolean | null} live
 * @property {string} [videoId]    the stream's video id, when live on YouTube
 * @property {string} [url]        where to watch the stream, when live: built here, never taken from the answer
 * @property {string} [title]      the stream's title, when live
 * @property {number | null} [viewers]   people watching, when YouTube says
 * @property {string | null} [started]   when the stream began, as an ISO time, when YouTube says
 */

// How many channels are asked about at once. Fourteen took 3 s this way.
const AT_ONCE = 4;
const tidy = (text) => String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

/**
 * Ask about every channel in the list that has agreed.
 *
 * @param {object} options
 * @param {Source[]} options.sources
 * @param {import('./fetch.js').Downloader} options.downloader
 * @returns {Promise<Record<string, LiveState>>} by source id
 */
export async function checkLive({ sources, downloader }) {
  const waiting = sources.filter((source) => source.status === 'agreed');
  /** @type {Record<string, LiveState>} */
  const found = {};
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, waiting.length) }, async () => {
    for (let source = waiting.shift(); source; source = waiting.shift()) found[source.id] = await checkOne(source, downloader);
  }));
  return found;
}

/** @returns {Promise<LiveState>} */
async function checkOne(source, downloader) {
  let answer;
  try {
    answer = await downloader.live(channelAddress(source));
  } catch {
    return { live: null };
  }
  // The stream must be this channel's own, by the same test as a video's channel.
  if (!answer.live || !agreedSourceOf([source], answer)) return { live: false };
  let where;
  if (answer.site === 'twitch') {
    // A Twitch stream is watched at its channel's address, rebuilt from the login in the list.
    where = { url: channelAddress(source) };
  } else {
    // A YouTube stream's id must be a video id before a link is built from it.
    if (!/^[\w-]{11}$/.test(answer.videoId ?? '')) return { live: false };
    where = { videoId: answer.videoId, url: `https://www.youtube.com/watch?v=${answer.videoId}` };
  }
  return {
    live: true,
    ...where,
    title: tidy(answer.title),
    viewers: Number.isInteger(answer.viewers) && answer.viewers >= 0 ? answer.viewers : null,
    started: Number.isFinite(answer.started) && answer.started > 0 ? new Date(answer.started * 1000).toISOString() : null,
  };
}
