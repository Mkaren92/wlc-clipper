// Sounds played under a card in a compilation.
//
// A card's sound is one of:
//   "auto"            the owner's file named after the kind of card (intro,
//                     goal, red, fulltime) if the sounds folder has one, else
//                     the built-in sound for that kind (see DEFAULT_SOUND)
//   "none"            silence
//   "builtin:<id>"    one of BUILT_IN
//   "file:<name>"     a file the owner put in the sounds folder: a sound, or a
//                     video, whose moving picture then also goes behind the card
//
// The built-in sounds are made here, by ffmpeg: a computer voice and plain
// tones. They are not recordings of anything, so there is nothing to download
// and nobody's rights are involved. Each is made once, into a file, and from
// then on is treated exactly like one of the owner's files.
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../run.js';

// Change this when a built-in sound's recipe changes, so it is made again
// and every card segment that used it is made again too.
export const SOUND_VERSION = 2;

/** One note with two overtones: struck at `from`, dying away at `rate`, cut off at `to`. */
const note = (hz, from, to, rate) =>
  `(0.5*sin(2*PI*${hz}*t)+0.25*sin(2*PI*${hz}*2*t)+0.12*sin(2*PI*${hz}*3*t))*clip((t-${from})/0.03,0,1)*exp(-${rate}*max(0,t-${from}))*lt(t,${to})`;
/** 1 between `from` and `to` seconds, eased in and out so it neither clicks nor bites. */
const breath = (from, to) => `clip((t-${from})/0.06,0,1)*clip((${to}-t)/0.18,0,1)`;

/**
 * @type {Record<string, { name: string, longest: number, quieter: number, graph: string }>}
 * `graph` is an ffmpeg source that produces the sound; it names no file.
 * `longest` cuts it off, in seconds. `quieter` is how many dB under the other
 * card sounds it is played.
 */
export const BUILT_IN = {
  goal: {
    name: 'Voice: "Goool" (a computer voice)',
    longest: 6,
    quieter: 0,
    // The word "Goal" from the speech voice inside ffmpeg, with its vowel
    // stretched to about two seconds and a little echo. The cut points are
    // where that voice's "o" begins and ends.
    graph: [
      "flite=text='Goal.':voice=rms,aresample=48000,asplit=3[a][b][c]",
      // The "g" is faint in this voice, so it is made three times as loud.
      // Without that the speech recogniser heard only "Oh".
      '[a]atrim=0.10:0.25,asetpts=PTS-STARTPTS,volume=3[g]',
      '[b]atrim=0.25:0.47,asetpts=PTS-STARTPTS,rubberband=tempo=0.11:pitch=1.1[o]',
      '[c]atrim=0.47,asetpts=PTS-STARTPTS,rubberband=tempo=0.5:pitch=1.1[l]',
      '[g][o][l]concat=n=3:v=0:a=1,aecho=0.8:0.5:110|220:0.22|0.12',
    ].join(';'),
  },
  tragic: {
    name: 'Tragic chord (low notes stepping down)',
    longest: 4.6,
    quieter: 2,
    // Three low notes stepping down in a minor key, then a long dark chord
    // over one drum beat, dying away with an echo.
    graph: `aevalsrc='0.5*(${[
      note(220, 0, 0.55, 2.5), note(174.61, 0.55, 1.1, 2.5), note(146.83, 1.1, 1.7, 2.2),
      note(73.42, 1.7, 5, 0.9), `0.8*${note(110, 1.7, 5, 0.9)}`, `0.7*${note(130.81, 1.7, 5, 1)}`,
      '1.6*sin(2*PI*55*t)*exp(-6*max(0,t-1.7))*gte(t,1.7)',
    ].join('+')})':s=48000,lowpass=f=1400,aecho=0.8:0.6:160|320:0.3|0.2`,
  },
  whistle: {
    name: 'Soft whistle (a low, rounded tone)',
    longest: 2.9,
    quieter: 9,
    // Half the pitch of a real referee's whistle, with nothing above 3 kHz,
    // eased in and out: two short notes and a longer one.
    graph: `aevalsrc='0.35*sin(2*PI*1568*t+1.2*sin(2*PI*5.5*t))*(${breath(0.05, 0.45)}+${breath(0.6, 1)}+${breath(1.15, 2.5)})':s=48000,lowpass=f=3000,aecho=0.8:0.4:70:0.2`,
  },
};

