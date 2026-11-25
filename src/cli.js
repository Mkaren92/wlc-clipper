#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Command, InvalidArgumentError, Option } from 'commander';
import { getAi } from './ai/client.js';
import { suggestMoments } from './ai/suggest.js';
import { loadBrief } from './brief/schema.js';
import { PRESETS } from './chat/presets.js';
import { parseTermGroups } from './chat/terms.js';
import { checkClip, cut, rerender } from './cut.js';
import { loadEnv } from './env.js';
import { fetchVideo } from './fetch.js';
import { LAYOUTS } from './layout.js';
import { savePart } from './part.js';
import { readSources } from './sources.js';
import { probe } from './probe.js';
import { formatClock, parseTime } from './time.js';
import { getTranscriber } from './transcribe/index.js';

loadEnv();

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function timeOption(value) {
  try {
    return parseTime(value);
  } catch (error) {
    throw new InvalidArgumentError(error.message);
  }
}

function pixelOption(value) {
  if (!/^\d+$/.test(value)) throw new InvalidArgumentError('Give a whole number of pixels.');
  return Number(value);
}

function secondsOption(value) {
  const seconds = Number(value);
  if (value.trim() === '' || !Number.isFinite(seconds) || seconds < 0) {
    throw new InvalidArgumentError('Give a number of seconds, 0 or more.');
  }
  return seconds;
}

/** One --blur: x,y,w,h in source pixels, start,end in seconds from the clip's start, and optionally "black". */
function blurOption(value, list) {
  const parts = value.split(',').map((part) => part.trim());
  const style = parts.length === 7 ? parts.pop() : 'blur';
  const numbers = parts.map(Number);
  if (numbers.length !== 6 || numbers.some((n) => !Number.isFinite(n)) || !['blur', 'black'].includes(style)) {
    throw new InvalidArgumentError('Give x,y,w,h,start,end, for example 600,300,120,120,1.5,4, and optionally ,black at the end.');
  }
  const [x, y, width, height, start, end] = numbers;
  return [...list, { x, y, width, height, start, end, style }];
}

function camOption(value) {
  const parts = value.split(',');
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part.trim()))) {
    throw new InvalidArgumentError('Give four whole numbers: x,y,w,h, such as 1400,40,480,270.');
  }
  const [x, y, width, height] = parts.map(Number);
  return { x, y, width, height };
}

const program = new Command();

program
  .name('clipper')
  .description('Turns a local video file and a time range into a finished 1080x1920 clip.')
  .version(pkg.version);

program
  .command('probe')
  .description('Show resolution, frame rate, duration and whether the source is already vertical')
  .argument('<file>', 'video file')
  .action(async (file) => {
    const info = await probe(file);
    console.log(`File        ${path.resolve(file)}`);
    console.log(`Resolution  ${info.width}x${info.height}`);
    console.log(`Frame rate  ${info.fps} fps`);
    console.log(`Duration    ${formatClock(info.duration)} (${info.duration.toFixed(2)} s)`);
    console.log(`Vertical    ${info.isVertical ? 'yes' : 'no'}`);
    console.log(`Audio       ${describeAudio(info.audioStreams)}`);
  });

