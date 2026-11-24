import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runChecks } from './brief/check.js';
import { buildHashtags, buildPostText, parsePostText } from './brief/postText.js';
import { applyReplacements } from './brief/replacements.js';
import { loadBrief } from './brief/schema.js';
import { buildAss, checkHook, checkTag, cleanOverlayText, HOOK_SECONDS, tagText } from './captions/ass.js';
import { groupWords } from './captions/group.js';
import { maskProfanity, swearWindows } from './captions/mask.js';
import { findVoiceLevels, snapToVoice } from './captions/onsets.js';
import { findPauses, snapToSpeech } from './captions/pauses.js';
import { buildFilter, camPanelHeight, checkBlurs, OUT_FPS, OUT_HEIGHT, OUT_WIDTH, SUBTITLE_FILE } from './layout.js';
import { describeOverlay } from './overlay.js';
import { probe } from './probe.js';
import { CLIP_FILE, extractAudio, render } from './render.js';
import { isStopped } from './run.js';
import { formatClock } from './time.js';
import { checkTranscript, getTranscriber } from './transcribe/index.js';

/** @typedef {import('./types.js').Meta} Meta */
/** @typedef {import('./types.js').VideoInfo} VideoInfo */
/** @typedef {import('./brief/schema.js').Brief} Brief */
/** @typedef {import('./brief/check.js').CheckResult} CheckResult */
/** @typedef {import('./transcribe/index.js').Transcriber} Transcriber */

/**
 * What `cut`, `rerender` and `checkClip` return.
 *
 * @typedef {object} ClipResult
 * @property {string} clipDir
 * @property {Meta} meta
 * @property {string[]} warnings
 * @property {CheckResult[]} checks   empty when the clip has no brief
 */

// A clip folder shows the two files a person uses, clip.mp4 and post.txt.
// Everything the tool needs to render or check the clip again is in a
// subfolder.
const WORK_DIR = 'work';
/** The slow parts of a run, reported through `onStep`. @typedef {'transcribing' | 'rendering' | 'checking'} Step */

const META_FILE = 'meta.json';
const TRANSCRIPT_FILE = 'transcript.json';
const POST_FILE = 'post.txt';
// The source's last frame can end slightly before the duration ffprobe reports.
const END_SLACK = 0.05;
const LENGTH_TOLERANCE = 0.1;

/**
 * Produce one clip: probe the source, check it against the brief, transcribe
 * the range, render it, write the post text and check the result. Each step
 * leaves its file in the clip folder.
 *
 * @param {object} options
 * @param {string} options.source
 * @param {number} options.start
 * @param {number} options.end
 * @param {string} [options.layout]
 * @param {number} [options.cropX]
 * @param {number} [options.cropWidth]
 * @param {number} [options.trim]
 * @param {{ x: number, y: number, width: number, height: number }} [options.cam]
 * @param {string} [options.hook]
 * @param {number} [options.hookSeconds]   how long the hook stays; 0 means the whole clip
 * @param {string} [options.tag]   the channel tag, such as "@theburntpeanut", shown at the top for the whole clip
 * @param {boolean} [options.censor]       cover swear words in the captions and the hook (F*CK); on unless turned off
 * @param {boolean} [options.muffle]       muffle the sound while a swear word is spoken; on unless turned off, and only with captions
 * @param {boolean} [options.captions]
 * @param {string} [options.lang]
 * @param {string} [options.briefFile]
 * @param {string} [options.title]         for post.txt; the hook when missing
 * @param {string} [options.description]   for post.txt. post.txt is written
 *   when there is a brief, a title or a description.
 * @param {string} [options.outDir]
 * @param {string} options.toolVersion
 * @param {Transcriber} [options.transcriber]   replaced in tests
 * @param {(step: Step) => void} [options.onStep]   called as each slow step starts
 * @returns {Promise<ClipResult>}
 */
