// Sounds played under a card in a compilation.
//
// A card's sound is one of:
//   "auto"            the owner's file named after the kind of card (goal, red,
//                     fulltime) if the sounds folder has one, else silence
//   "none"            silence
//   "file:<name>"     a sound file the owner put in the sounds folder
//
// Until 2026-11-25 a video file there could be a card's sound too, with its picture moving
// behind the card (built for the intro card). The owner had both removed. A compilation
// saved with such a choice still opens; making it says to choose another sound.
//
// Every sound is the owner's own file. The tool once made three itself (a computer
// voice saying "Goool", a chord and a whistle, written "builtin:<id>"); the owner had
// them removed on 2026-11-24. A card saved with one says so when the video is made.
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../run.js';

/** The kinds of card. A file in the sounds folder named after one is that kind's sound when the choice is "auto". */
export const CARD_KINDS = ['goal', 'red', 'fulltime'];

const SOUND_TYPES = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.opus', '.flac']);
// The endings a card's sound could have while a video could play behind a card.
const OLD_VIDEO_TYPES = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v']);
const isOldVideoName = (name) => isPlainName(name) && OLD_VIDEO_TYPES.has(path.extname(name).toLowerCase());
// A file's own name, with nothing in it that could lead out of the folder.
const isPlainName = (name) => typeof name === 'string' && name.length <= 200 && !/[\\/\0]/.test(name) && !name.startsWith('.');

/** Whether `name` could be a sound in the sounds folder. */
export function isSoundFileName(name) {
  return isPlainName(name) && SOUND_TYPES.has(path.extname(name).toLowerCase());
}

/**
 * Whether `choice` is written as a sound choice. It may still name a sound that does not exist.
 * The removed "builtin:<id>" and a removed video file are still read, so a compilation saved
 * with one opens; it cannot be made.
 */
export function isSoundChoice(choice) {
  if (choice === 'auto' || choice === 'none') return true;
  if (typeof choice !== 'string') return false;
  if (choice.startsWith('builtin:')) return /^[a-z]{1,30}$/.test(choice.slice(8));
  return choice.startsWith('file:') && (isSoundFileName(choice.slice(5)) || isOldVideoName(choice.slice(5)));
}

/** The owner's sound files, by name. An empty list when the folder is missing. */
export async function listSoundFiles(soundsDir) {
  if (!soundsDir) return [];
  const names = await readdir(soundsDir).catch(() => []);
  return names.filter(isSoundFileName).sort((a, b) => a.localeCompare(b));
}

/**
 * What "auto" stands for on each kind of card: the owner's file named after
 * the kind (goal.mp3, red.wav, fulltime.m4a and so on) when there is one,
 * else silence. So dropping a file into the sounds folder gives every card of
 * that kind its sound, with nothing to set.
 *
 * @param {string} [soundsDir]
 * @returns {Promise<Record<string, string>>} a sound choice for each kind of card
 */
export async function automaticSounds(soundsDir) {
  const files = await listSoundFiles(soundsDir);
  return Object.fromEntries(CARD_KINDS.map((cardType) => {
    const own = files.find((name) => path.basename(name, path.extname(name)).toLowerCase() === cardType);
    return [cardType, own ? `file:${own}` : 'none'];
  }));
}

/**
 * How long a file from the sounds folder plays, in seconds. Null when it has no sound that
 * can be read.
 *
 * @returns {Promise<number | null>}
 */
export async function soundSeconds(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', file]).catch(() => ({ stdout: '{}' }));
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  const seconds = Number(data.format?.duration);
  return seconds > 0 && (data.streams ?? []).some((stream) => stream.codec_type === 'audio') ? seconds : null;
}

/**
 * Turn a card's sound choice into the file to play, or null for silence.
 *
 * @param {object} options
 * @param {string} options.choice      "auto", "none" or "file:<name>"
 * @param {string} options.cardType    "goal", "red" or "fulltime"
 * @param {string} [options.soundsDir] the owner's sounds folder
 * @returns {Promise<{ file: string, seconds: number, quieter: number, recipe: unknown[] } | null>}
 *   `seconds` is how long it plays. `recipe` changes whenever it would
 *   come out differently, so a segment made with it is made again.
 */
export async function resolveSound({ choice, cardType, soundsDir }) {
  const chosen = choice === 'auto' ? (await automaticSounds(soundsDir))[cardType] ?? 'none' : choice;
  if (chosen === 'none') return null;

  if (chosen.startsWith('builtin:')) {
    throw new Error(`its sound "${chosen.slice(8)}" was one the tool made, and those were removed. Choose another sound for the card.`);
  }

  const name = chosen.slice(5);
  if (chosen.startsWith('file:') && isOldVideoName(name)) {
    throw new Error(`its sound "${name}" is a video, and a video behind a card was removed. Choose another sound for the card.`);
  }
  if (!chosen.startsWith('file:') || !isSoundFileName(name)) throw new Error(`its sound "${chosen}" is not one this tool knows.`);
  if (!soundsDir) throw new Error(`its sound "${name}" needs a sounds folder, and none was given.`);
  const file = path.join(path.resolve(soundsDir), name);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new Error(`its sound "${name}" is not in the sounds folder. Put it back, or choose another sound for the card.`);
  const seconds = await soundSeconds(file);
  if (!seconds) throw new Error(`its sound "${name}" has no sound in it that can be read.`);
  return { file, seconds, quieter: 0, recipe: ['file', file, info.size, Math.round(info.mtimeMs)] };
}