program
  .command('cut')
  .description('Produce one finished clip')
  .argument('<file>', 'video file')
  .requiredOption('--start <time>', 'start of the range: seconds, mm:ss or hh:mm:ss', timeOption)
  .requiredOption('--end <time>', 'end of the range, same formats', timeOption)
  .addOption(new Option('--layout <name>', 'how to fit the picture into 9:16').choices(LAYOUTS).default('center'))
  .option('--crop-x <pixels>', 'left edge of the crop in source pixels, for the center layout', pixelOption)
  .option('--crop-width <pixels>', 'width of the crop in source pixels, for the center layout; wider than the 9:16 column shows more of the picture over a blurred copy', pixelOption)
  .option('--cam <x,y,w,h>', 'webcam rectangle in source pixels, required for the facecam layout', camOption)
  .option('--overlay <file>', 'a PNG or WebP shown for the whole clip: a logo in a corner, or a full 9:16 picture')
  .option('--overlay-width <pixels>', 'the logo\'s width in the clip', pixelOption)
  .option('--overlay-position <corner>', 'top-left, top-right, bottom-left or bottom-right')
  .option('--overlay-margin <pixels>', 'distance from the corner\'s edges', pixelOption)
  .option('--overlay-offset <pixels>', 'moves the logo down (or up, with a minus sign)', (value) => {
    if (!/^-?\d+$/.test(value.trim())) throw new InvalidArgumentError('Give a whole number of pixels, such as 660 or -40.');
    return Number(value);
  })
  .option('--game <x,y,w,h>', 'content rectangle in source pixels for the facecam layout; without it, the middle of the gameplay', camOption)
  .option('--blur <x,y,w,h,start,end[,black]>', 'blur part of the frame (source pixels) for part of the clip (seconds from the clip\'s start); add ",black" to black it out instead; repeat for more', blurOption, [])
  .option('--trim <pixels>', 'cut this many pixels off every edge of the source first, to remove a frame baked into the recording', pixelOption, 0)
  .option('--hook <text>', 'line shown at the top at the start of the clip')
  .option('--hook-seconds <seconds>', 'how long the hook stays on screen; 0 keeps it for the whole clip', secondsOption, 2.5)
  .option('--tag <text>', 'the streamer\'s channel, such as @theburntpeanut, shown at the top for the whole clip')
  .option('--no-captions', 'skip transcription and captions')
  .option('--no-censor', 'show swear words in the captions and the hook as they are, not as F*CK')
  .option('--no-muffle', 'leave the sound as it is while a swear word is spoken')
  .option('--lang <code>', 'language spoken in the video, passed to the transcriber', 'en')
  .option('--brief <file>', 'campaign brief to follow and check the clip against')
  .option('--title <text>', 'title for post.txt (defaults to the hook)')
  .option('--desc <text>', 'description for post.txt')
  .option('--out <dir>', 'output folder', './out')
  .action(async (file, options) => {
    report(
      await cut({
        source: file,
        start: options.start,
        end: options.end,
        layout: options.layout,
        cropX: options.cropX,
        cropWidth: options.cropWidth,
        cam: options.cam,
        game: options.game,
        blurs: options.blur,
        overlay: options.overlay
          ? { image: options.overlay, width: options.overlayWidth, position: options.overlayPosition, margin: options.overlayMargin, offsetY: options.overlayOffset }
          : undefined,
        trim: options.trim,
        hook: options.hook,
        hookSeconds: options.hookSeconds,
        tag: options.tag,
        captions: options.captions,
        censor: options.censor,
        muffle: options.muffle,
        lang: options.lang,
        briefFile: options.brief,
        title: options.title,
        description: options.desc,
        outDir: options.out,
        toolVersion: pkg.version,
      }),
    );
  });

program
  .command('extract')
  .description('Save a part of a video as it is: original size, no hook, no captions')
  .argument('<file>', 'video file')
  .requiredOption('--start <time>', 'start of the range: seconds, mm:ss or hh:mm:ss', timeOption)
  .requiredOption('--end <time>', 'end of the range, same formats', timeOption)
  .option('--out <dir>', 'folder the part is saved in', './parts')
  .action(async (file, options) => {
    const part = await savePart({ source: file, start: options.start, end: options.end, outDir: options.out });
    console.log(`Wrote ${part.file}`);
    console.log(`${part.width}x${part.height}, ${part.fps} fps, ${part.seconds.toFixed(2)} s`);
  });