export async function cut({
  source,
  start,
  end,
  layout = 'center',
  cropX,
  cropWidth,
  trim = 0,
  cam,
  game,
  overlay,
  blurs = [],
  hook,
  hookSeconds = HOOK_SECONDS,
  tag,
  censor = true,
  muffle = true,
  captions = true,
  lang = 'en',
  briefFile,
  title,
  description,
  outDir = './out',
  toolVersion,
  transcriber = getTranscriber(),
  onStep = () => {},
}) {
  const sourcePath = path.resolve(source);
  const info = await probe(sourcePath);
  checkRange(start, end, info.duration);
  const hookText = hook === undefined ? null : checkHook(hook);
  const tagLine = tag === undefined ? null : checkTag(tag);
  if (!Number.isFinite(hookSeconds) || hookSeconds < 0) {
    throw new Error('The hook time must be 0 or more seconds. 0 keeps the hook for the whole clip.');
  }
  // The webcam panel follows the box's shape; saved, so a later render keeps it.
  const camHeight = layout === 'facecam' && cam ? camPanelHeight(cam) : null;
  // Built here only to reject bad options before anything is written.
  // Parts of the frame hidden for part of the clip, in source pixels and clip seconds.
  const blurBoxes = checkBlurs(blurs, info, end - start);
  const filter = buildFilter({ layout, source: info, cropX, cropWidth, trim, cam, camHeight: camHeight ?? undefined, game, blurs: blurBoxes });

  /** @type {Brief | null} */
  let brief = null;
  let briefPath = null;
  let post = null;
  if (briefFile) {
    ({ brief, path: briefPath } = await loadBrief(briefFile));
    post = {
      title: cleanLine(title ?? hookText ?? ''),
      description: (description ?? '').trim(),
      hashtags: buildHashtags(brief),
    };
    if (!post.title) throw new Error('post.txt needs a title. Pass --title, or --hook to use the hook as the title.');

    // Everything that can be known before the slow steps is checked now, and
    // a failure stops the run before a clip folder is made.
    const failed = runChecks({
      brief,
      seconds: end - start + (brief.endCard?.seconds ?? 0),
      layout,
      ...post,
      onScreen: onScreenTexts(hookText, brief, tagLine),
    }).filter((check) => !check.pass);
    if (failed.length > 0) {
      const lines = failed.map((check) => `  ${check.rule}: ${check.detail}`);
      throw new Error(`The brief "${brief.id}" does not allow this clip:\n${lines.join('\n')}`);
    }
  }
  // The brief wins: its overlay is used even when another was asked for.
  const chosenOverlay = brief?.overlay ?? overlay ?? null;
  const overlaySpec = chosenOverlay ? await describeOverlay(chosenOverlay) : null;
  if (!briefFile && (title !== undefined || description !== undefined)) {
    // No brief: the post text is what was given, with no hashtags and no rules to check.
    post = { title: cleanLine(title ?? hookText ?? ''), description: (description ?? '').trim(), hashtags: [] };
  }

  const warnings = [];
  let wantCaptions = captions;
  if (wantCaptions && info.audioStreams === 0) {
    wantCaptions = false;
    warnings.push('The source has no audio, so there are no captions.');
  }
  if (wantCaptions && !(await transcriber.isInstalled())) {
    wantCaptions = false;
    warnings.push('Captions were skipped: the transcriber is not installed. Run "npm run setup" to install it.');
  }

  const clipDir = await nextClipDir(path.resolve(outDir), hookText);
  const workDir = path.join(clipDir, WORK_DIR);
  await mkdir(workDir);

  /** @type {Meta} */
  const meta = {
    tool: { name: 'wlc-clipper', version: toolVersion },
    source: sourcePath,
    start,
    end,
    layout,
    cropX: filter.cropX,
    cropWidth: filter.cropWidth,
    trim,
    cam: cam ?? null,
    camHeight,
    game: game ?? null,
    // The overlay as it was chosen, with its image's absolute path, so a render keeps it.
    overlay: overlaySpec,
    blurs: blurBoxes,
    hook: hookText,
    hookSeconds,
    tag: tagLine,
    censor: Boolean(censor),
    muffle: Boolean(muffle),
    captions: wantCaptions,
    lang,
    briefPath,
    brief,
    output: null,
    checks: [],
    createdAt: localIsoTime(new Date()),
  };
  // Written before the slow steps, so a failed run still says what was asked for.
  await writeJson(path.join(workDir, META_FILE), meta);
  if (post) await writeFile(path.join(clipDir, POST_FILE), buildPostText(post));

  try {
    return await captionAndRender();
  } catch (error) {
    // A cut that was stopped leaves no folder: it was made by this run and holds nothing finished.
    // One that failed keeps its folder, so what was asked for can still be read.
    if (isStopped()) await rm(clipDir, { recursive: true, force: true });
    throw error;
  }

  async function captionAndRender() {
    if (!wantCaptions) return renderClip(clipDir, workDir, meta, info, warnings, onStep);
    onStep('transcribing');
    try {
      const audioFile = await extractAudio({ source: sourcePath, start, seconds: end - start, workDir });
      const transcript = checkTranscript(await transcriber.transcribe(audioFile, { lang }));
      transcript.words = snapToSpeech(transcript.words, await findPauses(audioFile));
      transcript.words = snapToVoice(transcript.words, await findVoiceLevels(audioFile));
      if (brief) transcript.words = applyReplacements(transcript.words, brief.replacements);
      await writeJson(path.join(workDir, TRANSCRIPT_FILE), transcript);
      await rm(audioFile, { force: true });
    } catch (error) {
      throw new Error(`${error.message}\nThe run's files are in ${clipDir}.`);
    }
    return renderClip(clipDir, workDir, meta, info, warnings, onStep);
  }
}

