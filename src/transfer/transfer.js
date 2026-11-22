// Moving the owner's data from one machine to another: one file to download
// here, and the same file loaded there.
//
//   download   everything in contents.js, as a tar file, streamed from disk
//              (the owner chose what travels; videos and what is made from them stay local)
//   load       1. the file is taken into a waiting folder (data/.incoming)
//                 and checked: plain files only, in known places, and lists
//                 that this tool can read
//              2. the owner is shown what is in it beside what is here
//              3. only then is it put in place
//
// A load never deletes. A file from the data file takes the place of the file
// with the same name here, and the one it replaces is moved into
// data/backups/before-load-<time>/, which is never cleaned out. So a load of
// the wrong file, or of an old one, can be undone by hand.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, open, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseLibrary, readLibrary, replaceLibrary } from '../cards/clubs.js';
import { replaceSubscribers } from '../pictures.js';
import { parseSources, readSources, saveSources } from '../sources.js';
import { acceptEntry, LISTS, listTransfer, placeOf } from './contents.js';
import { readTar, tarSize, tarStream } from './tar.js';

/** @typedef {import('./contents.js').Folders} Folders */

const MANIFEST = 'manifest.json';
const FORMAT = 1;
// Files up to this size are compared byte for byte to tell "the same" from "different".
// Above it, a file of the same name and the same size is taken to be the same: a video.
const COMPARE_UP_TO = 16 * 1024 * 1024;

const waitingDir = (folders) => path.join(folders.data, '.incoming');
const waitingFiles = (folders) => path.join(waitingDir(folders), 'files');
const waitingNote = (folders) => path.join(waitingDir(folders), 'staged.json');
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

// --- What a set of data amounts to, in numbers the owner knows --------------------

/**
 * @param {string[]} names   names as in a data file
 * @param {{ sources: unknown[] | null, library: { leagues: unknown[], clubs: any[] } | null }} lists
 */
