// The profile pictures of the channels in the sources list, shown beside a
// streamer's name when they are credited.
//
//   data/source-pictures/<source id>.png
//
// This is the second and last thing the tool takes from outside (the first is
// `fetch`, in fetch.js), and it is as narrow: only the picture of a channel
// that is in the owner's saved list, and only after the channel YouTube
// reports for that address is checked to be the one in the list. Whatever
// comes back is decoded and drawn again, so nothing but a plain round PNG the
// tool made itself is ever kept.
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from './run.js';
import { agreedSourceOf, channelKey, readSources, saveSources } from './sources.js';

/** @typedef {import('./sources.js').Source} Source */

/** Side of the stored picture in pixels. It is drawn much smaller. */
export const PICTURE_PIXELS = 256;
// Where YouTube serves channel pictures from. An address anywhere else is refused.
const PICTURE_HOSTS = new Set(['yt3.googleusercontent.com', 'yt3.ggpht.com']);
const MAX_BYTES = 5_000_000;

const pictureDir = (dataDir) => path.join(path.resolve(dataDir), 'source-pictures');
/** Where a channel's picture is kept. */
export const pictureFile = (dataDir, sourceId) => path.join(pictureDir(dataDir), `${sourceId}.png`);

/** The plain address of the channel a source names, rebuilt from its handle or id. */
export function channelAddress(source) {
  const key = channelKey(source.url);
  if (!key) throw new Error(`"${source.name}" has no channel address that can be used.`);
  return `https://www.youtube.com/${key.handle ?? `channel/${key.channelId}`}`;
}

/** Check a picture's address before anything is asked of it. It comes from outside, so it is not trusted. */
export function checkPictureUrl(address) {
  let url;
  try {
    url = new URL(String(address));
  } catch {
    throw new Error('YouTube gave no picture for this channel.');
  }
  if (url.protocol !== 'https:' || !PICTURE_HOSTS.has(url.hostname) || url.username || url.port) {
    throw new Error('The picture is not at an address this tool takes pictures from.');
  }
  return url.href;
}

/**
 * Get a picture's bytes. Nothing is sent but the request itself, and it is
 * not followed anywhere else.
 *
 * @param {string} address   already checked by checkPictureUrl
 * @returns {Promise<Buffer>}
 */
export async function downloadPicture(address) {
  const response = await fetch(address, { redirect: 'error', signal: AbortSignal.timeout(20_000) }).catch(() => {
    throw new Error('The picture could not be reached. Try again.');
  });
  if (!response.ok) throw new Error('The picture could not be fetched. Try again.');
  if (Number(response.headers.get('content-length') ?? 0) > MAX_BYTES) throw new Error('The picture is too large to keep.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_BYTES) throw new Error('The picture is too large to keep, or empty.');
  return bytes;
}

/**
 * Fetch one channel's picture and keep it as a round PNG.
 *
 * @param {object} options
 * @param {Source} options.source
 * @param {string} options.dataDir
 * @param {import('./fetch.js').Downloader} options.downloader
 * @param {(address: string) => Promise<Buffer>} [options.download]   replaced in tests
 * @param {Awaited<ReturnType<import('./fetch.js').Downloader['channel']>>} [options.channel]
 *   what YouTube said about the channel, when it has just been asked
 * @returns {Promise<string>} the file written
 */
export async function fetchPicture({ source, dataDir, downloader, download = downloadPicture, channel: known }) {
  if (source.status !== 'agreed') throw new Error(`"${source.name}" is not a channel that has agreed.`);
  const channel = known ?? await downloader.channel(channelAddress(source));
  // The same test as fetching a video: the channel YouTube reports must be the one in the list.
  if (!agreedSourceOf([source], channel)) throw new Error(`The address of "${source.name}" leads to another channel, "${channel.name}". Check it.`);
  // The same answer says how many subscribers the channel has; that is kept even if the picture cannot be had.
  await saveSubscribers(dataDir, source.id, channel.subscribers);
  const bytes = await download(checkPictureUrl(channel.pictureUrl));

  const dir = pictureDir(dataDir);
  await mkdir(dir, { recursive: true });
  const raw = path.join(dir, `.${source.id}.fetched`);
  const partial = path.join(dir, `.${source.id}.partial.png`);
  const size = PICTURE_PIXELS;
  const half = size / 2;
  try {
    await writeFile(raw, bytes);
    // Decoded, cropped to a square, and drawn again as a disc with a soft edge.
    // Only this picture is kept; the bytes that came from outside are thrown away.
    const disc = `a='255*clip(${half}-hypot(X-${half - 0.5},Y-${half - 0.5}),0,1)'`;
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', raw, '-frames:v', '1',
      '-vf', `scale=${size}:${size}:force_original_aspect_ratio=increase,crop=${size}:${size},format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':${disc}`,
      '-f', 'image2', '-c:v', 'png', partial,
    ]).catch(() => {
      throw new Error(`What YouTube sent for "${source.name}" is not a picture that can be read.`);
    });
    await rename(partial, pictureFile(dataDir, source.id));
  } finally {
    await rm(raw, { force: true });
    await rm(partial, { force: true });
  }
  return pictureFile(dataDir, source.id);
}

