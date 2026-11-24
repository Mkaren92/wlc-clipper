// Combinations: two videos shown side by side, saved in the data folder.
//
//   data/combinations/<id>/combination.json   the settings
//   data/combinations/<id>/combined.mp4       the video made from them
//   data/combinations/<id>/made-from.json     the settings that video was made from
//
// A combination is a reaction beside the thing reacted to: the screen is
// split between the two while both run, and when the shorter one ends the
// main video has the whole screen. The finished video can be added to a
// compilation like any other.
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { isId } from '../cards/match.js';
import { BESIDE_SOUNDS } from '../compilation/timeline.js';
import { COMBINE_SIZES, MAIN_SHARES, MAX_ZOOM } from './layout.js';

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const seconds = z.number().min(0).max(86400).nullable();
const share = z.number().min(0).max(1).default(0.5);

// A video is named by the folder it is in and its name there, never by a path.
const video = z.strictObject({
  library: z.enum(['in', 'parts', 'clips']),
  name: z.string().min(1).max(200),
  start: seconds.default(null), // null means from the beginning
  end: seconds.default(null), // null means to the end
  // The sync mark: the moment, in this video's own seconds, that must meet the other video's (2026-11-24).
  mark: seconds.default(null),
  // Which part of it shows in its half of the screen (see shownPart in layout.js).
  zoom: z.number().min(1).max(MAX_ZOOM).default(1),
  x: share,
  y: share,
});

export const combinationSchema = z.strictObject({
  id,
  name: z.string().trim().min(1).max(80),
  preset: z.enum(Object.keys(COMBINE_SIZES)).default('landscape'),
  // The video on the left and the one on the right. In a tall video the left one is on top.
  left: video.nullable().default(null),
  right: video.nullable().default(null),
  // The main video sets the length, and has the whole screen once the other has ended.
  main: z.enum(['left', 'right']).default('left'),
  // How much of the screen the main video has while it is split, in percent: 50, 60 or 70.
  mainShare: z.number().refine((value) => MAIN_SHARES.includes(value), 'the main video has 50, 60 or 70 percent of the screen').default(50),
  // How much of the other video's sound is heard with the main one's.
  sound: z.enum(BESIDE_SOUNDS).default('low'),
});

/** @typedef {z.infer<typeof combinationSchema>} Combination */

export function parseCombination(data) {
  const result = combinationSchema.safeParse(data);
  if (!result.success) throw new Error(`The combination is not valid:\n${z.prettifyError(result.error)}`);
  return result.data;
}

export const combinationDir = (dataDir, combinationId) => path.join(dataDir, 'combinations', combinationId);
/** The video made from a combination. It is there only once it has been generated. */
export const combinedFile = (dataDir, combinationId) => path.join(combinationDir(dataDir, combinationId), 'combined.mp4');
export const madeFromFile = (dataDir, combinationId) => path.join(combinationDir(dataDir, combinationId), 'made-from.json');

export async function listCombinations(dataDir) {
  const ids = (await readdir(path.join(dataDir, 'combinations')).catch(() => [])).filter(isId);
  const all = await Promise.all(ids.map((combinationId) => readCombination(dataDir, combinationId).catch(() => null)));
  return all.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}

export async function readCombination(dataDir, combinationId) {
  if (!isId(combinationId)) throw new Error('No such combination.');
  let text;
  try {
    text = await readFile(path.join(combinationDir(dataDir, combinationId), 'combination.json'), 'utf8');
  } catch {
    throw new Error('No such combination.');
  }
  return parseCombination(JSON.parse(text));
}

export async function saveCombination(dataDir, data) {
  const combination = parseCombination(data);
  const dir = combinationDir(dataDir, combination.id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'combination.json'), `${JSON.stringify(combination, null, 2)}\n`);
  return combination;
}

export async function deleteCombination(dataDir, combinationId) {
  await readCombination(dataDir, combinationId); // throws unless it is a saved combination
  await rm(combinationDir(dataDir, combinationId), { recursive: true });
}

/** A free id for a new combination, from its name. */
export async function newCombinationId(dataDir, name) {
  const base = name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || 'combination';
  const taken = await readdir(path.join(dataDir, 'combinations')).catch(() => []);
  let free = base;
  for (let n = 2; taken.includes(free); n++) free = `${base}-${n}`;
  return free;
}

/**
 * What has been made from a combination: null until it is generated, else
 * the file's size, a number that changes when it is made again, and whether
 * the settings have changed since (the name aside, which is not in the video).
 *
 * @param {string} dataDir
 * @param {Combination} combination
 */
export async function combinedResult(dataDir, combination) {
  const made = await stat(combinedFile(dataDir, combination.id)).catch(() => null);
  if (!made?.isFile()) return null;
  // What it was made from is read as a combination, so a setting added to the
  // tool since then counts as its default and not as a change.
  let from = '';
  try {
    from = madeFrom(parseCombination({ ...JSON.parse(await readFile(madeFromFile(dataDir, combination.id), 'utf8')), name: combination.name }));
  } catch {
    // No record, or one that cannot be read: treated as changed.
  }
  return { version: Math.round(made.mtimeMs), size: made.size, changedSince: from !== madeFrom(combination) };
}

/** The settings a video depends on, as text, for telling whether they have changed. */
export function madeFrom({ name: _name, ...settings }) {
  return JSON.stringify(settings);
}