/**
 * The built-in sound a card gets when its choice is "auto", by the kind of
 * card. An intro card has none of its own: it is silent until the owner puts
 * a file named "intro" in the sounds folder.
 */
export const DEFAULT_SOUND = { intro: null, goal: 'goal', red: 'tragic', fulltime: 'whistle' };

const AUDIO_TYPES = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.opus', '.flac']);
// A video in the sounds folder gives a card its sound and a moving background.
const VIDEO_TYPES = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v']);
const SOUND_TYPES = new Set([...AUDIO_TYPES, ...VIDEO_TYPES]);
const isVideoName = (name) => VIDEO_TYPES.has(path.extname(name).toLowerCase());
// A file's own name, with nothing in it that could lead out of the folder.
const isPlainName = (name) => typeof name === 'string' && name.length <= 200 && !/[\\/\0]/.test(name) && !name.startsWith('.');

/** Whether `name` could be a sound in the sounds folder. */
export function isSoundFileName(name) {
  return isPlainName(name) && SOUND_TYPES.has(path.extname(name).toLowerCase());
}

/** Whether `choice` is written as one of the four kinds. It may still name a sound that does not exist. */
export function isSoundChoice(choice) {
  if (choice === 'auto' || choice === 'none') return true;
  if (typeof choice !== 'string') return false;
  if (choice.startsWith('builtin:')) return /^[a-z]{1,30}$/.test(choice.slice(8));
  return choice.startsWith('file:') && isSoundFileName(choice.slice(5));
}

/** The owner's sound files, by name. An empty list when the folder is missing. */
export async function listSoundFiles(soundsDir) {
  if (!soundsDir) return [];
  const names = await readdir(soundsDir).catch(() => []);
  return names.filter(isSoundFileName).sort((a, b) => a.localeCompare(b));
}

/**
 * What "auto" stands for on each kind of card: the owner's file named after
 * the kind (intro.mp3, goal.mp3, red.wav, fulltime.m4a and so on) when there is one,
 * else the built-in sound. So dropping three files into the sounds folder
 * replaces all three built-in sounds, on every card, with nothing to set.
 *
 * @param {string} [soundsDir]
 * @returns {Promise<Record<string, string>>} a sound choice for each kind of card
 */
export async function automaticSounds(soundsDir) {
  // When a sound and a video are both named after the kind, the video is used:
  // it has the sound and a picture as well.
  const files = (await listSoundFiles(soundsDir)).sort((a, b) => Number(isVideoName(b)) - Number(isVideoName(a)));
  return Object.fromEntries(Object.entries(DEFAULT_SOUND).map(([cardType, id]) => {
    const own = files.find((name) => path.basename(name, path.extname(name)).toLowerCase() === cardType);
    return [cardType, own ? `file:${own}` : id ? `builtin:${id}` : 'none'];
  }));
}

/**
 * The file of a built-in sound, made the first time it is asked for.
 *
 * @param {string} dataDir
 * @param {string} id   a key of BUILT_IN
 * @returns {Promise<string>} full path of a WAV file
 */
