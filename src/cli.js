#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Command, InvalidArgumentError, Option } from 'commander';
import { checkClip, cut, rerender } from './cut.js';
import { LAYOUTS } from './layout.js';
import { probe } from './probe.js';
import { formatClock, parseTime } from './time.js';

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
  .option('--cam <x,y,w,h>', 'webcam rectangle in source pixels, required for the facecam layout', camOption)
  .option('--trim <pixels>', 'cut this many pixels off every edge of the source first, to remove a frame baked into the recording', pixelOption, 0)
  .option('--hook <text>', 'line shown at the top for the first 2.5 seconds')
  .option('--no-captions', 'skip transcription and captions')
  .option('--lang <code>', 'language spoken in the video, passed to the transcriber', 'en')
  .option('--brief <file>', 'campaign brief to follow and check the clip against')
  .option('--title <text>', 'title for post.txt (needs --brief; defaults to the hook)')
  .option('--desc <text>', 'description for post.txt (needs --brief)')
  .option('--out <dir>', 'output folder', './out')
  .action(async (file, options) => {
    report(
      await cut({
        source: file,
        start: options.start,
        end: options.end,
        layout: options.layout,
        cropX: options.cropX,
        cam: options.cam,
        trim: options.trim,
        hook: options.hook,
        captions: options.captions,
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
