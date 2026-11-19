import { access, rename, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FONT_FILE } from './captions/ass.js';
import { CARD_COLOUR, FONTS_LINK, OUT_FPS, OUT_HEIGHT, OUT_WIDTH } from './layout.js';
import { run } from './run.js';

export const CLIP_FILE = 'clip.mp4';
export const AUDIO_FILE = 'audio.wav';
// ffmpeg writes here first, so a failed re-render leaves the old clip intact.
const PARTIAL_FILE = 'clip.partial.mp4';
const FONTS_DIR = fileURLToPath(new URL('../assets/fonts', import.meta.url));

// Shared by every layout. The frame rate is set inside the filter graph; see
// layout.js for why `-r` is not used here.
const ENCODE_SETTINGS = [
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
  '-movflags', '+faststart',
];

/**
 * Assemble the ffmpeg arguments for one clip.
 *
 * `-ss` and `-t` both come before `-i`, so ffmpeg reads exactly the wanted
 * range and the output starts at time zero, where subtitle times line up.
 * Limiting the input matters with an end card: the output is longer than the
 * range, and the source must not keep playing under the card.
 *
 * Only the first audio track is kept: recordings with separate game and
 * microphone tracks would otherwise carry all of them into the clip. The `?`
 * lets a source with no audio through.
 *
 * @param {object} options
 * @param {string} options.source
 * @param {number} options.start
 * @param {number} options.seconds        length of the footage
 * @param {string} options.graph
 * @param {string | null} [options.audioLabel]   sound output of the graph, if it makes one
 * @param {{ seconds: number, image?: string } | null} [options.endCard]
 * @param {string} [options.output]   file to write
 * @returns {string[]}
 */
export function renderArgs({ source, start, seconds, graph, audioLabel = null, endCard = null, output = PARTIAL_FILE }) {
  const total = seconds + (endCard?.seconds ?? 0);
  // The card's plain background is ffmpeg's second input. Its picture, when
  // there is one, is the third, held still for the whole clip.
  const cardInput = [];
  if (endCard) {
    const background = `color=c=${CARD_COLOUR}:s=${OUT_WIDTH}x${OUT_HEIGHT}:r=${OUT_FPS}`;
    cardInput.push('-f', 'lavfi', '-t', toSeconds(total), '-i', background);
    if (endCard.image) {
      cardInput.push('-loop', '1', '-framerate', String(OUT_FPS), '-t', toSeconds(total), '-i', endCard.image);
    }
  }
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', toSeconds(start),
    '-t', toSeconds(seconds),
    '-i', source,
    ...cardInput,
    '-filter_complex', graph,
    '-map', '[v]',
    '-map', audioLabel ?? '0:a:0?',
    '-t', toSeconds(total),
    ...ENCODE_SETTINGS,
    output,
  ];
}

/**
 * Run ffmpeg inside the folder that holds the subtitle file, so the filter
 * graph can name that file and the fonts folder without any path escaping.
 * The finished clip is written to the clip folder itself.
 *
 * @param {object} options
 * @param {string} options.source
 * @param {number} options.start
 * @param {number} options.seconds
 * @param {string} options.graph
 * @param {string | null} [options.audioLabel]
 * @param {{ seconds: number, image?: string } | null} [options.endCard]
 * @param {string} options.clipDir   where clip.mp4 goes
 * @param {string} options.workDir   where the subtitle file is
 * @param {boolean} [options.subtitles]   the graph burns in the subtitle file
 */
export async function render({ clipDir, workDir, subtitles = false, ...options }) {
  const fontsLink = path.join(workDir, FONTS_LINK);
  const partial = path.join(clipDir, PARTIAL_FILE);
  if (subtitles) {
    // Without this check a missing font would not fail: the subtitle
    // renderer quietly picks whatever the machine has.
    try {
      await access(path.join(FONTS_DIR, FONT_FILE));
    } catch {
      throw new Error(`The caption font is missing: ${path.join(FONTS_DIR, FONT_FILE)}`);
    }
    await rm(fontsLink, { force: true });
    await symlink(FONTS_DIR, fontsLink, 'dir');
  }

  try {
    await run('ffmpeg', renderArgs({ ...options, output: partial }), { cwd: workDir });
    await rename(partial, path.join(clipDir, CLIP_FILE));
  } finally {
    await rm(partial, { force: true });
    await rm(fontsLink, { force: true });
  }
}

/**
 * Write the range's sound as 16 kHz mono WAV for the transcriber. It uses the
 * same seek and the same audio track as the render, so word times match the clip.
 *
 * @param {{ source: string, start: number, seconds: number, workDir: string }} options
 * @returns {Promise<string>} path of the WAV file
 */
export async function extractAudio({ source, start, seconds, workDir }) {
  await run(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', toSeconds(start),
      '-i', source,
      '-t', toSeconds(seconds),
      '-vn', '-map', '0:a:0',
      '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
      AUDIO_FILE,
    ],
    { cwd: workDir },
  );
  return path.join(workDir, AUDIO_FILE);
}

function toSeconds(n) {
  return n.toFixed(3);
}
