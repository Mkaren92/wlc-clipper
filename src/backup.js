// Copies of the owner's own lists, kept from before each change.
//
//   data/backups/<name>/<time>.json
//
// The channels list and the clubs list hold hours of the owner's work
// (which club a streamer supports, a logo for every club). Each is one file
// that is written whole on every change, so one wrong write could wipe it.
// Before a list is written, the file as it stands is copied here, and only
// the newest few copies are kept. To go back, copy one over the list.
import { copyFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

/**
 * Keep a copy of `file` as it is now, before it is replaced by `next`.
 * Nothing is kept when there is no file yet or when nothing would change.
 * A failure to keep a copy never stops the save itself.
 *
 * @param {string} file     the list about to be written
 * @param {string} next     the text about to be written to it
 * @param {object} options
 * @param {string} options.dataDir
 * @param {string} options.name   the folder under data/backups, such as "sources"
 * @param {number} options.keep   how many copies to keep
 */
export async function keepCopy(file, next, { dataDir, name, keep }) {
  try {
    const now = await readFile(file, 'utf8').catch(() => null);
    if (now === null || now === next) return;
    const dir = path.join(dataDir, 'backups', name);
    await mkdir(dir, { recursive: true });
    // Sorts by time as text: 2026-11-20T18-22-45-123Z. A counter keeps two saves in one millisecond apart.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const taken = await readdir(dir);
    let copy = `${stamp}.json`;
    for (let n = 2; taken.includes(copy); n++) copy = `${stamp}_${n}.json`;
    await copyFile(file, path.join(dir, copy));
    const copies = [...taken, copy].filter((entry) => entry.endsWith('.json')).sort();
    for (const old of copies.slice(0, Math.max(0, copies.length - keep))) await rm(path.join(dir, old), { force: true });
  } catch {
    // The list is still saved; only the copy is missing.
  }
}
