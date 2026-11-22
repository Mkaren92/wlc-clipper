// The owner's "event terms": groups of words and phrases that mark a kind of
// moment ("Goal": goal, gol, golazo, what a goal). One matcher, used for chat
// messages and for transcript words alike, so both find the same things.
//
// Nothing here touches a file or a program, so the engine and the dashboard
// page both use it.
import { z } from 'zod';

/** @typedef {{ label: string, terms: string[] }} TermGroup */
/** @typedef {{ label: string, variants: Array<{ term: string, tokens: string[] }> }} CompiledGroup */
/** @typedef {CompiledGroup[]} Compiled */

/**
 * Text made comparable: lower case, accents taken off, and any letter written
 * three or more times in a row cut to one, so "GOOOOOL" reads "gol" and
 * "Golazó" reads "golazo". Two of a letter stay two: "goal" is unchanged.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeText(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/(\p{L})\1{2,}/gu, '$1');
}

/**
 * The words of a text, made comparable. Anything that is not a letter or a
 * digit separates words, so an emote like `:_P11Papi:` becomes `p11papi`.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  return normalizeText(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

const termsSchema = z
  .array(z.string(), 'the terms are a list of words or phrases')
  .transform((terms) => terms.map((term) => term.trim()).filter(Boolean))
  .pipe(
    z
      .array(z.string().max(60, 'a term is at most 60 characters'))
      .min(1, 'a group needs at least one term')
      .max(50, 'a group has at most 50 terms'),
  );

// The label is trimmed before its length is checked, like the terms.
const groupSchema = z.strictObject({
  label: z.string().trim().min(1, 'a group needs a name').max(40, 'a group name is at most 40 characters'),
  terms: termsSchema,
});

const groupsSchema = z
  .array(groupSchema)
  .max(20, 'there can be at most 20 groups of terms')
  .superRefine((groups, ctx) => {
    const seen = new Set();
    for (const group of groups) {
      if (seen.has(group.label)) ctx.addIssue({ code: 'custom', message: `two groups are both named "${group.label}"` });
      seen.add(group.label);
    }
  });

/**
 * Checks term groups that came from a person or the browser. Nothing given
 * is no groups. Anything wrong (an unknown field, a group with no terms, too
 * many groups, two groups with one name) is an error.
 *
 * @param {unknown} value
 * @returns {TermGroup[]}
 */
export function parseTermGroups(value) {
  if (value === undefined || value === null) return [];
  const result = groupsSchema.safeParse(value);
  if (!result.success) throw new Error(`The event terms are not valid:\n${z.prettifyError(result.error)}`);
  return result.data;
}

/**
 * Splits every term into words once, so matching is quick. A term of several
 * words ("what a goal") is a phrase; a term with no words in it is skipped.
 *
 * @param {TermGroup[]} groups
 * @returns {Compiled}
 */
export function compileTerms(groups) {
  return (groups ?? []).map((group) => ({
    label: group.label,
    variants: group.terms.map((term) => ({ term, tokens: tokenize(term) })).filter((one) => one.tokens.length > 0),
  }));
}

/** Whether the words `phrase` appear one after another somewhere in `tokens`. */
function hasPhrase(tokens, phrase) {
  for (let at = 0; at + phrase.length <= tokens.length; at++) {
    let all = true;
    for (let i = 0; i < phrase.length && all; i++) all = tokens[at + i] === phrase[i];
    if (all) return true;
  }
  return false;
}

/**
 * Which groups a text matches, and by which of their terms. Whole words only,
 * so "pen" does not match "open". A group is listed once however many of its
 * terms are in the text.
 *
 * @param {string | string[]} textOrTokens   a text, or its words from `tokenize`
 * @param {Compiled} compiled
 * @returns {Array<{ label: string, terms: string[] }>}
 */
export function matchTerms(textOrTokens, compiled) {
  const tokens = Array.isArray(textOrTokens) ? textOrTokens : tokenize(textOrTokens);
  const found = [];
  for (const group of compiled) {
    const terms = group.variants.filter((variant) => hasPhrase(tokens, variant.tokens)).map((variant) => variant.term);
    if (terms.length) found.push({ label: group.label, terms });
  }
  return found;
}

/**
 * Only the names of the groups a text matches.
 *
 * @param {string | string[]} textOrTokens
 * @param {Compiled} compiled
 * @returns {string[]}
 */
export function matchedLabels(textOrTokens, compiled) {
  return matchTerms(textOrTokens, compiled).map((match) => match.label);
}
