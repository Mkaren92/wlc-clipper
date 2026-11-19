import { z } from 'zod';

/** @typedef {import('../types.js').Word} Word */
/** @typedef {import('./client.js').Ai} Ai */

// Plain on purpose; the answer is checked in tidyFixes.
const answerSchema = z.object({
  fixes: z.array(z.object({ index: z.number(), text: z.string() })),
});

/**
 * Ask the AI service which transcript words were probably misheard.
 * Returns proposals only: nothing is saved here. Only the words are sent.
 *
 * @param {object} options
 * @param {Word[]} options.words
 * @param {Ai} options.ai
 * @param {string[]} [options.knownTerms]   names the speaker is likely to say, spelled correctly
 * @returns {Promise<{ fixes: { index: number, from: string, to: string }[], model: string,
 *   usage: { input: number, output: number } }>}
 */
export async function proposeWordFixes({ words, ai, knownTerms = [] }) {
  if (words.length === 0) return { fixes: [], model: ai.model, usage: { input: 0, output: 0 } };
  const { data, usage } = await ai.ask({
    system: instructions(knownTerms),
    user: words.map((word, index) => `${index}: ${word.text}`).join('\n'),
    schema: answerSchema,
    schemaName: 'fixes',
  });
  return { fixes: tidyFixes(data.fixes, words), model: ai.model, usage };
}

function instructions(knownTerms) {
  const lines = [
    'Below is a speech-to-text transcript of a video, one word per line, each with its number.',
    'Find the words the transcriber most likely got wrong: a misheard word, a misspelled name, a brand name written wrongly.',
    'Return only the words you are confident are wrong, each with its number and the corrected word.',
    'Keep the punctuation and the capital letters of the original word. Each fix replaces exactly one word with one word.',
    'Do not rephrase, do not improve grammar or style, do not add or remove words. If nothing is wrong, return an empty list.',
  ];
  if (knownTerms.length > 0) lines.push(`Names that may be spoken, with their correct spelling: ${knownTerms.join(', ')}.`);
  return lines.join('\n');
}

/**
 * Keep only fixes that can be applied safely: a real word number, one
 * replacement word, and an actual change.
 *
 * @param {unknown[]} raw
 * @param {Word[]} words
 */
export function tidyFixes(raw, words) {
  const byIndex = new Map();
  for (const item of Array.isArray(raw) ? raw : []) {
    const index = item?.index;
    const to = typeof item?.text === 'string' ? item.text.trim() : '';
    if (!Number.isInteger(index) || index < 0 || index >= words.length) continue;
    if (to === '' || /\s/.test(to) || /[{}\\]/.test(to) || to === words[index].text) continue;
    if (!byIndex.has(index)) byIndex.set(index, { index, from: words[index].text, to });
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}
