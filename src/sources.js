// The channels whose videos may be brought in with `fetch`, and where each
// one stands. Kept in data/sources.json, which is not in the repository.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

/**
 * Only a channel marked `agreed` can be fetched from. Since 2026-11-20 the
 * owner adds a channel to the list only once it has agreed, so the page no
 * longer shows a status and every new entry is `agreed`. The other two
 * values remain for lists saved before that.
 */
export const SOURCE_STATUSES = ['asked', 'agreed', 'declined'];

const sourceSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  name: z.string().trim().min(1).max(80),
  url: z.string().trim().max(200).refine((url) => channelKey(url) !== null, 'give the channel address: https://www.youtube.com/@name or https://www.youtube.com/channel/UC...'),
  status: z.enum(SOURCE_STATUSES).default('agreed'),
  // Where and when they answered, in the owner's words. Kept from earlier lists; the page no longer asks for it.
  note: z.string().trim().max(300).default(''),
});
const sourcesSchema = z.array(sourceSchema).max(200);

/** @typedef {z.infer<typeof sourceSchema>} Source */

/**
 * What identifies a channel in its address: its handle or its channel id.
 *
 * @param {string} url
 * @returns {{ handle: string } | { channelId: string } | null}
 */
export function channelKey(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(parsed.hostname)) return null;
  const handle = /^\/(@[\w.-]{1,60})\/?$/.exec(parsed.pathname);
  if (handle) return { handle: handle[1].toLowerCase() };
  const channel = /^\/channel\/(UC[\w-]{22})\/?$/.exec(parsed.pathname);
  return channel ? { channelId: channel[1] } : null;
}

/**
 * The agreed source a video belongs to, or null. The video is matched by its
 * channel's id or handle, which come from the video itself, not from
 * anything typed by a person.
 *
 * @param {Source[]} sources
 * @param {{ channelId?: string, handle?: string }} video
 * @returns {Source | null}
 */
export function agreedSourceOf(sources, video) {
  return sources.find((source) => {
    if (source.status !== 'agreed') return false;
    const key = channelKey(source.url);
    if (key?.channelId) return key.channelId === video.channelId;
    return Boolean(key?.handle) && key.handle === (video.handle ?? '').toLowerCase();
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
  await writeFile(sourcesFile(dataDir), `${JSON.stringify(sources, null, 2)}\n`);
  return sources;
}

/** Channel links for the credits of a compilation, by name in lower case. Agreed channels only. */
export function creditLinks(sources) {
  return Object.fromEntries(sources.filter((source) => source.status === 'agreed').map((source) => [source.name.toLowerCase(), source.url]));
}
