/** @typedef {import('./schema.js').Brief} Brief */

/**
 * The hashtags for a post: the required ones in the brief's order, the
 * disclosure hashtag if the brief uses one, then the optional ones.
 *
 * @param {Brief} brief
 * @returns {string[]}
 */
export function buildHashtags(brief) {
  const tags = [...brief.hashtags.required];
  if (brief.disclosure.mode === 'hashtag') tags.push(brief.disclosure.text);
  tags.push(...brief.hashtags.optional);

  const seen = new Set();
  return tags.filter((tag) => {
    const key = tag.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * post.txt: the title on the first line, then the description, then the
 * hashtags on the last line, with a blank line between the three.
 *
 * @param {{ title: string, description: string, hashtags: string[] }} post
 * @returns {string}
 */
export function buildPostText({ title, description, hashtags }) {
  return `${[title, description, hashtags.join(' ')].join('\n\n')}\n`;
}

/**
 * Read post.txt back. The file may have been edited by hand since it was
 * written, so this goes by position: first line, last line, and the rest.
 *
 * @param {string} text
 * @returns {{ title: string, description: string, hashtags: string[] }}
 */
export function parsePostText(text) {
  const lines = text.replace(/\s+$/, '').split('\n');
  const title = (lines.shift() ?? '').trim();

  let hashtags = [];
  const last = (lines.at(-1) ?? '').trim().split(/\s+/).filter(Boolean);
  if (last.length > 0 && last.every((word) => word.startsWith('#'))) {
    hashtags = last;
    lines.pop();
  }
  return { title, description: lines.join('\n').trim(), hashtags };
}
