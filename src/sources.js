// The channels whose videos may be brought in with `fetch`, and where each
// one stands. Kept in data/sources.json, which is not in the repository.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { keepCopy } from './backup.js';

/**
 * Only a channel marked `agreed` can be fetched from. Since 2026-11-20 the
 * owner adds a channel to the list only once it has agreed, so the page no
 * longer shows a status and every new entry is `agreed`. The other two
 * values remain for lists saved before that.
 */
export const SOURCE_STATUSES = ['asked', 'agreed', 'declined'];

/** The addresses a channel can have, for messages. */
export const ADDRESS_FORMS = 'https://www.youtube.com/@name, https://www.youtube.com/channel/UC... or https://www.twitch.tv/name';

/** How many clubs a streamer can be marked as supporting. */
export const MAX_CLUBS = 3;

const sourceSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  name: z.string().trim().min(1).max(80),
  url: z.string().trim().max(200).refine((url) => channelKey(url) !== null, `give the channel address: ${ADDRESS_FORMS}`),
  status: z.enum(SOURCE_STATUSES).default('agreed'),
  // Where and when they answered, in the owner's words. Kept from earlier lists; the page no longer asks for it.
  note: z.string().trim().max(300).default(''),
  // The clubs the streamer supports, by name, as the owner marked them: up to three, each once.
  // A name, not an id, because a club that is in two leagues is two entries with one name.
  clubs: z.array(z.string().trim().min(1).max(80)).default([])
    .transform((names) => [...new Set(names)])
    .refine((names) => names.length <= MAX_CLUBS, `a streamer can support at most ${MAX_CLUBS} clubs`),
});
const sourcesSchema = z.array(sourceSchema).max(200);

/** @typedef {z.infer<typeof sourceSchema>} Source */

// Twitch's own pages, which look like a channel's address but are not one.
const TWITCH_PAGES = new Set(['videos', 'directory', 'settings', 'search', 'downloads', 'jobs', 'turbo', 'subscriptions', 'inventory', 'wallet', 'friends', 'messages', 'drops', 'p', 'u', 'login', 'signup', 'store', 'prime', 'clips']);

/**
 * What identifies a channel in its address: a YouTube handle or channel id,
 * or a Twitch login (added on 2026-11-23; a Twitch channel is its own entry).
 *
 * @param {string} url
 * @returns {{ handle: string } | { channelId: string } | { twitch: string } | null}
 */
export function channelKey(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (['www.twitch.tv', 'twitch.tv', 'm.twitch.tv'].includes(parsed.hostname)) {
    if (parsed.username || parsed.port) return null;
    const login = /^\/([A-Za-z0-9_]{1,25})\/?$/.exec(parsed.pathname)?.[1].toLowerCase();
    return login && !TWITCH_PAGES.has(login) ? { twitch: login } : null;
  }
  if (!['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(parsed.hostname)) return null;
  const handle = /^\/(@[\w.-]{1,60})\/?$/.exec(parsed.pathname);
  if (handle) return { handle: handle[1].toLowerCase() };
  const channel = /^\/channel\/(UC[\w-]{22})\/?$/.exec(parsed.pathname);
  return channel ? { channelId: channel[1] } : null;
}

/** Which site a channel address is on, or null. */
export function siteOf(url) {
  const key = channelKey(url);
  if (!key) return null;
  return 'twitch' in key ? 'twitch' : 'youtube';
}

/**
 * The agreed source a video belongs to, or null. The video is matched by its
 * channel's id or handle on YouTube, or its channel's login on Twitch, which
 * come from the video itself, not from anything typed by a person. A Twitch
 * channel never matches a YouTube video, nor the other way round.
 *
 * @param {Source[]} sources
 * @param {{ site?: string, channelId?: string, handle?: string, login?: string }} video
 * @returns {Source | null}
 */
export function agreedSourceOf(sources, video) {
  return sources.find((source) => {
    if (source.status !== 'agreed') return false;
    const key = channelKey(source.url);
    if (!key) return false;
    if ('twitch' in key) return video.site === 'twitch' && key.twitch === String(video.login ?? '').toLowerCase();
    if (video.site === 'twitch') return false;
    if ('channelId' in key) return key.channelId === video.channelId;
    return key.handle === (video.handle ?? '').toLowerCase();
  }) ?? null;
}

export function parseSources(data) {
  const result = sourcesSchema.safeParse(data);
  if (!result.success) throw new Error(`The sources list is not valid:\n${z.prettifyError(result.error)}`);
  const ids = new Set(result.data.map((source) => source.id));
  if (ids.size !== result.data.length) throw new Error('The sources list is not valid: two sources share an id.');
  return result.data;
}

const sourcesFile = (dataDir) => path.join(dataDir, 'sources.json');

/** @returns {Promise<Source[]>} an empty list when none was saved yet */
export async function readSources(dataDir) {
  let text;
  try {
    text = await readFile(sourcesFile(dataDir), 'utf8');
  } catch {
    return [];
  }
  return parseSources(JSON.parse(text));
}

export async function saveSources(dataDir, data) {
  const sources = parseSources(data);
  await mkdir(dataDir, { recursive: true });
  const text = `${JSON.stringify(sources, null, 2)}\n`;
  // The list as it stood is copied first (data/backups/sources), so no write can lose it for good.
  await keepCopy(sourcesFile(dataDir), text, { dataDir, name: 'sources', keep: 40 });
  await writeFile(sourcesFile(dataDir), text);
  return sources;
}

/**
 * Change one channel in the saved list and leave every other as it is on
 * disk. The page uses this for anything that is saved the moment it is
 * chosen, so a page showing an older copy of the list cannot write that
 * older copy back over the rest.
 *
 * @param {string} dataDir
 * @param {string} sourceId
 * @param {(source: Source) => Source} change
 * @returns {Promise<Source[]>} the whole list as saved
 */
async function changeSource(dataDir, sourceId, change) {
  const sources = await readSources(dataDir);
  const at = sources.findIndex((source) => source.id === sourceId);
  if (at < 0) throw new Error('No such channel in the saved list.');
  sources[at] = change(sources[at]);
  return saveSources(dataDir, sources);
}

/** Set the clubs one saved channel supports. */
export function setSourceClubs(dataDir, sourceId, clubs) {
  return changeSource(dataDir, sourceId, (source) => ({ ...source, clubs }));
}

/** Take one channel out of the saved list. */
export async function removeSource(dataDir, sourceId) {
  const sources = await readSources(dataDir);
  if (!sources.some((source) => source.id === sourceId)) throw new Error('No such channel in the saved list.');
  return saveSources(dataDir, sources.filter((source) => source.id !== sourceId));
}

/** Channel links for the credits of a compilation, by name in lower case. Agreed channels only. */
export function creditLinks(sources) {
  return Object.fromEntries(sources.filter((source) => source.status === 'agreed').map((source) => [source.name.toLowerCase(), source.url]));
}