/**
 * Render an existing clip folder again from its meta.json and, when it has
 * captions, its transcript.json. This is how a wrong word gets fixed: edit
 * work/transcript.json, then re-render. post.txt is left as it is.
 *
 * @param {string} clipDir
 * @param {{ onStep?: (step: Step) => void }} [options]
 * @returns {Promise<ClipResult>}
 */
export async function rerender(clipDir, { onStep = () => {} } = {}) {
  const dir = path.resolve(clipDir);
  const workDir = await findWorkDir(dir);
  const meta = await readMeta(workDir);
  let info;
  try {
    info = await probe(meta.source);
  } catch (error) {
    throw new Error(`The source video for this clip cannot be used any more.\n${error.message}`);
  }
  return renderClip(dir, workDir, meta, info, [], onStep);
}

/**
 * Check an existing clip folder against a brief without changing anything.
 *
 * @param {string} clipDir
 * @param {string} [briefFile]   defaults to the brief the clip was made with
 * @returns {Promise<ClipResult & { brief: Brief }>} `brief` is the one that was used
 */
export async function checkClip(clipDir, briefFile) {
  const dir = path.resolve(clipDir);
  const workDir = await findWorkDir(dir);
  const meta = await readMeta(workDir);
  const brief = briefFile ? (await loadBrief(briefFile)).brief : meta.brief;
  if (!brief) {
    throw new Error('This clip was made without a brief. Name one: clipper check <clip-folder> --brief <file>');
  }
  const clip = await probe(path.join(dir, CLIP_FILE));
  return { clipDir: dir, meta, brief, warnings: [], checks: await checkAgainst(dir, workDir, meta, brief, clip) };
}

/**
 * Read a clip folder for display: its options, post text and transcript.
 * The post text and transcript are null when the clip has none.
 *
 * @param {string} clipDir
 * @returns {Promise<{ clipDir: string, meta: Meta, postText: string | null,
 *   transcript: import('./types.js').Transcript | null }>}
 */
export async function readClip(clipDir) {
  const dir = path.resolve(clipDir);
  const workDir = await findWorkDir(dir);
  const meta = await readMeta(workDir);
  const transcript = meta.captions ? await readTranscript(workDir) : null;
  return { clipDir: dir, meta, postText: await readIfExists(path.join(dir, POST_FILE)), transcript };
}

/**
 * Replace a clip's transcript, for example with corrected words. The clip
 * itself changes only when it is rendered again.
 *
 * @param {string} clipDir
 * @param {unknown} transcript
 */
export async function saveTranscript(clipDir, transcript) {
  const workDir = await findWorkDir(path.resolve(clipDir));
  const meta = await readMeta(workDir);
  if (!meta.captions) throw new Error('This clip has no captions to edit.');
  await writeJson(path.join(workDir, TRANSCRIPT_FILE), checkTranscript(transcript));
}

/**
 * Replace a clip's post.txt. Only clips made with a brief have one.
 *
 * @param {string} clipDir
 * @param {string} text
 */