function count(names, lists) {
  const files = (shape) => names.filter((name) => shape.test(name)).length;
  return {
    channels: lists.sources?.length ?? 0,
    channelsWithClub: lists.sources?.filter((source) => source.clubs.length > 0).length ?? 0,
    channelPictures: files(/^data\/source-pictures\//),
    leagues: lists.library?.leagues.length ?? 0,
    clubs: lists.library?.clubs.length ?? 0,
    clubsWithLogo: lists.library?.clubs.filter((club) => club.icon).length ?? 0,
    sounds: files(/^sounds\//),
    overlays: files(/^overlays\//),
    briefs: files(/^briefs\//),
  };
}

/** What is on this machine now. */
export async function countHere(folders) {
  const names = (await listTransfer(folders)).map((entry) => entry.name);
  // The lists are read as they are on disk: reading must not write the starting list of clubs out.
  const library = await stat(placeOf(folders, LISTS.clubs)).then(() => readLibrary(folders.data), () => null).catch(() => null);
  return count(names, { sources: await readSources(folders.data).catch(() => null), library });
}

// --- Download ---------------------------------------------------------------------

/**
 * A data file, ready to be sent.
 *
 * @param {Folders} folders
 * @returns {Promise<{ bytes: number, files: number, name: string, stream: () => AsyncGenerator<Buffer> }>}
 */
export async function dataFile(folders) {
  const entries = await listTransfer(folders);
  const made = new Date();
  const note = Buffer.from(`${JSON.stringify({ tool: 'wlc-clipper', format: FORMAT, made: made.toISOString(), holds: await countHere(folders) }, null, 2)}\n`);
  const all = [{ name: MANIFEST, size: note.length, mtimeMs: made.getTime(), content: note }, ...entries];
  return {
    bytes: tarSize(all),
    files: entries.length,
    name: `wlc-clipper-data-${made.toISOString().slice(0, 10)}.tar`,
    stream: () => tarStream(all),
  };
}

// --- Load, step 1: take the file in and check it -----------------------------------

async function sameFile(a, b) {
  const [first, second] = await Promise.all([stat(a).catch(() => null), stat(b).catch(() => null)]);
  if (!first || !second || first.size !== second.size) return false;
  if (first.size > COMPARE_UP_TO) return true;
  const hash = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
  return (await hash(a)) === (await hash(b));
}

/**
 * Take an uploaded data file into the waiting folder and say what is in it.
 * Nothing on this machine is changed. A file that cannot be trusted or read
 * leaves nothing behind.
 *
 * @param {Folders} folders
 * @param {AsyncIterable<Buffer>} stream   the uploaded file
 * @param {number} bytes                   its size, for the free-space check
 */
export async function takeIn(folders, stream, bytes) {
  await discardWaiting(folders);
  const disk = await statfs(folders.data).catch(() => null);
  if (disk && disk.bavail * disk.bsize < bytes + 200_000_000) {
    throw new Error(`There is not enough free disk space to load this file (${(bytes / 1e9).toFixed(2)} GB).`);
  }
  const files = waitingFiles(folders);
  await mkdir(files, { recursive: true });
  const names = [];
  let passedOver = 0;
  try {
    await readTar(stream, async (name) => {
      if (name !== MANIFEST && !acceptEntry(name)) {
        passedOver++;
        return null;
      }
      if (names.includes(name)) throw new Error(`The file holds "${name}" twice. Nothing was loaded.`);
      names.push(name);
      const target = path.join(files, name);
      await mkdir(path.dirname(target), { recursive: true });
      const handle = await open(target, 'wx');
      return { write: async (piece) => void (await handle.write(piece)), close: () => handle.close() };
    });

    const read = async (name) => (names.includes(name) ? JSON.parse(await readFile(path.join(files, name), 'utf8')) : null);
    const note = await read(MANIFEST).catch(() => null);
    if (note?.tool !== 'wlc-clipper' || note.format !== FORMAT) throw new Error('This is not a data file made by this tool.');
    // The lists are read with the tool's own checks. A list it cannot read stops the load here.
    const sources = await read(LISTS.sources).then((data) => (data === null ? null : parseSources(data)));
    const library = await read(LISTS.clubs).then((data) => (data === null ? null : parseLibrary(data)));
    await read(LISTS.subscribers);

    // What a load would replace: a file of the same name here that is not the same file.
    const replaces = [];
    for (const name of names) {
      if (name === MANIFEST) continue;
      const here = placeOf(folders, name);
      if (await stat(here).then(() => true, () => false) && !(await sameFile(here, path.join(files, name)))) replaces.push(name);
    }
    const data = names.filter((name) => name !== MANIFEST);
    const summary = {
      made: typeof note.made === 'string' ? note.made : null,
      bytes,
      files: data.length,
      passedOver,
      holds: count(data, { sources, library }),
      here: await countHere(folders),
      replaces,
    };
    await writeFile(waitingNote(folders), JSON.stringify({ ...summary, names: data }));
    return summary;
  } catch (error) {
    await discardWaiting(folders);
    // Errors from the checks above are already in plain words; anything else is a file this tool cannot read.
    throw new Error(/^(The file|This is not|There is not|The sources list|The list of leagues)/.test(error.message) ? error.message : `The file could not be read. Nothing was loaded. (${error.message.split('\n')[0]})`);
  }
}

/** What is waiting to be loaded, or null. `here` is counted again, since it may have changed. */
export async function waiting(folders) {
  const note = await readFile(waitingNote(folders), 'utf8').then(JSON.parse, () => null);
  if (!note) return null;
  const { names: _names, ...summary } = note;
  return { ...summary, here: await countHere(folders) };
}

/** Throw away whatever is waiting. */
export async function discardWaiting(folders) {
  await rm(waitingDir(folders), { recursive: true, force: true });
}

// --- Load, step 2: put it in place ----------------------------------------------------

/** Move a file, also to another disk. */
async function move(from, to) {
  await mkdir(path.dirname(to), { recursive: true });
  await rename(from, to).catch(async (error) => {
    if (error.code !== 'EXDEV') throw error;
    await copyFile(from, to);
    await rm(from, { force: true });
  });
}

/**
 * Put the waiting data in place. Files first, the three lists last, so a
 * list never points at a picture or a video that has not arrived.
 *
 * @param {Folders} folders
 * @returns {Promise<{ added: number, replaced: number, same: number, kept: string | null }>}
 *   `kept` is the folder, under the data folder, that holds everything that was replaced
 */
export async function putInPlace(folders) {
  const note = await readFile(waitingNote(folders), 'utf8').then(JSON.parse, () => null);
  if (!note) throw new Error('No data file is waiting to be loaded. Choose the file again.');
  const files = waitingFiles(folders);
  const lists = Object.values(LISTS);
  // Read and checked again, here, before anything is touched.
  const read = async (name) => (note.names.includes(name) ? JSON.parse(await readFile(path.join(files, name), 'utf8')) : null);
  const sources = await read(LISTS.sources).then((data) => (data === null ? null : parseSources(data)));
  const library = await read(LISTS.clubs).then((data) => (data === null ? null : parseLibrary(data)));
  const subscribers = await read(LISTS.subscribers);

  const kept = path.join('backups', `before-load-${stamp()}`);
  const keptDir = path.join(folders.data, kept);
  const report = { added: 0, replaced: 0, same: 0, kept: null };
  const keep = async (name, how) => {
    const here = placeOf(folders, name);
    if (!(await stat(here).then(() => true, () => false))) return false;
    await mkdir(path.dirname(path.join(keptDir, name)), { recursive: true });
    await (how === 'copy' ? copyFile(here, path.join(keptDir, name)) : move(here, path.join(keptDir, name)));
    report.kept = kept;
    return true;
  };

  for (const name of note.names.filter((one) => !lists.includes(one))) {
    const from = path.join(files, name);
    const here = placeOf(folders, name);
    if (await sameFile(here, from)) {
      report.same++;
      continue;
    }
    // What is here is moved aside, never deleted, and the new file takes its name.
    if (await keep(name, 'move')) report.replaced++;
    else report.added++;
    await move(from, here);
  }

  // The lists go through the functions that write them everywhere else. A copy of each as it stood is kept with the rest.
  const list = async (name, fresh, write) => {
    if (fresh === null) return;
    if (await sameFile(placeOf(folders, name), path.join(files, name))) {
      report.same++;
      return;
    }
    if (await keep(name, 'copy')) report.replaced++;
    else report.added++;
    await write(fresh);
  };
  await list(LISTS.clubs, library, (fresh) => replaceLibrary(folders.data, fresh));
  await list(LISTS.subscribers, subscribers, (fresh) => replaceSubscribers(folders.data, fresh));
  await list(LISTS.sources, sources, (fresh) => saveSources(folders.data, fresh));

  await discardWaiting(folders);
  return report;
}
