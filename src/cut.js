import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runChecks } from './brief/check.js';
import { buildHashtags, buildPostText, parsePostText } from './brief/postText.js';
import { applyReplacements } from './brief/replacements.js';
import { loadBrief } from './brief/schema.js';
import { buildAss, checkHook, cleanOverlayText } from './captions/ass.js';
import { groupWords } from './captions/group.js';
import { findPauses, snapToSpeech } from './captions/pauses.js';
import { buildFilter, OUT_FPS, OUT_HEIGHT, OUT_WIDTH, SUBTITLE_FILE } from './layout.js';
import { probe } from './probe.js';
import { CLIP_FILE, extractAudio, render } from './render.js';
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
 * @param {number} [options.trim]
 * @param {{ x: number, y: number, width: number, height: number }} [options.cam]
 * @param {string} [options.hook]
 * @param {boolean} [options.captions]
 * @param {string} [options.lang]
 * @param {string} [options.briefFile]
 * @param {string} [options.title]         for post.txt; the hook when missing
 * @param {string} [options.description]   for post.txt
 * @param {string} [options.outDir]
 * @param {string} options.toolVersion
 * @param {Transcriber} [options.transcriber]   replaced in tests
 * @returns {Promise<ClipResult>}
 */
export async function cut({
  source,
  start,
  end,
  layout = 'center',
  cropX,
  trim = 0,
  cam,
  hook,
  captions = true,
  lang = 'en',
  briefFile,
  title,
  description,
  outDir = './out',
  toolVersion,
  transcriber = getTranscriber(),
}) {
  const sourcePath = path.resolve(source);
  const info = await probe(sourcePath);
  checkRange(start, end, info.duration);
  const hookText = hook === undefined ? null : checkHook(hook);
  // Built here only to reject bad options before anything is written.
  const filter = buildFilter({ layout, source: info, cropX, trim, cam });

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
      onScreen: onScreenTexts(hookText, brief),
    }).filter((check) => !check.pass);
    if (failed.length > 0) {
      const lines = failed.map((check) => `  ${check.rule}: ${check.detail}`);
      throw new Error(`The brief "${brief.id}" does not allow this clip:\n${lines.join('\n')}`);
    }
  } else if (title !== undefined || description !== undefined) {
    throw new Error('--title and --desc go into post.txt, which is only written with --brief.');
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

  const clipDir = await nextClipDir(path.resolve(outDir));
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
    trim,
    cam: cam ?? null,
    hook: hookText,
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

  if (wantCaptions) {
    try {
      const audioFile = await extractAudio({ source: sourcePath, start, seconds: end - start, workDir });
      const transcript = checkTranscript(await transcriber.transcribe(audioFile, { lang }));
      transcript.words = snapToSpeech(transcript.words, await findPauses(audioFile));
      if (brief) transcript.words = applyReplacements(transcript.words, brief.replacements);
      await writeJson(path.join(workDir, TRANSCRIPT_FILE), transcript);
      await rm(audioFile, { force: true });
    } catch (error) {
      throw new Error(`${error.message}\nThe run's files are in ${clipDir}.`);
    }
  }

  return renderClip(clipDir, workDir, meta, info, warnings);
}

/**
 * Render an existing clip folder again from its meta.json and, when it has
 * captions, its transcript.json. This is how a wrong word gets fixed: edit
 * work/transcript.json, then re-render. post.txt is left as it is.
 *
 * @param {string} clipDir
 * @returns {Promise<ClipResult>}
 */
export async function rerender(clipDir) {
  const dir = path.resolve(clipDir);
  const workDir = await findWorkDir(dir);
  const meta = await readMeta(workDir);
  let info;
  try {
    info = await probe(meta.source);
  } catch (error) {
    throw new Error(`The source video for this clip cannot be used any more.\n${error.message}`);
  }
  return renderClip(dir, workDir, meta, info, []);
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
 * Steps shared by `cut` and `rerender`: build the subtitle file, run ffmpeg,
 * check the result and record it in meta.json.
 *
 * @param {string} clipDir
 * @param {string} workDir   the folder with meta.json; see findWorkDir
 * @param {Meta} meta
 * @param {VideoInfo} info   the source video
 * @param {string[]} warnings
 * @returns {Promise<ClipResult>}
 */
async function renderClip(clipDir, workDir, meta, info, warnings) {
  const seconds = meta.end - meta.start;
  const card = meta.brief?.endCard ?? null;
  const total = seconds + (card?.seconds ?? 0);

  let groups = [];
  if (meta.captions) {
    groups = groupWords((await readTranscript(workDir)).words, seconds);
    if (groups.length === 0) warnings.push('No speech was found in this range, so the clip has no captions.');
  }

  const shown = onScreenTexts(meta.hook, meta.brief);
  const subtitles = groups.length > 0 || Boolean(shown.hook || shown.disclosure || shown.endCard);
  const subtitlePath = path.join(workDir, SUBTITLE_FILE);
  if (subtitles) {
    const ass = buildAss({
      groups,
      hook: shown.hook,
      disclosure: shown.disclosure,
      endCard: shown.endCard ? { text: shown.endCard, seconds: card.seconds } : null,
      layout: meta.layout,
      clipSeconds: seconds,
    });
    await writeFile(subtitlePath, ass);
  } else {
    await rm(subtitlePath, { force: true });
  }

  const filter = buildFilter({
    layout: meta.layout,
    source: info,
    cropX: meta.cropX ?? undefined,
    trim: meta.trim,
    cam: meta.cam ?? undefined,
    subtitles,
    endCard: card ? { at: seconds, seconds: card.seconds, image: Boolean(card.image) } : undefined,
  });

  try {
    await render({
      source: meta.source,
      start: meta.start,
      seconds,
      graph: filter.graph,
      audioLabel: filter.audioLabel,
      endCard: card,
      clipDir,
      workDir,
      subtitles,
    });
  } catch (error) {
    throw new Error(`${error.message}\nThe run's files are in ${clipDir}.`);
  }

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
    onScreen: onScreenTexts(meta.hook, meta.brief),
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
 */
function onScreenTexts(hook, brief) {
  return {
    hook,
    disclosure: brief?.disclosure.mode === 'onscreen' ? brief.disclosure.text : null,
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
    trim: 0,
    cam: null,
    hook: null,
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

/**
 * Create and return the next free `clip-NNN` folder inside `outDir`.
 *
 * @param {string} outDir
 * @returns {Promise<string>}
 */
export async function nextClipDir(outDir) {
  await mkdir(outDir, { recursive: true });
  const numbers = (await readdir(outDir))
    .map((name) => /^clip-(\d+)$/.exec(name))
    .filter(Boolean)
    .map((match) => Number(match[1]));
  const next = Math.max(0, ...numbers) + 1;
  const clipDir = path.join(outDir, `clip-${String(next).padStart(3, '0')}`);
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