export async function savePostText(clipDir, text) {
  const file = path.join(path.resolve(clipDir), POST_FILE);
  if ((await readIfExists(file)) === null) {
    throw new Error('This clip has no post.txt: it was made without a brief, a title or a description.');
  }
  await writeFile(file, text.endsWith('\n') ? text : `${text}\n`);
}

/**
 * Delete a clip folder and everything in it: the clip, its post text and
 * its working files. This cannot be undone.
 *
 * It refuses a folder that does not hold a clip's meta.json, so a mistaken
 * path cannot remove something else.
 *
 * @param {string} clipDir
 */
export async function removeClip(clipDir) {
  const dir = path.resolve(clipDir);
  await findWorkDir(dir); // throws unless this is a clip folder
  await rm(dir, { recursive: true });
}

/**
 * Run the clip's own brief on it again and save the result in meta.json,
 * for example after its post text was edited. Does nothing for a clip
 * without a brief.
 *
 * @param {string} clipDir
 * @returns {Promise<CheckResult[]>}
 */
export async function recheck(clipDir) {
  const dir = path.resolve(clipDir);
  const workDir = await findWorkDir(dir);
  const meta = await readMeta(workDir);
  if (!meta.brief) return [];
  meta.checks = await checkAgainst(dir, workDir, meta, meta.brief, await probe(path.join(dir, CLIP_FILE)));
  await writeJson(path.join(workDir, META_FILE), meta);
  return meta.checks;
}

/**
 * Steps shared by `cut` and `rerender`: build the subtitle file, run ffmpeg,
 * check the result and record it in meta.json.
 *
 * @param {string} clipDir
 * @param {string} workDir   the folder with meta.json; see findWorkDir
 * @param {Meta} meta
 * @param {VideoInfo} info   the source video
 * @param {string[]} warnings
 * @param {(step: Step) => void} onStep
 * @returns {Promise<ClipResult>}
 */
async function renderClip(clipDir, workDir, meta, info, warnings, onStep) {
  const seconds = meta.end - meta.start;
  const card = meta.brief?.endCard ?? null;
  // The overlay's image is read again: it must still be where it was when the clip was cut.
  const overlaySpec = meta.overlay ? await describeOverlay(meta.overlay) : null;
  const total = seconds + (card?.seconds ?? 0);

  let groups = [];
  let words = [];
  if (meta.captions) {
    ({ words } = await readTranscript(workDir));
    groups = groupWords(words, seconds);
    if (groups.length === 0) warnings.push('No speech was found in this range, so the clip has no captions.');
    // Swear words are covered in what is drawn only; the transcript keeps the real words.
    if (meta.censor) groups = groups.map((group) => ({ ...group, text: maskProfanity(group.text) }));
  }

  // The sound is muffled while a swear word is spoken. It needs the word times, so only with captions on.
  const muffle = meta.muffle ? swearWindows(words, seconds) : [];

  const shown = onScreenTexts(meta.hook, meta.brief, meta.tag);
  const subtitles = groups.length > 0 || Boolean(shown.hook || shown.disclosure || shown.tag || shown.endCard);
  const subtitlePath = path.join(workDir, SUBTITLE_FILE);
  if (subtitles) {
    const ass = buildAss({
      groups,
      // Covered here and not in `shown`, which the brief's checks read: they judge the real words.
      hook: meta.censor && shown.hook ? maskProfanity(shown.hook) : shown.hook,
      hookSeconds: meta.hookSeconds,
      disclosure: shown.disclosure,
      tag: shown.tag,
      endCard: shown.endCard ? { text: shown.endCard, seconds: card.seconds } : null,
      layout: meta.layout,
      clipSeconds: seconds,
      camHeight: meta.camHeight ?? undefined,
    });
    await writeFile(subtitlePath, ass);
  } else {
    await rm(subtitlePath, { force: true });
  }

  const filter = buildFilter({
    layout: meta.layout,
    source: info,
    cropX: meta.cropX ?? undefined,
    cropWidth: meta.cropWidth ?? undefined,
    trim: meta.trim,
    cam: meta.cam ?? undefined,
    camHeight: meta.camHeight ?? undefined,
    game: meta.game ?? undefined,
    overlay: overlaySpec,
    blurs: meta.blurs,
    muffle,
    subtitles,
    endCard: card ? { at: seconds, seconds: card.seconds, image: Boolean(card.image) } : undefined,
  });

  onStep('rendering');
  try {
    await render({
      source: meta.source,
      start: meta.start,
      seconds,
      graph: filter.graph,
      audioLabel: filter.audioLabel,
      endCard: card,
      overlay: overlaySpec,
      clipDir,
      workDir,
      subtitles,
    });
  } catch (error) {
    throw new Error(`${error.message}\nThe run's files are in ${clipDir}.`);
  }

  onStep('checking');
  const result = await probe(path.join(clipDir, CLIP_FILE));
  if (result.width !== OUT_WIDTH || result.height !== OUT_HEIGHT) {
    throw new Error(
      `The clip came out ${result.width}x${result.height}, not ${OUT_WIDTH}x${OUT_HEIGHT}. It is in ${clipDir}.`,
    );
  }

  meta.output = {
    file: CLIP_FILE,
    width: result.width,
    height: result.height,
    fps: result.fps,
    seconds: Math.round(result.duration * 1000) / 1000,
    audio: result.audioStreams > 0,
    captionGroups: groups.length,
    muffled: muffle.length,
  };
  meta.checks = meta.brief ? await checkAgainst(clipDir, workDir, meta, meta.brief, result) : [];
  await writeJson(path.join(workDir, META_FILE), meta);

  if (Math.abs(result.duration - total) > LENGTH_TOLERANCE) {
    warnings.push(`The clip is ${result.duration.toFixed(2)} s long; ${total.toFixed(2)} s was expected.`);
  }
  if (result.fps !== OUT_FPS) warnings.push(`The clip is ${result.fps} fps, not ${OUT_FPS}.`);
  if (!meta.output.audio) warnings.push('The source has no audio, so the clip is silent.');

  return { clipDir, meta, warnings, checks: meta.checks };
}

