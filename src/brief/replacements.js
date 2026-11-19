/** @typedef {import('../types.js').Word} Word */

/**
 * Apply a brief's word fixes to a transcript. A key may be one word or
 * several ("forge gooey"); several words become a single word that spans
 * their time. Matching ignores case and the punctuation around a word, and
 * punctuation after the last matched word is kept.
 *
 * @param {Word[]} words
 * @param {Record<string, string>} replacements
 * @returns {Word[]}
 */
export function applyReplacements(words, replacements) {
  // Longest keys first, so "forge gooey" wins over "forge".
  const rules = Object.entries(replacements)
    .map(([from, to]) => ({ parts: from.toLowerCase().split(/\s+/).filter(Boolean), to }))
    .filter((rule) => rule.parts.length > 0)
    .sort((a, b) => b.parts.length - a.parts.length);
  if (rules.length === 0) return words;

  const bare = words.map((word) => strip(word.text).toLowerCase());
  const out = [];
  for (let i = 0; i < words.length; ) {
    const rule = rules.find((r) => r.parts.every((part, j) => bare[i + j] === part));
    if (!rule) {
      out.push(words[i]);
      i += 1;
      continue;
    }
    const last = words[i + rule.parts.length - 1];
    const trailing = /[^\p{L}\p{N}]*$/u.exec(last.text)[0];
    out.push({ ...words[i], text: rule.to + trailing, end: last.end });
    i += rule.parts.length;
  }
  return out;
}

function strip(text) {
  return text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}
