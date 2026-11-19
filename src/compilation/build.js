// Turns a timeline into one video.
//
// Every item, video or card, is first made into a "segment": a short file
// with exactly the same picture size, frame rate and sound settings as all
// the others. Segments that match like that can be joined end to end without
// encoding anything again, which is fast and loses no quality.
import { createHash } from 'node:crypto';
import { access, mkdir, readdir, rename, rm, stat, statfs, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cardPngPath, readMatch } from '../cards/match.js';
import { cleanOverlayText, FONT_NAME } from '../captions/ass.js';
import { OUT_FPS } from '../layout.js';
import { probe } from '../probe.js';
import { run } from '../run.js';
import { formatAssTime, formatClock } from '../time.js';
import { buildDescription, cardTitle } from './description.js';
import { compilationDir, PRESETS } from './timeline.js';

/** @typedef {import('./timeline.js').Timeline} Timeline */

const FONTS_DIR = fileURLToPath(new URL('../../assets/fonts', import.meta.url));
const FONTS_LINK = 'fonts';
// Change this when the way a segment is made changes, so old segments are not reused.
const RECIPE = 'v1';

// The same for every segment. This is what makes them joinable.
const VIDEO = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18'];
const AUDIO = ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'];
const SILENCE = 'anullsrc=channel_layout=stereo:sample_rate=48000';
const LOUDNESS = 'loudnorm=I=-14:TP=-1.5:LRA=11';
// Rough room a second of finished video needs, for the free-space check.
const BYTES_PER_SECOND = 2_500_000;

/**
 * Render a compilation.
 *
 * Segments are kept in the compilation's work folder and reused when
 * nothing that went into them has changed, so a second run, or a run after
 * a failure, only makes what is missing.
 *
 * @param {object} options
 * @param {Timeline} options.timeline
 * @param {string} options.dataDir
 * @param {(library: string, name: string) => Promise<string>} options.resolveVideo
 *   turns a video's folder and name into the file's path
 * @param {Record<string, string>} [options.links]   channel links for the credits (see creditLinks in src/sources.js)
 * @param {(progress: { index: number, status: 'working' | 'done' | 'reused' } | { joining: true }) => void} [options.onProgress]
 * @returns {Promise<{ file: string, seconds: number, description: string,
 *   items: { id: string, seconds: number, reused: boolean }[] }>}
 */
export async function buildCompilation({ timeline, dataDir: givenDataDir, resolveVideo, links = {}, onProgress = () => {} }) {
  if (timeline.items.length === 0) throw new Error('Add at least one video or card before generating.');
  // ffmpeg runs inside the work folder, so every path handed to it must be a
  // full one: a path relative to where the tool was started would not be found.
  const dataDir = path.resolve(givenDataDir);
  const size = PRESETS[timeline.preset];
  const dir = compilationDir(dataDir, timeline.id);
  const workDir = path.join(dir, 'work');
  await mkdir(workDir, { recursive: true });

  // Work out every item first, so a missing file or a bad range is reported
  // before any time is spent encoding.
  const plans = [];
  for (const [index, item] of timeline.items.entries()) {
    plans.push(await (item.kind === 'card' ? planCard(item, timeline, dataDir) : planVideo(item, resolveVideo)).catch((error) => {
      throw new Error(`Item ${index + 1}: ${error.message}`);
    }));
  }
  await checkFreeSpace(dir, plans.reduce((sum, plan) => sum + plan.seconds, 0));

  const fontsLink = path.join(workDir, FONTS_LINK);
  await rm(fontsLink, { force: true });
  await symlink(FONTS_DIR, fontsLink, 'dir');

  const items = [];
  try {
    for (const [index, plan] of plans.entries()) {
      // The name says what went into the segment. If any of it changes, the
      // name changes, and the segment is made again.
      const name = `seg_${hash([RECIPE, timeline.preset, plan.recipe])}`;
      const file = path.join(workDir, `${name}.mp4`);
      const reused = await exists(file);
      if (!reused) {
        onProgress({ index, status: 'working' });
        await makeSegment(plan, { name, size, workDir });
      }
      const made = await probe(file);
      items.push({ id: plan.item.id, name, seconds: made.duration, reused, kind: plan.item.kind, credit: plan.item.credit, title: plan.title });
      onProgress({ index, status: reused ? 'reused' : 'done' });
    }

    onProgress({ joining: true });
    // The list holds only names made here, never a name a person typed.
    await writeFile(path.join(workDir, 'list.txt'), `${items.map((item) => `file '${item.name}.mp4'`).join('\n')}\n`);
    const partial = path.join(dir, 'final.partial.mp4');
    try {
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', '-movflags', '+faststart', partial], { cwd: workDir });
      await rename(partial, path.join(dir, 'final.mp4'));
    } finally {
      await rm(partial, { force: true });
    }
  } finally {
    await rm(fontsLink, { force: true });
  }

  // Segments no longer in the timeline are removed, so the folder does not grow for ever.
  const used = new Set(items.map((item) => item.name));
  for (const entry of await readdir(workDir)) {
    if (entry.startsWith('seg_') && !used.has(entry.replace(/\.[^.]+$/, '').replace(/\.partial$/, ''))) await rm(path.join(workDir, entry), { force: true });
  }

  // Chapter times come from the lengths the segments really have.
  const description = buildDescription(items, links);
  await writeFile(path.join(dir, 'description.txt'), description);
  const final = await probe(path.join(dir, 'final.mp4'));
  return {
    file: path.join(dir, 'final.mp4'),
    seconds: final.duration,
    description,
    items: items.map(({ id, seconds, reused }) => ({ id, seconds, reused })),
  };
}