/**
 * Run every rule of `brief` on a rendered clip folder. The post text and the
 * transcript are read from disk, since both may have been edited by hand.
 *
 * @param {string} clipDir
 * @param {string} workDir
 * @param {Meta} meta
 * @param {Brief} brief
 * @param {VideoInfo} clip   the rendered clip
 * @returns {Promise<CheckResult[]>}
 */
async function checkAgainst(clipDir, workDir, meta, brief, clip) {
  const postText = await readIfExists(path.join(clipDir, POST_FILE));
  const post = postText === null ? { title: '', description: '', hashtags: [] } : parsePostText(postText);
  const words = meta.captions ? (await readTranscript(workDir)).words : null;
  return runChecks({
    brief,
    seconds: clip.duration,
    layout: meta.layout,
    ...post,
    // What is drawn comes from the brief the clip was rendered with, even
    // when it is being checked against a different one.
    onScreen: onScreenTexts(meta.hook, meta.brief, meta.tag),
    overlay: meta.overlay ?? null,
    words,
    subtitleFile: await readIfExists(path.join(workDir, SUBTITLE_FILE)),
    clip,
  });
}

/**
 * The text drawn over the picture, apart from captions.
 *
 * @param {string | null} hook
 * @param {Brief | null} brief
 * @param {string | null} [tag]   the channel tag, checked as it is drawn (in capitals)
 */
export function onScreenTexts(hook, brief, tag = null) {
  return {
    hook,
    disclosure: brief?.disclosure.mode === 'onscreen' ? brief.disclosure.text : null,
    tag: tag ? tagText(tag) : null,
    endCard: brief?.endCard?.text ?? null,
  };
}

/**
 * Find the folder that holds a clip's working files. Clip folders made
 * before the work subfolder existed keep them next to clip.mp4, and still work.
 *
 * @param {string} clipDir
 * @returns {Promise<string>}
 */
async function findWorkDir(clipDir) {
  for (const dir of [path.join(clipDir, WORK_DIR), clipDir]) {
    if ((await readIfExists(path.join(dir, META_FILE))) !== null) return dir;
  }
  throw new Error(`${clipDir} is not a clip folder: it has no ${WORK_DIR}/${META_FILE}.`);
}

