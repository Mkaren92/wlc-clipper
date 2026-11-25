// Turns a timeline into one video.
//
// Every item, video or card, is first made into a "segment": a short file
// with exactly the same picture size, frame rate and sound settings as all
// the others. Segments that match like that can be joined end to end without
// encoding anything again, which is fast and loses no quality.
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, rm, stat, statfs, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CARD_SIZES, LOGO_SWING } from '../cards/config.js';
import { cardPngPath, readMatch } from '../cards/match.js';
import { movingLogo } from '../cards/templates.js';
import { cleanOverlayText, FONT_NAME } from '../captions/ass.js';
import { OUT_FPS } from '../layout.js';
import { probe } from '../probe.js';
import { run } from '../run.js';
import { formatAssTime, formatClock } from '../time.js';
import { buildDescription, cardTitle } from './description.js';
import { resolveSound } from './sounds.js';
import { compilationDir, DEFAULT_CARD_SECONDS, PRESETS } from './timeline.js';

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
// A sound under a card sits a little under the clips around it. The format is
// stated before and after, because a sound file may not say how its channels
// are laid out, and the filters after it then cannot be joined up.
const STEREO = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
const CARD_LOUDNESS = `${STEREO},loudnorm=I=-16:TP=-1.5:LRA=11,${STEREO}`;
// A sound that is still going when its card ends is faded out over this long.
const SOUND_FADE = 0.4;
// The level a second video's sound is brought to, against -14 for the main
// one. "even" is what the owner hears as half and half; "low" is 8 dB under
// that, which puts the main video clearly in front, about 70 to 30.
const BESIDE_LEVEL = { even: -20, low: -28 };
const besideLoudness = (mode) => `${STEREO},loudnorm=I=${BESIDE_LEVEL[mode]}:TP=-1.5:LRA=11,${STEREO}`;
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
 * @param {string} [options.soundsDir]   the owner's sounds folder, for cards that use a file from it
 * @param {Record<string, string>} [options.links]   channel links for the credits (see creditLinks in src/sources.js)
 * @param {Record<string, string>} [options.pictures]   a channel's picture file for a credited name, by the
 *   name in lower case (see creditPictures in src/pictures.js). It is drawn beside the name.
 * @param {(progress: { index: number, status: 'working' | 'done' | 'reused' } | { joining: true }) => void} [options.onProgress]
 * @returns {Promise<{ file: string, seconds: number, description: string,
 *   items: { id: string, seconds: number, reused: boolean }[] }>}
 */
