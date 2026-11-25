// A compilation: videos and cards in order, saved as JSON so it can be
// opened again and rendered again.
//
//   data/compilations/<id>/timeline.json
//   data/compilations/<id>/final.mp4, description.txt, made.json   (after Generate)
//   data/compilations/<id>/work/                         (segments, kept for the next run)
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { isId } from '../cards/match.js';
import { DEFAULT_POST } from './description.js';
import { isSoundChoice } from './sounds.js';

/** The two output shapes, both at 30 frames a second. */
export const PRESETS = {
  landscape: { width: 1920, height: 1080 },
  portrait: { width: 1080, height: 1920 },
};
export const DEFAULT_CARD_SECONDS = 3;

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const seconds = z.number().min(0).max(86400).nullable();

// "combined" holds the videos made on the Combine page, each named by its combination's id.
const library = z.enum(['in', 'parts', 'clips', 'combined']);
const videoName = z.string().min(1).max(200);

/**
 * How much of a second video's sound is heard with the first video's:
 * "even" is about half and half, "low" keeps the first clearly in front
 * (about 70 to 30), and "off" leaves the second video silent.
 */
export const BESIDE_SOUNDS = ['even', 'low', 'off'];
// Timelines saved before there were three choices have true or false here.
const besideSound = z.preprocess((value) => (value === true ? 'even' : value === false ? 'off' : value), z.enum(BESIDE_SOUNDS)).default('even');

// A second video shown beside the first while it plays: the goal a streamer
// is reacting to. For as long as it runs the screen is split between the two,
// and when it ends the first video fills the screen.
const besideVideo = z.strictObject({
  library, name: videoName,
  start: seconds.default(null),
  end: seconds.default(null),
  sound: besideSound,
});

// A video is named by the folder it is in and its name there, never by a path.
const videoItem = z.strictObject({
  id, kind: z.literal('video'),
  library,
  name: videoName,
  start: seconds.default(null), // null means from the beginning
  end: seconds.default(null), // null means to the end
  credit: z.string().trim().max(60).default(''),
  beside: besideVideo.nullable().default(null), // null means the video is shown alone
});
const cardItem = z.strictObject({
  id, kind: z.literal('card'), matchId: id, cardId: id,
  // null means "as long as its sound", or DEFAULT_CARD_SECONDS for a silent card.
  seconds: z.number().min(0.5).max(60).nullable().default(null),
  // What plays under the card (see sounds.js). "auto" is the sound for its
  // kind of card; compilations saved before sounds existed get it too.
  sound: z.string().max(210).refine(isSoundChoice, 'choose "auto", "none" or a file from the sounds folder').default('auto'),
});

// The owner's own text for the video's page where it is posted (see description.js). A
// compilation saved before this existed has none and gets the starting text.
const typed = (key, max) => z.string().max(max).default(DEFAULT_POST[key]);
const post = z.strictObject({
  title: typed('title', 200),
  fanText: typed('fanText', 600),
  footageText: typed('footageText', 600),
  footage: typed('footage', 2000),
  callToAction: typed('callToAction', 600),
  keywords: typed('keywords', 1500),
  hashtags: typed('hashtags', 2000),
  music: typed('music', 600),
  tags: typed('tags', 1500),
});

export const timelineSchema = z.strictObject({
  id,
  name: z.string().trim().min(1).max(80),
  preset: z.enum(Object.keys(PRESETS)).default('landscape'),
  items: z.array(z.discriminatedUnion('kind', [videoItem, cardItem])).max(200).default([]),
  post: post.default({ ...DEFAULT_POST }),
});

/** @typedef {z.infer<typeof timelineSchema>} Timeline */

export function parseTimeline(data) {
  const result = timelineSchema.safeParse(data);
  if (!result.success) throw new Error(`The compilation is not valid:\n${z.prettifyError(result.error)}`);
  return result.data;
}

export const compilationDir = (dataDir, compilationId) => path.join(dataDir, 'compilations', compilationId);

export async function listCompilations(dataDir) {
  const ids = (await readdir(path.join(dataDir, 'compilations')).catch(() => [])).filter(isId);
  const all = await Promise.all(ids.map((compilationId) => readTimeline(dataDir, compilationId).catch(() => null)));
  return all.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}

export async function readTimeline(dataDir, compilationId) {
  if (!isId(compilationId)) throw new Error('No such compilation.');
  let text;
  try {
    text = await readFile(path.join(compilationDir(dataDir, compilationId), 'timeline.json'), 'utf8');
  } catch {
    throw new Error('No such compilation.');
  }
  return parseTimeline(JSON.parse(text));
}

export async function saveTimeline(dataDir, data) {
  const timeline = parseTimeline(data);
  const dir = compilationDir(dataDir, timeline.id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'timeline.json'), `${JSON.stringify(timeline, null, 2)}\n`);
  return timeline;
}

export async function deleteCompilation(dataDir, compilationId) {
  await readTimeline(dataDir, compilationId); // throws unless it is a saved compilation
  await rm(compilationDir(dataDir, compilationId), { recursive: true });
}

/** A free id for a new compilation, from its name. */
export async function newCompilationId(dataDir, name) {
  const base = name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || 'compilation';
  const taken = await readdir(path.join(dataDir, 'compilations')).catch(() => []);
  let free = base;
  for (let n = 2; taken.includes(free); n++) free = `${base}-${n}`;
  return free;
}