/** Read meta.json, filling in fields that clips from earlier versions lack. */
async function readMeta(workDir) {
  let saved;
  try {
    saved = JSON.parse(await readFile(path.join(workDir, META_FILE), 'utf8'));
  } catch (error) {
    throw new Error(`${path.join(workDir, META_FILE)} cannot be read: ${error.message}`);
  }
  /** @type {Meta} */
  const meta = {
    cropWidth: null,
    trim: 0,
    cam: null,
    // Clips from before the webcam panel followed the box: the fixed 640 (buildFilter's default).
    camHeight: null,
    // Clips from before the content box: the middle of the gameplay, as it was.
    game: null,
    // Clips from before overlays existed have none.
    overlay: null,
    // Nor blur boxes.
    blurs: [],
    hook: null,
    hookSeconds: HOOK_SECONDS,
    // Nor a channel tag.
    tag: null,
    // Clips from before swear words were covered keep showing them, as when they were made.
    censor: false,
    // And sound as they did.
    muffle: false,
    captions: false,
    lang: 'en',
    briefPath: null,
    brief: null,
    checks: [],
    ...saved,
  };
  return meta;
}

async function readTranscript(workDir) {
  const transcriptPath = path.join(workDir, TRANSCRIPT_FILE);
  const text = await readIfExists(transcriptPath);
  if (text === null) throw new Error(`This clip has captions, but ${transcriptPath} is missing.`);
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`${transcriptPath} is not valid JSON: ${error.message}`);
  }
  return checkTranscript(data);
}

async function readIfExists(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** One line of plain text: no line breaks, no doubled spaces. */
function cleanLine(text) {
  return cleanOverlayText(text);
}

/**
 * @param {number} start
 * @param {number} end
 * @param {number} duration   length of the source in seconds
 */
export function checkRange(start, end, duration) {
  if (end <= start) {
    throw new Error(`--end (${formatClock(end)}) must be later than --start (${formatClock(start)}).`);
  }
  if (end > duration + END_SLACK) {
    throw new Error(
      `The range ends at ${formatClock(end)}, but the video is only ${formatClock(duration)} long.`,
    );
  }
}

// Long enough to recognise the clip by, short enough for a folder name.
const SLUG_MAX_LENGTH = 50;

/**
 * Turn a hook into a folder name: lower case, with a dash wherever there
 * was anything other than a letter or a digit. "Barca wants WHO?" becomes
 * "barca-wants-who". Returns '' when nothing usable is left.
 *
 * @param {string} hook
 * @returns {string}
 */
export function clipSlug(hook) {
  const slug = hook.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  if (slug.length <= SLUG_MAX_LENGTH) return slug;
  // Too long: cut at the last whole word that fits.
  const cut = slug.slice(0, SLUG_MAX_LENGTH + 1).replace(/-[^-]*$/, '');
  return cut || slug.slice(0, SLUG_MAX_LENGTH);
}

/**
 * Create and return a new clip folder inside `outDir`.
 *
 * With a hook the folder is named after it, with "-2", "-3" and so on added
 * when that name is taken. Without a hook it is the next free `clip-NNN`.
 *
 * @param {string} outDir
 * @param {string | null} [hook]
 * @returns {Promise<string>}
 */
export async function nextClipDir(outDir, hook = null) {
  await mkdir(outDir, { recursive: true });
  const taken = await readdir(outDir);

  const slug = hook ? clipSlug(hook) : '';
  let name = slug;
  if (slug) {
    for (let n = 2; taken.includes(name); n++) name = `${slug}-${n}`;
  } else {
    const numbers = taken.map((entry) => /^clip-(\d+)$/.exec(entry)).filter(Boolean).map((match) => Number(match[1]));
    name = `clip-${String(Math.max(0, ...numbers) + 1).padStart(3, '0')}`;
  }

  const clipDir = path.join(outDir, name);
  await mkdir(clipDir);
  return clipDir;
}

/** ISO time with the local UTC offset, such as 2026-11-18T16:50:00+04:00. */
export function localIsoTime(date) {
  const two = (n) => String(Math.trunc(Math.abs(n))).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return (
    `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}` +
    `T${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}` +
    `${sign}${two(offset / 60)}:${two(offset % 60)}`
  );
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