program
  .command('fetch')
  .description('Bring part of a YouTube video or Twitch past broadcast, or a whole one up to 3 hours, into the videos folder. Only from a channel marked as agreed in the sources list')
  .argument('<link>', 'link to one YouTube video, or a Twitch video (https://www.twitch.tv/videos/...)')
  .option('--start <time>', 'start of the part: seconds, mm:ss or hh:mm:ss', timeOption)
  .option('--end <time>', 'end of the part, same formats', timeOption)
  .option('--whole', 'the whole video instead of a part, up to 3 hours')
  .option('--label <text>', 'your own name for the file, put in front of the name the tool gives it')
  .option('--out <dir>', 'folder the video is saved in', './in')
  .option('--data <dir>', 'folder that holds sources.json', './data')
  .action(async (link, options) => {
    if (options.whole && (options.start !== undefined || options.end !== undefined)) {
      throw new Error('Give either --whole or --start and --end, not both.');
    }
    if (!options.whole && (options.start === undefined || options.end === undefined)) {
      throw new Error('Give --start and --end for a part, or --whole for the whole video.');
    }
    const fetched = await fetchVideo({
      url: link, start: options.start, end: options.end, whole: Boolean(options.whole), label: options.label ?? '', outDir: options.out,
      sources: await readSources(path.resolve(options.data)),
      onStep: (step) => console.log({ looking: 'Looking the video up...', fetching: 'Fetching...', 'fetching-slow': 'The fast way did not work; fetching the slower way...', tidying: 'Preparing the video...' }[step]),
    });
    console.log(`Wrote ${fetched.file}`);
    console.log(`${fetched.seconds.toFixed(2)} s from ${fetched.source.name}: ${fetched.title}`);
    if (fetched.slow) console.log(`It came the slow way, because the fast way did not work: ${fetched.slow}`);
    if (fetched.early > 0.05) console.log(`It starts ${fetched.early.toFixed(1)} s before the time you asked, where the video could be cut without losing quality.`);
  });

program
  .command('render')
  .description('Render an existing clip folder again, for example after fixing a word in its work/transcript.json')
  .argument('<clip-folder>', 'a folder made by cut, such as out/clip-001')
  .action(async (clipFolder) => {
    report(await rerender(clipFolder));
  });

program
  .command('check')
  .description('Check an existing clip and its post.txt against a brief')
  .argument('<clip-folder>', 'a folder made by cut, such as out/clip-001')
  .option('--brief <file>', 'brief to check against (default: the one the clip was made with)')
  .action(async (clipFolder, options) => {
    const result = await checkClip(clipFolder, options.brief);
    reportChecks(result.checks, result.brief);
  });