/** A channel's name as YouTube gives it, made fit for the list: one line, no control characters, at most 80 long. */
const tidyName = (text) => String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).trim();
const sameChannel = (a, b) => JSON.stringify(channelKey(a)) === JSON.stringify(channelKey(b));

/**
 * Fill a channel in from its address alone: ask YouTube about the channel,
 * take its name when none was typed, put it in the saved list, and fetch its
 * picture. A name the owner typed is kept: credits and the names of fetched
 * files are matched on it.
 *
 * Pressing this is the owner adding the channel, so it is saved as agreed,
 * like every channel added on the page.
 *
 * @param {object} options
 * @param {{ id: string, url: string, name?: string, clubs?: string[] }} options.source   the row as typed
 * @returns {Promise<{ source: Source, named: boolean, picture: boolean, pictureError: string }>}
 *   `named` says the name came from YouTube
 */
export async function syncSource({ source, dataDir, downloader, download }) {
  const typed = { id: String(source?.id ?? ''), url: String(source?.url ?? '').trim(), name: String(source?.name ?? '').trim() };
  // The clubs chosen on the row come along, so syncing a row does not lose them. Without any, the saved ones stay.
  const clubs = Array.isArray(source?.clubs) ? source.clubs : null;
  if (!channelKey(typed.url)) throw new Error('Give the channel address first: https://www.youtube.com/@name or https://www.youtube.com/channel/UC...');
  const saved = await readSources(dataDir);
  const twin = saved.find((other) => other.id !== typed.id && sameChannel(other.url, typed.url));
  if (twin) throw new Error(`This channel is already in your list, as "${twin.name}".`);

  const channel = await downloader.channel(channelAddress({ name: typed.name || 'This channel', url: typed.url }));
  if (!agreedSourceOf([{ ...typed, name: typed.name || 'x', status: 'agreed', note: '' }], channel)) {
    throw new Error(`That address leads to another channel, "${tidyName(channel.name)}". Check it.`);
  }
  const name = typed.name || tidyName(channel.name);
  if (!name) throw new Error('YouTube gave no name for this channel. Type one.');

  const at = saved.findIndex((other) => other.id === typed.id);
  const entry = { id: typed.id, name, url: typed.url, status: 'agreed', note: at < 0 ? '' : saved[at].note, clubs: clubs ?? (at < 0 ? [] : saved[at].clubs) };
  // saveSources checks the whole list, the id included, before anything is written.
  const sources = await saveSources(dataDir, at < 0 ? [...saved, entry] : saved.map((other, index) => (index === at ? entry : other)));
  const kept = sources.find((other) => other.id === typed.id);

  // The channel is in the list now even if its picture cannot be had.
  let pictureError = '';
  await fetchPicture({ source: kept, dataDir, downloader, download, channel }).catch((error) => {
    pictureError = error.message;
  });
  return { source: kept, named: !typed.name, picture: !pictureError, pictureError };
}

