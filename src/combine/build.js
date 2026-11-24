// Make the video of a combination: two videos side by side while both run,
// then the main one alone, filling the screen.
//
// The sums (lengths, and which part of each video shows) come from layout.js,
// which the page's preview uses too. This file only turns them into one
// ffmpeg run. The sound is levelled as in a compilation: the main video at
// its usual level throughout, the other added under it without scaling
// either, so the main one's level does not move when the other stops.
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AUDIO, besideLoudness, LOUDNESS, SILENCE, STEREO } from '../compilation/build.js';
import { OUT_FPS } from '../layout.js';
import { probe } from '../probe.js';
import { run } from '../run.js';
import { combinationDir, combinedFile, madeFrom, madeFromFile } from './combination.js';
import { COMBINE_SIZES, halves, lineUp, rangeOf, shownPart, timing } from './layout.js';

// A combined video is encoded here and once more when a compilation uses it,
// so this first encode is kept close to the source (see docs/decisions.md).
const VIDEO = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14'];
// Shorter than this is not a video anyone meant to make.
const SHORTEST = 0.5;

/**
 * @param {object} options
 * @param {import('./combination.js').Combination} options.combination
 * @param {string} options.dataDir
 * @param {(library: string, name: string) => Promise<string>} options.resolveVideo
 *   turns a video's folder and name into the file's path
 * @returns {Promise<{ file: string, seconds: number, split: number }>}
 *   `split` is how long the screen is shared, in seconds
 */
export async function buildCombination({ combination, dataDir, resolveVideo }) {
  const plan = await planCombination(combination, resolveVideo);
  const dir = combinationDir(dataDir, combination.id);
  await mkdir(dir, { recursive: true });
  // Written under another name first, so a half-made video is never offered.
  const partial = path.join(dir, 'combined.partial.mp4');
  try {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...combineArgs(plan), ...VIDEO, ...AUDIO, '-t', plan.seconds.toFixed(3), '-movflags', '+faststart', partial]);
    await rename(partial, combinedFile(dataDir, combination.id));
    await writeFile(madeFromFile(dataDir, combination.id), madeFrom(combination));
  } finally {
    await rm(partial, { force: true });
  }
  return { file: combinedFile(dataDir, combination.id), seconds: plan.seconds, split: plan.split };
}

/** Find both files and work out everything the run needs, so a missing file or an empty part is reported first. */
export async function planCombination(combination, resolveVideo) {
  const size = COMBINE_SIZES[combination.preset];
  const boxes = halves(size, combination.main, combination.mainShare);
  // With a sync mark on both videos, the main one's start is the one the marks give.
  const lined = lineUp(combination);
  if (lined.sync && 'problem' in lined.sync) throw new Error(lined.sync.problem);
  const sides = {};
  for (const side of ['left', 'right']) {
    const video = lined[side];
    if (!video) throw new Error(`Choose the video for the ${side} side first.`);
    const file = path.resolve(await resolveVideo(video.library, video.name));
    const info = await probe(file);
    if (!info.width || !info.height) throw new Error(`"${video.name}" has no picture.`);
    sides[side] = { file, ...rangeOf(video, info.duration), hasAudio: info.audioStreams > 0, part: shownPart(info, boxes[side], video), box: boxes[side] };
  }
  const main = sides[combination.main];
  const other = sides[combination.main === 'left' ? 'right' : 'left'];
  if (main.seconds < SHORTEST) throw new Error('The main video\'s part is shorter than half a second. Check its start and end.');
  if (other.seconds < 1 / OUT_FPS) throw new Error('The other video\'s part is empty. Check its start and end.');
  return {
    size, wide: boxes.wide, main, other, mainSide: combination.main,
    otherSound: other.hasAudio && combination.sound !== 'off' ? combination.sound : null,
    ...timing(main.seconds, other.seconds),
  };
}

/**
 * The inputs and the graph. The main video is input 0 and drives the length;
 * the other is input 1 and is cut to the time the screen is split.
 *
 * @param {Awaited<ReturnType<typeof planCombination>>} plan
 * @returns {string[]}
 */
export function combineArgs(plan) {
  const { width, height } = plan.size;
  const length = plan.seconds.toFixed(3);
  const until = plan.split.toFixed(3);
  // A video made to cover its half, enlarged as asked, with the chosen part kept.
  const half = ({ part, box }) => `scale=${part.width}:${part.height},crop=${box.width}:${box.height}:${part.x}:${part.y},setsar=1`;
  const [left, right] = plan.mainSide === 'left' ? ['main', 'other'] : ['other', 'main'];
  const picture = [
    // Each video is brought to the output frame rate first, as everywhere in this project.
    `[0:v:0]fps=${OUT_FPS},split=2[whole][part]`,
    // The main video alone: fitted inside the frame without stretching, the rest black.
    `[whole]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1[full]`,
    `[part]trim=duration=${until},${half(plan.main)}[main]`,
    `[1:v:0]fps=${OUT_FPS},${half(plan.other)}[other]`,
    `[${left}][${right}]${plan.wide ? 'hstack' : 'vstack'}=inputs=2[both]`,
    // The split picture covers the whole one until the other video ends, to the frame.
    `[full][both]overlay=0:0:enable='lt(t,${until})':eof_action=pass,setsar=1,format=yuv420p[v]`,
  ];
  const inputs = ['-ss', plan.main.start.toFixed(3), '-t', length, '-i', plan.main.file, '-ss', plan.other.start.toFixed(3), '-t', until, '-i', plan.other.file];

  const main = `${LOUDNESS},${STEREO},apad,atrim=duration=${length}`;
  const other = plan.otherSound ? `${besideLoudness(plan.otherSound)},apad,atrim=duration=${length}` : '';
  let sound;
  if (plan.main.hasAudio && plan.otherSound) {
    sound = `[0:a:0]${main}[m];[1:a:0]${other}[o];[m][o]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95:level=0[a]`;
  } else if (plan.main.hasAudio) {
    sound = `[0:a:0]${main}[a]`;
  } else if (plan.otherSound) {
    sound = `[1:a:0]${other}[a]`;
  } else {
    // Neither has sound: silence, so the file always has a sound track.
    return [...inputs, '-f', 'lavfi', '-t', length, '-i', SILENCE, '-filter_complex', picture.join(';'), '-map', '[v]', '-map', '2:a'];
  }
  return [...inputs, '-filter_complex', `${picture.join(';')};${sound}`, '-map', '[v]', '-map', '[a]'];
}