export async function buildCompilation({ timeline, dataDir: givenDataDir, resolveVideo, soundsDir, links = {}, pictures = {}, onProgress = () => {} }) {
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
    plans.push(await (item.kind === 'card' ? planCard(item, timeline, dataDir, soundsDir) : planVideo(item, resolveVideo, pictures)).catch((error) => {
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

  // Chapter times come from the lengths the segments really have. What they were worked out
  // from is kept beside them (made.json), so the page can write the text again when the owner
  // changes their own part of it, and can say when the timeline has changed since.
  const made = items.map(({ kind, seconds, credit, title }) => ({ kind, seconds, ...(kind === 'video' ? { credit: credit ?? '' } : { title }) }));
  const description = buildDescription(made, links, timeline.post);
  await writeFile(path.join(dir, 'description.txt'), description);
  await writeFile(path.join(dir, 'made.json'), `${JSON.stringify({ from: timeline.items, items: made }, null, 2)}\n`);
  const final = await probe(path.join(dir, 'final.mp4'));
  return {
    file: path.join(dir, 'final.mp4'),
    seconds: final.duration,
    description,
    items: items.map(({ id, seconds, reused }) => ({ id, seconds, reused })),
  };
}

// --- Planning -------------------------------------------------------------------

async function planCard(item, timeline, dataDir, soundsDir) {
  const match = await readMatch(dataDir, item.matchId).catch(() => {
    throw new Error('its match was deleted. Remove the card from the timeline.');
  });
  const card = match.cards.find((c) => c.id === item.cardId);
  if (!card) throw new Error('its card was deleted from the match. Remove it from the timeline.');
  // What plays under the card: the sound for its kind, another one, a file, or nothing.
  const sound = await resolveSound({ choice: item.sound ?? 'auto', cardType: card.type, soundsDir });
  const png = cardPngPath(dataDir, item.matchId, item.cardId, timeline.preset);
  const file = await stat(png).catch(() => {
    throw new Error('the card has no picture yet. Open its match in the card maker and press Save.');
  });
  // With no length given, the card is shown exactly as long as its sound
  // plays, rounded up to a whole frame. A silent card gets the usual length.
  const fitted = sound ? Math.min(Math.max(Math.ceil(sound.seconds * OUT_FPS) / OUT_FPS, 0.5), 60) : DEFAULT_CARD_SECONDS;
  const seconds = item.seconds ?? fitted;
  const recipe = ['card', png, file.size, Math.round(file.mtimeMs), seconds, sound?.recipe ?? 'silent', sound?.quieter ?? 0];
  // On a goal and a red card the logo moves, when the card maker has saved the two pieces
  // that needs. A card without them is planned and made exactly as before.
  const swing = await planSwing({ card, item, timeline, dataDir, seconds, since: file.mtimeMs });
  if (swing) recipe.push(...swing.recipe);
  return { item, png, seconds, title: cardTitle(match, card), sound, swing, recipe };
}

/**
 * How a card's logo moves (asked for on 2026-11-25): it leans to the right, then as far to the
 * left, a few times over, and then stands straight (`LOGO_SWING` in src/cards/config.js).
 *
 * The moving logo is its own picture, turned by ffmpeg and laid over the card's picture without
 * that logo. The card maker saves both beside the ordinary picture. Where the logo goes comes
 * from the card's own drawing (`movingLogo`), not from anything saved.
 *
 * @returns {Promise<null | { still: string, logo: string, x: number, y: number, side: number, angle: string, recipe: Array }>}
 *   null when nothing moves: another kind of card, the pieces not saved yet or older than the
 *   card's picture (saved by a page from before this), or a card too short to lean in.
 */
async function planSwing({ card, item, timeline, dataDir, seconds, since }) {
  const box = movingLogo({ card, size: timeline.preset });
  if (!box) return null;
  const still = cardPngPath(dataDir, item.matchId, item.cardId, timeline.preset, 'still');
  const logo = cardPngPath(dataDir, item.matchId, item.cardId, timeline.preset, 'logo');
  const files = await Promise.all([still, logo].map((file) => stat(file).catch(() => null)));
  if (files.some((file) => !file || file.mtimeMs < since)) return null;
  // Every lean fits inside the card: a shorter card leans faster, and one with no room does not lean.
  const each = Math.min(LOGO_SWING.seconds, (seconds - LOGO_SWING.after - 0.1) / LOGO_SWING.times);
  if (each < 0.25) return null;
  const end = LOGO_SWING.after + LOGO_SWING.times * each;
  const radians = (LOGO_SWING.degrees * Math.PI) / 180;
  // The card's picture is brought to the compilation's size, so the logo and its place are too.
  const scale = PRESETS[timeline.preset].width / CARD_SIZES[timeline.preset].width;
  const side = Math.round(box.room * scale);
  return {
    still, logo, side,
    x: Math.round(box.x * scale - side / 2),
    y: Math.round(box.y * scale - side / 2),
    // A positive angle turns clockwise: the top of the logo goes to the right first.
    angle: `if(between(t,${LOGO_SWING.after},${end.toFixed(3)}),${radians.toFixed(5)}*sin(2*PI*(t-${LOGO_SWING.after})/${each.toFixed(3)}),0)`,
    recipe: ['swing-1', ...files.flatMap((file) => [file.size, Math.round(file.mtimeMs)]), box.x, box.y, box.room, LOGO_SWING.degrees, LOGO_SWING.times, each, LOGO_SWING.after],
  };
}

async function planVideo(item, resolveVideo, pictures = {}) {
  const source = path.resolve(await resolveVideo(item.library, item.name));
  const info = await probe(source);
  const start = item.start ?? 0;
  const end = item.end ?? info.duration;
  if (end <= start) throw new Error(`"${item.name}": the end (${formatClock(end)}) must be after the start (${formatClock(start)}).`);
  if (end > info.duration + 0.05) throw new Error(`"${item.name}" is only ${formatClock(info.duration)} long, but its end is set to ${formatClock(end)}.`);
  const file = await stat(source);
  const credit = cleanOverlayText(item.credit ?? '');
  const seconds = Math.min(end, info.duration) - start;
  const recipe = ['video', source, file.size, Math.round(file.mtimeMs), start, end, credit];

  // A second video beside this one, for as long as it runs or this one does,
  // whichever is shorter. An item without one is planned exactly as before,
  // so the segments already made for it are still good.
  let beside = null;
  if (item.beside) {
    const { name } = item.beside;
    const other = path.resolve(await resolveVideo(item.beside.library, name).catch(() => {
      throw new Error(`"${name}", the video shown beside "${item.name}", is not in the project any more.`);
    }));
    const otherInfo = await probe(other);
    const from = item.beside.start ?? 0;
    const to = item.beside.end ?? otherInfo.duration;
    if (to <= from) throw new Error(`"${name}", shown beside "${item.name}": the end (${formatClock(to)}) must be after the start (${formatClock(from)}).`);
    if (to > otherInfo.duration + 0.05) throw new Error(`"${name}", shown beside "${item.name}", is only ${formatClock(otherInfo.duration)} long, but its end is set to ${formatClock(to)}.`);
    const otherFile = await stat(other);
    beside = {
      source: other, start: from, seconds: Math.min(Math.min(to, otherInfo.duration) - from, seconds),
      hasAudio: otherInfo.audioStreams > 0 && item.beside.sound !== 'off', sound: item.beside.sound,
    };
    // The number is for how the split is drawn; change it when that changes.
    recipe.push('beside-3', other, otherFile.size, Math.round(otherFile.mtimeMs), from, to, item.beside.sound);
  }
  // The number is for how a credit is drawn (2: on a plate with an edge and a shadow); change it when that changes.
  if (credit) recipe.push('credit-2');
  // The credited channel's picture, when there is one for exactly this name.
  // An item without one is planned as before, so its segments are still good.
  let picture = null;
  const pictureFile = credit ? pictures[credit.toLowerCase()] : undefined;
  if (pictureFile) {
    picture = path.resolve(pictureFile);
    // What the picture shows, not when it was written: fetching the same
    // picture again must not make every clip credited to that channel again.
    const drawn = await readFile(picture).catch(() => null);
    if (drawn) recipe.push('picture-1', createHash('sha256').update(drawn).digest('hex'));
    else picture = null;
  }
  return { item: { ...item, credit }, source, start, seconds, hasAudio: info.audioStreams > 0, credit, beside, picture, recipe };
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
    // With a moving logo the card's picture is the one without that logo.
    const card = ['-loop', '1', '-framerate', String(OUT_FPS), '-t', length, '-i', plan.swing?.still ?? plan.png];
    // The logo is one more picture, the last input, turned a little each frame and laid on last.
    const logo = plan.swing ? ['-loop', '1', '-framerate', String(OUT_FPS), '-t', length, '-i', plan.swing.logo] : [];
    const silence = ['-f', 'lavfi', '-t', length, '-i', SILENCE];
    // The card's length is already decided. A sound that would run past it
    // is faded out at the card's end, and one that stops early is followed
    // by silence. Only its first sound track is used, since a music file
    // can carry a cover picture as well.
    const steps = [CARD_LOUDNESS];
    if (plan.sound?.quieter) steps.push(`volume=-${plan.sound.quieter}dB`);
    if (plan.sound && plan.sound.seconds > plan.seconds + 0.05) {
      const fade = Math.min(SOUND_FADE, plan.seconds / 2);
      steps.push(`afade=t=out:st=${(plan.seconds - fade).toFixed(3)}:d=${fade.toFixed(3)}`);
    }
    const sound = `${steps.join(',')},apad`;

    if (plan.swing) {
      // The logo is laid on while the card is still in full colour, and the result is brought
      // to the video's colours by the very steps a card without a moving logo goes through.
      // Measured: everything outside the logo is then identical to that card, and the logo at
      // rest too (66 dB). Converting first, or leaving the conversion to ffmpeg's own choice in
      // a graph (a different scaler), shifted the stripes' colour by three levels of blue.
      const graph = [
        `[0:v]fps=${OUT_FPS},scale=${width}:${height}:flags=bicubic[card]`,
        `[2:v]fps=${OUT_FPS},scale=${plan.swing.side}:${plan.swing.side},format=rgba,rotate=a='${plan.swing.angle}':c=none[logo]`,
        `[card][logo]overlay=${plan.swing.x}:${plan.swing.y}:format=rgb,scale=${width}:${height}:flags=bicubic,setsar=1,format=yuv420p[v]`,
      ].join(';');
      args = plan.sound
        ? [...card, '-i', plan.sound.file, ...logo, '-filter_complex', graph, '-map', '[v]', '-af', sound, '-map', '1:a:0']
        : [...card, ...silence, ...logo, '-filter_complex', graph, '-map', '[v]', '-map', '1:a'];
    } else {
      const picture = ['-vf', `scale=${width}:${height},setsar=1,fps=${OUT_FPS},format=yuv420p`];
      args = plan.sound
        ? [...card, '-i', plan.sound.file, ...picture, '-af', sound, '-map', '0:v', '-map', '1:a:0']
        : [...card, ...silence, ...picture, '-map', '0:v', '-map', '1:a'];
    }
  } else {
    const steps = [
      // Fit inside the frame without stretching, and fill the rest with black.
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
      'setsar=1',
      `fps=${OUT_FPS}`,
    ];
    if (plan.credit) {
      const nameWidth = await measureCredit(plan.credit, size, workDir, name);
      await writeFile(path.join(workDir, `${name}.ass`), creditSubtitles(plan.credit, size, plan.seconds, { withPicture: Boolean(plan.picture), nameWidth }));
      steps.push(`subtitles=${name}.ass:fontsdir=${FONTS_LINK}`);
    }
    steps.push('format=yuv420p');
    // -ss and -t both before -i, as everywhere in this project.
    args = ['-ss', plan.start.toFixed(3), '-t', length, '-i', plan.source];
    // The credited channel's picture, laid over the finished picture beside the name.
    const badge = plan.picture ? { ...creditLayout(size).picture, input: ['-loop', '1', '-t', length, '-i', plan.picture] } : null;
    if (plan.beside) args.push(...besideArgs(plan, size, steps.slice(4), length, badge));
    else if (badge) {
      // A picture is one more input, so the steps become a graph. They are the same steps, in the same order.
      const sound = plan.hasAudio ? [] : ['-f', 'lavfi', '-t', length, '-i', SILENCE];
      const graph = `[0:v:0]${steps.slice(0, -1).join(',')}[named];[${plan.hasAudio ? 1 : 2}:v]scale=${badge.size}:${badge.size}[badge];[named][badge]overlay=${badge.x}:${badge.y},format=yuv420p[v]`;
      args.push(...sound, ...badge.input, '-filter_complex', graph, '-map', '[v]');
      args.push(...(plan.hasAudio ? ['-af', `${LOUDNESS},aresample=48000,apad`, '-map', '0:a:0'] : ['-map', '1:a']));
    } else args.push(...(plan.hasAudio
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
 * The rest of the ffmpeg arguments for a video with a second video beside it.
 *
 * While the second video runs the screen is split, and each video fills its
 * half with the middle of its picture. In a wide video the main one is on the
 * left and the second on the right. In a tall video the second is on top and
 * the main one below, where its credit label is. When the second
 * video ends, the main one fills the screen as it would alone. The main
 * video plays through without a break; only how it is shown changes.
 *
 * @param {object} plan     from planVideo, with `beside`
 * @param {{ width: number, height: number }} size
 * @param {string[]} after  steps applied to the finished picture: the credit label and the pixel format
 * @param {string} length   the segment's length in seconds, as text
 * @param {{ size: number, x: number, y: number, input: string[] } | null} [badge]
 *   the credited channel's picture and where it goes, laid on last of all
 * @returns {string[]}
 */
function besideArgs(plan, { width, height }, after, length, badge = null) {
  const wide = width >= height;
  const half = wide ? `${width / 2}:${height}` : `${width}:${height / 2}`;
  const until = plan.beside.seconds.toFixed(3);
  const picture = [
    // Both videos are brought to the output frame rate first, as everywhere.
    `[0:v:0]fps=${OUT_FPS},split=2[whole][part]`,
    `[whole]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1[full]`,
    // The cropped copy of the main video is only needed while the split lasts.
    `[part]trim=duration=${until},scale=${half}:force_original_aspect_ratio=increase,crop=${half},setsar=1[main]`,
    // The second video fills its half the same way: its middle, at full height.
    `[1:v:0]fps=${OUT_FPS},scale=${half}:force_original_aspect_ratio=increase,crop=${half},setsar=1[second]`,
    wide ? '[main][second]hstack=inputs=2[split]' : '[second][main]vstack=inputs=2[split]',
    // The split picture covers the whole one until the second video ends, to the frame.
    badge
      ? `[full][split]overlay=0:0:enable='lt(t,${until})':eof_action=pass,setsar=1,${after.slice(0, -1).join(',')}[named]`
      : `[full][split]overlay=0:0:enable='lt(t,${until})':eof_action=pass,setsar=1,${after.join(',')}[v]`,
  ];
  // The picture is the last input, after the second video and, when neither video has sound, the silence.
  // It comes with a credit, so `after` always holds the name's step before its last one.
  const badgeAt = plan.hasAudio || plan.beside.hasAudio ? 2 : 3;
  if (badge) picture.push(`[${badgeAt}:v]scale=${badge.size}:${badge.size}[badge]`, `[named][badge]overlay=${badge.x}:${badge.y},${after.at(-1)}[v]`);
  const last = badge ? badge.input : [];

  // The main video's sound runs through at its usual level. The second
  // video's sound is added under it without scaling either, so the main
  // one's level does not move when the second stops.
  const main = `${LOUDNESS},${STEREO},apad,atrim=duration=${length}`;
  const second = `${besideLoudness(plan.beside.sound === 'low' ? 'low' : 'even')},apad,atrim=duration=${length}`;
  const inputs = ['-ss', plan.beside.start.toFixed(3), '-t', until, '-i', plan.beside.source];
  let sound;
  if (plan.hasAudio && plan.beside.hasAudio) {
    sound = `[0:a:0]${main}[m];[1:a:0]${second}[s];[m][s]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95:level=0[a]`;
  } else if (plan.hasAudio) {
    sound = `[0:a:0]${main}[a]`;
  } else if (plan.beside.hasAudio) {
    sound = `[1:a:0]${second}[a]`;
  } else {
    // Neither has sound: silence, since without a sound track the join would fail.
    return [...inputs, '-f', 'lavfi', '-t', length, '-i', SILENCE, ...last, '-filter_complex', picture.join(';'), '-map', '[v]', '-map', '2:a'];
  }
  return [...inputs, ...last, '-filter_complex', `${picture.join(';')};${sound}`, '-map', '[v]', '-map', '[a]'];
}

/**
 * Where the credit sits in a frame of this size: the name's size and margin,
 * and the square its channel's picture goes in, at the left of the name and
 * centred on it. With a picture the name starts at `nameLeft`.
 *
 * @param {{ width: number, height: number }} size
 */
export function creditLayout({ width, height }) {
  const fontSize = Math.round(Math.min(width, height) * 0.037);
  const margin = Math.round(Math.min(width, height) * 0.04);
  const side = Math.round(fontSize * 1.9 / 2) * 2;
  return {
    fontSize, margin,
    picture: { size: side, x: margin, y: Math.round(height - margin - fontSize / 2 - side / 2) },
    nameLeft: margin + side + Math.round(fontSize * 0.4),
  };
}

/**
 * A subtitle file that shows one small label, bottom left, for a whole clip.
 * The same method as the captions (burned in with the bundled font), on a
 * canvas the size of this compilation.
 *
 * With `nameWidth`, the name's measured width in pixels, the credit is drawn
 * on a plate: a dark see-through shape with round ends, a pale edge and a
 * soft shadow, wide enough for the picture and the name, and a white ring
 * for the picture to sit in. Without it only the name is drawn, as it is for
 * measuring.
 *
 * @param {string} credit
 * @param {{ width: number, height: number }} size
 * @param {number} seconds
 * @param {{ withPicture?: boolean, nameWidth?: number | null }} [options]
 *   `withPicture` leaves room on the left for the channel's picture
 */
export function creditSubtitles(credit, { width, height }, seconds, { withPicture = false, nameWidth = null } = {}) {
  const { fontSize, margin, nameLeft, picture } = creditLayout({ width, height });
  const left = withPicture ? nameLeft : margin;
  const [from, to] = [formatAssTime(0), formatAssTime(seconds)];
  const shapes = [];
  if (nameWidth !== null) {
    // The plate holds the picture and the name; with no picture it is a lower one round the name alone.
    const middle = picture.y + picture.size / 2;
    const half = withPicture ? picture.size / 2 + Math.round(fontSize * 0.15) : Math.round(fontSize * 0.8);
    const x0 = withPicture ? margin - Math.round(fontSize * 0.15) : margin - Math.round(fontSize * 0.45);
    const x1 = left + Math.ceil(nameWidth) + Math.round(fontSize * (withPicture ? 0.6 : 0.45));
    const drop = Math.round(fontSize * 0.1);
    const draw = (layer, look, path) => `Dialogue: ${layer},${from},${to},Shape,,0,0,0,,{\\an7\\pos(0,0)${look}\\p1}${path}{\\p0}`;
    shapes.push(
      draw(0, `\\1c&H000000&\\1a&H73&\\bord0\\blur${Math.round(fontSize * 0.15)}`, roundedBar(x0, middle - half + drop, x1, middle + half + drop)),
      draw(1, '\\1c&H141414&\\1a&H55&\\bord2\\3c&HFFFFFF&\\3a&H66&', roundedBar(x0, middle - half, x1, middle + half)),
    );
    // A white disc a little larger than the picture, which is laid on top of it: what shows is a ring.
    if (withPicture) {
      const ring = picture.size / 2 + Math.max(2, Math.round(fontSize * 0.07));
      shapes.push(draw(2, '\\1c&HFFFFFF&\\1a&H00&\\bord0', roundedBar(picture.x + picture.size / 2 - ring, middle - ring, picture.x + picture.size / 2 + ring, middle + ring)));
    }
  }
  // On the plate the name needs only a thin edge; alone on the video it needs the heavy one.
  const outline = nameWidth === null ? 3 : 2;
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Credit,${FONT_NAME},${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,${outline},0,1,${left},${margin},${margin},1
Style: Shape,${FONT_NAME},${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${shapes.map((shape) => `${shape}\n`).join('')}Dialogue: ${shapes.length ? 3 : 0},${from},${to},Credit,,0,0,0,,${cleanOverlayText(credit)}
`;
}

/** A bar with fully round ends, as a subtitle drawing: a circle when it is as wide as it is high. */
function roundedBar(x0, y0, x1, y1) {
  const r = (y1 - y0) / 2;
  const k = r * 0.5523; // how far a curve's handles reach, for a quarter circle
  const n = (value) => Math.round(value * 10) / 10;
  const [left, right, mid] = [x0 + r, x1 - r, y0 + r];
  return [
    `m ${n(left)} ${n(y0)} l ${n(right)} ${n(y0)}`,
    `b ${n(right + k)} ${n(y0)} ${n(x1)} ${n(mid - k)} ${n(x1)} ${n(mid)}`,
    `b ${n(x1)} ${n(mid + k)} ${n(right + k)} ${n(y1)} ${n(right)} ${n(y1)}`,
    `l ${n(left)} ${n(y1)}`,
    `b ${n(left - k)} ${n(y1)} ${n(x0)} ${n(mid + k)} ${n(x0)} ${n(mid)}`,
    `b ${n(x0)} ${n(mid - k)} ${n(left - k)} ${n(y0)} ${n(left)} ${n(y0)}`,
  ].join(' ');
}

/**
 * How wide a credit's name comes out, in pixels: it is drawn alone on a black
 * frame and ffmpeg reports where the picture is not black. Measured, because
 * a name can hold any letters and the plate behind it has to fit.
 *
 * @param {string} name   the segment's name, for the measuring file
 * @returns {Promise<number>}
 */
async function measureCredit(credit, size, workDir, name) {
  const file = `${name}-measure.ass`;
  const { fontSize } = creditLayout(size);
  try {
    await writeFile(path.join(workDir, file), creditSubtitles(credit, size, 1));
    const { stderr } = await run('ffmpeg', [
      '-hide_banner', '-f', 'lavfi', '-i', `color=c=black:s=${size.width}x${size.height}:r=1`,
      '-vf', `subtitles=${file}:fontsdir=${FONTS_LINK},bbox`, '-frames:v', '1', '-f', 'null', '-',
    ], { cwd: workDir });
    const found = /x1:(\d+) x2:(\d+)/.exec(stderr);
    if (found) return Number(found[2]) - Number(found[1]) + 1;
  } catch {
    // Fall through to the estimate: a plate a little off is better than no video.
  } finally {
    await rm(path.join(workDir, file), { force: true });
  }
  return Math.round([...credit].length * fontSize * 0.6);
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

// A combined video (src/combine/build.js) levels and encodes its sound the same way.
export { AUDIO, besideLoudness, LOUDNESS, SILENCE, STEREO };