// --- Planning -------------------------------------------------------------------

async function planCard(item, timeline, dataDir) {
  const match = await readMatch(dataDir, item.matchId).catch(() => {
    throw new Error('its match was deleted. Remove the card from the timeline.');
  });
  const card = match.cards.find((c) => c.id === item.cardId);
  if (!card) throw new Error('its card was deleted from the match. Remove it from the timeline.');
  const png = cardPngPath(dataDir, item.matchId, item.cardId, timeline.preset);
  const file = await stat(png).catch(() => {
    throw new Error('the card has no picture yet. Open its match in the card maker and press Save.');
  });
  return {
    item, png, seconds: item.seconds, title: cardTitle(match, card),
    recipe: ['card', png, file.size, Math.round(file.mtimeMs), item.seconds],
  };
}

async function planVideo(item, resolveVideo) {
  const source = path.resolve(await resolveVideo(item.library, item.name));
  const info = await probe(source);
  const start = item.start ?? 0;
  const end = item.end ?? info.duration;
  if (end <= start) throw new Error(`"${item.name}": the end (${formatClock(end)}) must be after the start (${formatClock(start)}).`);
  if (end > info.duration + 0.05) throw new Error(`"${item.name}" is only ${formatClock(info.duration)} long, but its end is set to ${formatClock(end)}.`);
  const file = await stat(source);
  const credit = cleanOverlayText(item.credit ?? '');
  return {
    item: { ...item, credit }, source, start, seconds: Math.min(end, info.duration) - start, hasAudio: info.audioStreams > 0, credit,
    recipe: ['video', source, file.size, Math.round(file.mtimeMs), start, end, credit],
  };
}

// --- Making a segment -----------------------------------------------------------

async function makeSegment(plan, { name, size, workDir }) {
  const { width, height } = size;
  const length = plan.seconds.toFixed(3);
  // Written under another name first, so a run that is stopped half way
  // leaves nothing that looks like a finished segment.
  const partial = `${name}.partial.mp4`;
  let args;

  if (plan.png) {
    args = [
      '-loop', '1', '-framerate', String(OUT_FPS), '-t', length, '-i', plan.png,
      '-f', 'lavfi', '-t', length, '-i', SILENCE,
      '-vf', `scale=${width}:${height},setsar=1,fps=${OUT_FPS},format=yuv420p`,
      '-map', '0:v', '-map', '1:a',
    ];
  } else {
    const steps = [
      // Fit inside the frame without stretching, and fill the rest with black.
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
      'setsar=1',
      `fps=${OUT_FPS}`,
    ];
    if (plan.credit) {
      await writeFile(path.join(workDir, `${name}.ass`), creditSubtitles(plan.credit, size, plan.seconds));
      steps.push(`subtitles=${name}.ass:fontsdir=${FONTS_LINK}`);
    }
    steps.push('format=yuv420p');
    // -ss and -t both before -i, as everywhere in this project.
    args = ['-ss', plan.start.toFixed(3), '-t', length, '-i', plan.source];
    args.push(...(plan.hasAudio
      // Level the loudness, so clips from different streams sit together. apad
      // fills any gap at the end, so picture and sound are exactly as long.
      ? ['-vf', steps.join(','), '-af', `${LOUDNESS},aresample=48000,apad`, '-map', '0:v:0', '-map', '0:a:0']
      // A video with no sound gets silence. Without a sound track the join would fail.
      : ['-f', 'lavfi', '-t', length, '-i', SILENCE, '-vf', steps.join(','), '-map', '0:v:0', '-map', '1:a']));
  }

  try {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, ...VIDEO, ...AUDIO, '-t', length, partial], { cwd: workDir });
    await rename(path.join(workDir, partial), path.join(workDir, `${name}.mp4`));
  } finally {
    await rm(path.join(workDir, partial), { force: true });
  }
}

/**
 * A subtitle file that shows one small label, bottom left, for a whole clip.
 * The same method as the captions (burned in with the bundled font), on a
 * canvas the size of this compilation.
 *
 * @param {string} credit
 * @param {{ width: number, height: number }} size
 * @param {number} seconds
 */
export function creditSubtitles(credit, { width, height }, seconds) {
  const fontSize = Math.round(Math.min(width, height) * 0.037);
  const margin = Math.round(Math.min(width, height) * 0.04);
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Credit,${FONT_NAME},${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3,0,1,${margin},${margin},${margin},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,${formatAssTime(0)},${formatAssTime(seconds)},Credit,,0,0,0,,${cleanOverlayText(credit)}
`;
}

// --- Small helpers ----------------------------------------------------------------

function hash(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

async function exists(file) {
  return access(file).then(() => true, () => false);
}

/** Stop before starting if the disk clearly cannot hold the result. */
async function checkFreeSpace(dir, seconds) {
  const disk = await statfs(dir).catch(() => null);
  if (!disk) return;
  const free = disk.bavail * disk.bsize;
  // The segments and the joined file both exist at the end.
  const needed = seconds * BYTES_PER_SECOND * 2 + 200_000_000;
  if (free < needed) {
    const gb = (bytes) => (bytes / 1e9).toFixed(1);
    throw new Error(`There may not be enough free disk space: about ${gb(needed)} GB is needed and ${gb(free)} GB is free.`);
  }
}
