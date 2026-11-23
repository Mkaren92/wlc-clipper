// What Twitch says about a channel: its name, profile picture, follower count,
// and whether it is live. Asked for on 2026-11-23, with Twitch added to the
// sources list beside YouTube.
//
// The answer comes from Twitch's own web interface (gql.twitch.tv), the one
// its site and yt-dlp use, with the site's public client id; there is no key
// and no sign-in. The owner chose this over registering an app on 2026-11-23.
// Only one question is ever asked, about one channel by its login, and only
// for channels in the saved list (pictures.js, live.js check that). The
// chat is NOT read from here: Twitch refuses to page through a chat replay
// without its integrity check, so the owner imports chat as a file instead.
//
// Kept free of Node-only imports apart from the global fetch.

// The public client id of Twitch's own website, which every page of twitch.tv sends.
const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const ADDRESS = 'https://gql.twitch.tv/gql';

/** A Twitch login: 3 to 25 letters, digits or underscores (some old ones are shorter). */
export const LOGIN = /^[a-z0-9_]{1,25}$/;

const QUERY = `query ChannelFacts($login: String!) {
  user(login: $login) {
    login
    displayName
    profileImageURL(width: 300)
    followers { totalCount }
    stream { id title viewersCount createdAt }
  }
}`;

/**
 * @typedef {object} TwitchChannel
 * @property {string} login
 * @property {string} name   the display name, outside text
 * @property {string} pictureUrl
 * @property {number | null} followers
 * @property {{ id: string, title: string, viewers: number | null, started: number | null } | null} stream   null when not live
 */

/**
 * Ask Twitch about one channel.
 *
 * @param {string} login
 * @param {object} [options]
 * @param {typeof fetch} [options.request]   replaced in tests
 * @returns {Promise<TwitchChannel>}
 */
export async function twitchChannel(login, { request = fetch } = {}) {
  const name = String(login ?? '').toLowerCase();
  if (!LOGIN.test(name)) throw new Error('That is not a Twitch channel name.');
  const response = await request(ADDRESS, {
    method: 'POST',
    // The login goes as a variable, never into the query's text.
    body: JSON.stringify({ query: QUERY, variables: { login: name } }),
    headers: { 'Client-Id': CLIENT_ID, 'Content-Type': 'text/plain;charset=UTF-8' },
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  }).catch(() => {
    throw new Error('Twitch could not be reached. Try again.');
  });
  // Twitch's own text is not passed on: it is outside text.
  if (!response.ok) throw new Error('Twitch did not answer about this channel. Try again later.');
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('Twitch gave an answer that could not be read.');
  }
  const user = data?.data?.user;
  if (!user) throw new Error('Twitch has no channel at that address. Check it.');
  const stream = user.stream && typeof user.stream === 'object' ? user.stream : null;
  const started = stream ? Date.parse(stream.createdAt) : NaN;
  return {
    login: String(user.login ?? '').toLowerCase(),
    name: String(user.displayName ?? user.login ?? ''),
    pictureUrl: String(user.profileImageURL ?? ''),
    followers: Number.isInteger(user.followers?.totalCount) ? user.followers.totalCount : null,
    stream: stream ? {
      id: String(stream.id ?? ''),
      title: String(stream.title ?? ''),
      viewers: Number.isInteger(stream.viewersCount) ? stream.viewersCount : null,
      started: Number.isFinite(started) ? started / 1000 : null,
    } : null,
  };
}
