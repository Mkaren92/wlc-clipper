import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

/** @typedef {z.infer<typeof briefSchema>} Brief */

const hashtag = z.string().regex(/^#[^\s#]+$/, 'a hashtag starts with # and has no spaces');
const term = z.string().trim().min(1);

// Strict objects: a misspelled field in a hand-written brief is an error, not
// a rule that silently never runs.
export const briefSchema = z
  .strictObject({
    id: z.string().trim().min(1),
    platforms: z.array(term).default([]),
    minSeconds: z.number().positive().optional(),
    maxSeconds: z.number().positive().optional(),
    hashtags: z
      .strictObject({
        required: z.array(hashtag).default([]),
        strictOrder: z.boolean().default(false),
        optional: z.array(hashtag).default([]),
      })
      .default({ required: [], strictOrder: false, optional: [] }),
    // Terms for the post's description. "Caption" in this tool always means
    // the words burned into the video, so the field is not called that.
    descriptionMustInclude: z.array(term).default([]),
    onScreenTextMustInclude: z.array(term).default([]),
    forbiddenTerms: z.array(term).default([]),
    disclosure: z
      .strictObject({
        mode: z.enum(['hashtag', 'onscreen', 'none']),
        text: z.string().trim().default(''),
      })
      .default({ mode: 'none', text: '' }),
    endCard: z
      .strictObject({
        image: z.string().min(1).optional(),
        seconds: z.number().positive().max(10),
        text: z.string().trim().min(1).optional(),
      })
      .optional(),
    // A logo or full-frame picture shown for the whole clip (src/overlay.js). Every clip made
    // with this brief gets it, and the checks fail a clip rendered without it.
    overlay: z
      .strictObject({
        image: z.string().min(1),
        width: z.number().int().min(20).max(1080).default(220),
        position: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right']).default('top-left'),
        margin: z.number().int().min(0).max(400).default(40),
        offsetY: z.number().int().min(-1920).max(1920).default(0),
      })
      .optional(),
    // The whole source frame must stay visible, which only the blur layout does.
    keepFullFrame: z.boolean().default(false),
    // Fixes for words the transcriber gets wrong, such as brand names:
    // { "forge gooey": "ForgeGUI" }.
    replacements: z.record(z.string().trim().min(1), z.string().trim().min(1)).default({}),
    manualChecks: z.array(term).default([]),
  })
  .superRefine((brief, ctx) => {
    if (brief.minSeconds && brief.maxSeconds && brief.minSeconds > brief.maxSeconds) {
      ctx.addIssue({ code: 'custom', path: ['minSeconds'], message: 'minSeconds is larger than maxSeconds' });
    }
    if (brief.disclosure.mode === 'hashtag' && !hashtag.safeParse(brief.disclosure.text).success) {
      ctx.addIssue({ code: 'custom', path: ['disclosure', 'text'], message: 'with mode "hashtag", text must be a hashtag' });
    }
    if (brief.disclosure.mode === 'onscreen' && !brief.disclosure.text) {
      ctx.addIssue({ code: 'custom', path: ['disclosure', 'text'], message: 'with mode "onscreen", text is required' });
    }
  });

/**
 * Check brief data and fill in defaults.
 *
 * @param {unknown} data
 * @param {string} [name]   used in the error message
 * @returns {Brief}
 */
export function parseBrief(data, name = 'The brief') {
  if (data && typeof data === 'object' && 'captionMustInclude' in data) {
    throw new Error(`${name}: "captionMustInclude" is now called "descriptionMustInclude". Rename the field.`);
  }
  const result = briefSchema.safeParse(data);
  if (!result.success) throw new Error(`${name} is not valid:\n${z.prettifyError(result.error)}`);
  return result.data;
}

/**
 * Read a brief file. A relative end-card image is looked for from the folder
 * clipper runs in, then next to the brief file, and comes back as an
 * absolute path.
 *
 * @param {string} file
 * @returns {Promise<{ brief: Brief, path: string }>}
 */
export async function loadBrief(file) {
  const briefPath = path.resolve(file);
  let text;
  try {
    text = await readFile(briefPath, 'utf8');
  } catch {
    throw new Error(`Cannot read the brief ${briefPath}. Check the path.`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`${briefPath} is not valid JSON: ${error.message}`);
  }
  const brief = parseBrief(data, briefPath);

  if (brief.endCard?.image) {
    const candidates = [path.resolve(brief.endCard.image), path.resolve(path.dirname(briefPath), brief.endCard.image)];
    const found = await firstExisting(candidates);
    if (!found) {
      throw new Error(`${briefPath}: the end-card image was not found. Looked for:\n  ${candidates.join('\n  ')}`);
    }
    brief.endCard.image = found;
  }
  if (brief.overlay) {
    const candidates = [path.resolve(brief.overlay.image), path.resolve(path.dirname(briefPath), brief.overlay.image)];
    const found = await firstExisting(candidates);
    if (!found) throw new Error(`${briefPath}: the overlay image was not found. Looked for:\n  ${candidates.join('\n  ')}`);
    brief.overlay.image = found;
  }
  return { brief, path: briefPath };
}

async function firstExisting(files) {
  for (const file of files) {
    try {
      await access(file);
      return file;
    } catch {
      // try the next one
    }
  }
  return null;
}