export async function builtInSoundFile(dataDir, id) {
  const sound = Object.hasOwn(BUILT_IN, id) ? BUILT_IN[id] : null;
  if (!sound) throw new Error(`There is no built-in sound called "${id}".`);
  const dir = path.join(path.resolve(dataDir), 'sounds-made');
  const file = path.join(dir, `${id}-v${SOUND_VERSION}.wav`);
  if (await stat(file).then(() => true, () => false)) return file;
  await mkdir(dir, { recursive: true });
  // Written under another name first, so a half-made sound is never used.
  // The name is this call's own: the page can ask to hear a sound while a
  // video that uses it is being made, and two writers must not share a file.
  const partial = path.join(dir, `.${id}-${randomUUID()}.partial.wav`);
  try {
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-t', String(sound.longest), '-i', sound.graph,
      '-af', 'aformat=sample_fmts=s16:channel_layouts=stereo', '-ar', '48000', '-c:a', 'pcm_s16le', '-f', 'wav', partial,
    ]);
    await rename(partial, file);
  } finally {
    await rm(partial, { force: true });
  }
  return file;
}

/**
 * What is in a file from the sounds folder: how long it plays, whether it
 * has sound, and whether it has a moving picture. The cover picture some
 * music files carry does not count as one. Null when nothing can be read.
 *
 * @returns {Promise<{ seconds: number, hasSound: boolean, hasPicture: boolean } | null>}
 */
export async function soundInfo(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type:stream_disposition=attached_pic:format=duration', '-of', 'json', file]).catch(() => ({ stdout: '{}' }));
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  const streams = data.streams ?? [];
  const seconds = Number(data.format?.duration);
  const hasSound = streams.some((stream) => stream.codec_type === 'audio');
  const hasPicture = streams.some((stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  return seconds > 0 && (hasSound || hasPicture) ? { seconds, hasSound, hasPicture } : null;
}

/** How long a file from the sounds folder plays, in seconds, or null when it cannot be read. */
export async function soundSeconds(file) {
  return (await soundInfo(file))?.seconds ?? null;
}

/**
 * Turn a card's sound choice into the file to play, or null for silence.
 *
 * @param {object} options
 * @param {string} options.choice      "auto", "none", "builtin:<id>" or "file:<name>"
 * @param {string} options.cardType    "goal", "red" or "fulltime"
 * @param {string} options.dataDir
 * @param {string} [options.soundsDir] the owner's sounds folder
 * @returns {Promise<{ file: string, seconds: number, quieter: number, hasSound: boolean, hasPicture: boolean, recipe: unknown[] } | null>}
 *   `seconds` is how long it plays. `hasPicture` says the file is a video,
 *   whose picture goes behind the card. `recipe` changes whenever it would
 *   come out differently, so a segment made with it is made again.
 */
export async function resolveSound({ choice, cardType, dataDir, soundsDir }) {
  const chosen = choice === 'auto' ? (await automaticSounds(soundsDir))[cardType] ?? 'none' : choice;
  if (chosen === 'none') return null;

  if (chosen.startsWith('builtin:')) {
    const id = chosen.slice(8);
    if (!Object.hasOwn(BUILT_IN, id)) throw new Error(`its sound "${id}" is not one of the built-in sounds. Choose another sound for the card.`);
    const file = await builtInSoundFile(dataDir, id);
    return { file, seconds: await soundSeconds(file), quieter: BUILT_IN[id].quieter, hasSound: true, hasPicture: false, recipe: ['builtin', id, SOUND_VERSION] };
  }

  const name = chosen.slice(5);
  if (!chosen.startsWith('file:') || !isSoundFileName(name)) throw new Error(`its sound "${chosen}" is not one this tool knows.`);
  if (!soundsDir) throw new Error(`its sound "${name}" needs a sounds folder, and none was given.`);
  const file = path.join(path.resolve(soundsDir), name);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new Error(`its sound "${name}" is not in the sounds folder. Put it back, or choose another sound for the card.`);
  const found = await soundInfo(file);
  if (!found) throw new Error(`its sound "${name}" has no sound in it that can be read.`);
  return { file, ...found, quieter: 0, recipe: ['file', file, info.size, Math.round(info.mtimeMs)] };
}