program
  .command('suggest')
  .description('Ask an AI service for moments worth clipping. Sends the transcript text, not the video')
  .argument('<file>', 'video file')
  .option('--count <number>', 'how many moments to propose', pixelOption, 5)
  .option('--brief <file>', 'campaign brief the clips should follow')
  .option('--lang <code>', 'language spoken in the video', 'en')
  .option('--out <dir>', 'output folder; the whole-video transcript is kept in its .cache', './out')
  .option('--terms <file>', 'event terms: a JSON file such as [{ "label": "Goal", "terms": ["goal", "gol"] }]')
  .option('--preset <name>', 'event terms from a preset: football or gaming')
  .option('--guidance <text>', 'what a good moment is for this video, in your own words')
  .option('--again', 'ask the AI again even when an answer for the same inputs is kept')
  .option('--loud', 'also tell it where the streamer\'s voice is much louder than usual (times and decibels only)')
  .action(async (file, options) => {
    const ai = getAi();
    const brief = options.brief ? (await loadBrief(options.brief)).brief : null;
    if (options.terms && options.preset) throw new Error('Give either --terms or --preset, not both.');
    if (options.preset && !Object.hasOwn(PRESETS, options.preset)) throw new Error(`There is no preset named "${options.preset}". Choose ${Object.keys(PRESETS).join(' or ')}.`);
    const terms = options.preset ? PRESETS[options.preset].groups : parseTermGroups(options.terms ? JSON.parse(await readFile(options.terms, 'utf8')) : []);
    const steps = { transcribing: 'Transcribing the whole video (kept for next time)...', listening: 'Measuring where the voice gets loud...', thinking: `Asking ${ai.service} (${ai.model})...` };
    const { moments, usage, fromCache, resultFromCache } = await suggestMoments({
      source: file,
      count: options.count,
      brief,
      lang: options.lang,
      cacheDir: path.join(path.resolve(options.out), '.cache'),
      transcriber: getTranscriber(),
      ai,
      terms,
      guidance: options.guidance ?? '',
      force: Boolean(options.again),
      loud: Boolean(options.loud),
      onStep: (step) => console.log(steps[step] ?? step),
    });
    if (resultFromCache) console.log('Showing the answer kept from an earlier run with the same inputs. Add --again to ask again.');
    else if (fromCache) console.log('Used the transcript kept from an earlier run.');
    if (moments.length === 0) console.log('No usable moments came back. Try again, or a different --count.');

    moments.forEach((moment, i) => {
      const seconds = (moment.end - moment.start).toFixed(1);
      console.log(`\n${i + 1}. ${formatClock(moment.start)} to ${formatClock(moment.end)} (${seconds} s), rated ${moment.score.toFixed(2)}`);
      console.log(`   Why:   ${moment.reason}`);
      if (moment.label) console.log(`   Event: ${moment.label}${moment.matchedTerms ? ` (heard: ${moment.matchedTerms.join(', ')})` : ''}`);
      if (moment.hook) console.log(`   Hook:  ${moment.hook}`);
      console.log(`   Title: ${moment.title}`);
      console.log(`   Text:  ${moment.description}`);
      for (const problem of moment.problems) console.log(`   Brief: ${problem}`);
      // Only numbers go into the command. The hook and title were written by
      // a model, so they are shown as text above and never placed in a shell line.
      console.log(`   Cut:   clipper cut ${shellQuote(file)} --start ${moment.start} --end ${moment.end}`);
    });
    console.log(`\nSent ${usage.input} tokens to ${ai.service} and received ${usage.output}.`);
  });

/** Quote a file name for a shell command line. */
function shellQuote(text) {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

function report({ clipDir, meta, warnings, checks }) {
  const { output } = meta;
  const captions = meta.captions ? `${output.captionGroups} caption groups` : 'no captions';
  console.log(`Wrote ${path.join(clipDir, output.file)}`);
  console.log(
    `${output.width}x${output.height}, ${output.fps} fps, ${output.seconds.toFixed(2)} s, layout ${meta.layout}, ${captions}`,
  );
  for (const warning of warnings) console.warn(`Warning: ${warning}`);
  if (meta.brief) reportChecks(checks, meta.brief);
}

/**
 * Print a pass or fail line for each rule, then the things only a person can
 * do. A failed rule makes the command exit with an error code.
 */
function reportChecks(checks, brief) {
  console.log('');
  for (const check of checks) {
    console.log(check.pass ? `PASS  ${check.rule}` : `FAIL  ${check.rule}: ${check.detail}`);
  }
  const failed = checks.filter((check) => !check.pass).length;
  if (failed > 0) {
    console.log(`\n${failed} of ${checks.length} checks failed.`);
    process.exitCode = 1;
  }
  if (!brief) return;
  const reminders = [...brief.manualChecks];
  if (brief.platforms.length > 0) reminders.unshift(`Post to: ${brief.platforms.join(', ')}`);
  if (reminders.length > 0) {
    console.log('\nTo do by hand:');
    for (const reminder of reminders) console.log(`  [ ] ${reminder}`);
  }
}

function describeAudio(count) {
  if (count === 0) return 'none';
  if (count === 1) return '1 track';
  return `${count} tracks (the clip keeps the first)`;
}

program.parseAsync().catch((error) => {
  console.error(`clipper: ${error.message}`);
  process.exitCode = 1;
});
