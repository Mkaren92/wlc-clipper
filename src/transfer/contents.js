// What "my data" is: the things the owner chose to carry between machines.
//
// The owner went through every kind of data on 2026-11-20 and said which
// travel and which stay on the machine they were made on:
//
//   travel       the channels list (with the club each streamer supports),
//                the channels' pictures and subscriber counts, the leagues
//                and clubs with their logos, the owner's sound files (among
//                them the video played behind the intro card), and briefs;
//                and, since 2026-11-21, the overlay images (campaign logos),
//                which briefs name
//   stay local   source videos, parts, clips, combinations, compilations,
//                matches and their cards
//
// This is the one place that says so, and sync (src/sync/) sends and takes
// back exactly this. A new kind of saved data is added here, to what is sent
// (listTransfer) and to what is taken back (acceptEntry), only when the
// owner has said it should travel.
//
// Until 2026-11-24 the same list also made a data file to download and load
// by hand; the owner had it removed once sync worked on both machines.
//
// Never sent, whatever is asked:
//   .env            the AI key lives only there
//   data/backups    copies of this machine's own lists
//   data/youtube-cookies.txt   the YouTube sign-in, a password (acceptEntry refuses it)
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isSoundFileName } from '../compilation/sounds.js';

/**
 * The folders the travelling data lives in, by the name each has inside a data file.
 *
 * @typedef {{ data: string, sounds: string, briefs: string, overlays?: string }} Folders
 */

const ID = '[a-z0-9][a-z0-9-]{0,79}';
/** A file's own name: no folder in it, not hidden. */
const isPlain = (name) => name.length > 0 && name.length <= 200 && !/[\\/\0]/.test(name) && !name.startsWith('.');

/** The three lists. They are replaced whole on a load, through the functions that also keep a copy. */
export const LISTS = { sources: 'data/sources.json', clubs: 'data/clubs.json', subscribers: 'data/source-subscribers.json' };

// The shapes a name in a data file may have. Anything else in the file is passed over.
const SHAPES = [
  new RegExp('^data/(sources|clubs|source-subscribers)\\.json$'),
  new RegExp(`^data/source-pictures/${ID}\\.png$`),
];

/** Whether a name in a data file is something the owner chose to carry, and so may be loaded. */
export function acceptEntry(name) {
  if (SHAPES.some((shape) => shape.test(name))) return true;
  const [folder, file, ...more] = name.split('/');
  if (more.length > 0 || !file || !isPlain(file)) return false;
  if (folder === 'sounds') return isSoundFileName(file);
  if (folder === 'overlays') return /\.(png|webp)$/i.test(file);
  return folder === 'briefs' && file.endsWith('.json');
}

/** Every plain file under a folder, by its path from that folder. Links and hidden names are not followed. */
async function filesUnder(dir, inside = '') {
  const found = [];
  for (const name of (await readdir(path.join(dir, inside)).catch(() => [])).sort()) {
    if (name.startsWith('.')) continue;
    const info = await lstat(path.join(dir, inside, name)).catch(() => null);
    if (info?.isDirectory()) found.push(...(await filesUnder(dir, `${inside}${name}/`)));
    else if (info?.isFile()) found.push({ name: `${inside}${name}`, size: info.size, mtimeMs: info.mtimeMs });
  }
  return found;
}

/**
 * Everything that goes into a data file.
 *
 * @param {Folders} folders
 * @returns {Promise<{ name: string, file: string, size: number, mtimeMs: number }[]>}
 */
export async function listTransfer(folders) {
  const entries = [];
  for (const [folder, dir] of Object.entries(folders)) {
    for (const found of await filesUnder(dir)) {
      const name = `${folder}/${found.name}`;
      if (acceptEntry(name)) entries.push({ name, file: path.join(dir, found.name), size: found.size, mtimeMs: found.mtimeMs });
    }
  }
  return entries;
}

/** Where a name from a data file belongs on this machine. */
export function placeOf(folders, name) {
  const [folder, ...rest] = name.split('/');
  return path.join(folders[folder], ...rest);
}