/**
 * Fetch the picture of every channel in the list, one after another.
 *
 * @returns {Promise<{ fetched: string[], failed: { name: string, error: string }[] }>} by channel name
 */
export async function fetchPictures({ sources, dataDir, downloader, download, onStep = () => {} }) {
  const fetched = [];
  const failed = [];
  for (const [index, source] of sources.filter((known) => known.status === 'agreed').entries()) {
    onStep('pictures', { done: index, name: source.name });
    try {
      await fetchPicture({ source, dataDir, downloader, download });
      fetched.push(source.name);
    } catch (error) {
      failed.push({ name: source.name, error: error.message });
    }
  }
  return { fetched, failed };
}

/** Which channels have a picture, with a number that changes when the picture does. */
export async function listPictures(dataDir, sources) {
  const found = {};
  for (const source of sources) {
    const info = await stat(pictureFile(dataDir, source.id)).catch(() => null);
    if (info?.isFile()) found[source.id] = Math.round(info.mtimeMs);
  }
  return found;
}

/** Remove pictures, and subscriber counts, of channels that are no longer in the list. */
export async function removeOtherPictures(dataDir, sources) {
  const kept = new Set(sources.map((source) => `${source.id}.png`));
  for (const name of await readdir(pictureDir(dataDir)).catch(() => [])) {
    if (!kept.has(name)) await rm(path.join(pictureDir(dataDir), name), { force: true });
  }
  const counts = await readCounts(dataDir);
  const ids = new Set(sources.map((source) => source.id));
  if (Object.keys(counts).some((id) => !ids.has(id))) await writeCounts(dataDir, Object.fromEntries(Object.entries(counts).filter(([id]) => ids.has(id))));
}

// --- Subscriber counts -----------------------------------------------------------
//
//   data/source-subscribers.json    { "<source id>": { "count": 18000, "checked": "2026-11-20T15:04:05.000Z" } }
//
// A number YouTube gives with the picture, and when it was read. It is kept
// apart from the sources list, which is the owner's own record.

const countsFile = (dataDir) => path.join(path.resolve(dataDir), 'source-subscribers.json');
const isCount = (value) => Number.isInteger(value) && value >= 0 && value <= 100_000_000_000;

/** Every count on file, with anything that is not a count left out. */
async function readCounts(dataDir) {
  try {
    const data = JSON.parse(await readFile(countsFile(dataDir), 'utf8'));
    return Object.fromEntries(Object.entries(data).filter(([, one]) => isCount(one?.count) && typeof one?.checked === 'string'));
  } catch {
    return {};
  }
}

async function writeCounts(dataDir, counts) {
  await mkdir(path.resolve(dataDir), { recursive: true });
  await writeFile(countsFile(dataDir), `${JSON.stringify(counts, null, 2)}\n`);
}

/** Keep a channel's subscriber count with the time it was read. Anything that is not a count is ignored. */
async function saveSubscribers(dataDir, sourceId, count) {
  if (!isCount(count)) return;
  await writeCounts(dataDir, { ...(await readCounts(dataDir)), [sourceId]: { count, checked: new Date().toISOString() } });
}

/**
 * The subscriber counts of the channels in the list, by source id.
 *
 * @returns {Promise<Record<string, { count: number, checked: string }>>}
 */
export async function listSubscribers(dataDir, sources) {
  const counts = await readCounts(dataDir);
  return Object.fromEntries(sources.filter((source) => counts[source.id]).map((source) => [source.id, counts[source.id]]));
}

/**
 * Pictures for the credits of a compilation, by the channel's name in lower
 * case. A credit gets a picture only when it is spelled like the name.
 *
 * @returns {Promise<Record<string, string>>} name to file
 */
export async function creditPictures(dataDir, sources) {
  const pictures = {};
  for (const source of sources.filter((known) => known.status === 'agreed')) {
    const file = pictureFile(dataDir, source.id);
    if (await stat(file).then((info) => info.isFile(), () => false)) pictures[source.name.toLowerCase()] = file;
  }
  return pictures;
}
