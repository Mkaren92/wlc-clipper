// The clubs list as it is kept on GitHub: the same list, with each logo in a
// file of its own.
//
// On this machine a club's logo is written into the list itself, as text
// (see ICON in src/cards/config.js), which makes the list about 11 MB. Kept
// that way on GitHub, every change to any club would store the whole 11 MB
// again. So on the way out each logo becomes `data/club-logos/<hash>.png`
// and the list names it; on the way in the logos are written back into the
// list. A club that is in two leagues has one logo file.
import { createHash } from 'node:crypto';

const PNG = 'data:image/png;base64,';
const NAMED = /^file:([0-9a-f]{32})\.png$/;
export const LOGO_DIR = 'data/club-logos';

/**
 * @param {string} text   the clubs list as saved on this machine
 * @returns {{ text: string, logos: Map<string, Buffer> }} the list for GitHub, and its logo files by name
 */
export function splitLogos(text) {
  const library = JSON.parse(text);
  const logos = new Map();
  for (const club of library.clubs ?? []) {
    if (typeof club.icon !== 'string' || !club.icon.startsWith(PNG)) continue;
    const bytes = Buffer.from(club.icon.slice(PNG.length), 'base64');
    const name = `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.png`;
    logos.set(name, bytes);
    club.icon = `file:${name}`;
  }
  return { text: `${JSON.stringify(library, null, 2)}\n`, logos };
}

/**
 * @param {string} text   the clubs list as kept on GitHub
 * @param {(name: string) => Promise<Buffer | null>} logo   reads one logo file, or answers null when it is missing
 * @returns {Promise<string>} the list as this machine saves it; refuses when a named logo is missing
 */
export async function joinLogos(text, logo) {
  const library = JSON.parse(text);
  for (const club of library.clubs ?? []) {
    const named = NAMED.exec(club.icon ?? '');
    if (!named) continue;
    const bytes = await logo(`${named[1]}.png`);
    // A logo that did not arrive must not quietly become "no logo": that would then be sent back as the truth.
    if (!bytes) throw new Error(`The logo of ${club.name} is missing from the data repository. Nothing was changed here.`);
    club.icon = `${PNG}${bytes.toString('base64')}`;
  }
  return `${JSON.stringify(library, null, 2)}\n`;
}
