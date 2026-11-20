// The owner's list of leagues and clubs, kept in the data folder:
//
//   data/clubs.json
//
// A club is a name, a main colour and, if the owner has added one, a logo.
// Choosing a club for a match copies those three into the match, so the list
// can change later without changing matches already made.
//
// The list starts with four leagues and their clubs (see SEED below), as a
// starting point to correct, not as a record: clubs go up and down each year,
// and the colours are approximate. No logos come with it. A logo is only ever a picture the owner chose (see ICON in config.js).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { keepCopy } from '../backup.js';
import { isIcon } from './config.js';

const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const id = z.string().regex(ID, 'an id is lower-case letters, digits and dashes');
const colour = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a colour looks like #a50044');
const icon = z.string().refine((value) => value === '' || isIcon(value), 'a logo is a PNG picture of modest size').default('');

const leagueSchema = z.strictObject({ id, name: z.string().trim().min(1).max(60) });
const clubSchema = z.strictObject({
  id,
  name: z.string().trim().min(1).max(80),
  league: id,
  colour: colour.default('#5b6475'),
  icon,
});
const librarySchema = z.strictObject({
  leagues: z.array(leagueSchema).max(100).default([]),
  clubs: z.array(clubSchema).max(2000).default([]),
}).superRefine((library, ctx) => {
  const leagues = new Set(library.leagues.map((league) => league.id));
  if (leagues.size !== library.leagues.length) ctx.addIssue({ code: 'custom', path: ['leagues'], message: 'two leagues share an id' });
  const clubs = new Set();
  for (const club of library.clubs) {
    if (clubs.has(club.id)) ctx.addIssue({ code: 'custom', path: ['clubs'], message: `two clubs share the id "${club.id}"` });
    clubs.add(club.id);
    if (!leagues.has(club.league)) ctx.addIssue({ code: 'custom', path: ['clubs'], message: `"${club.name}" is in a league that does not exist` });
  }
});

/** @typedef {z.infer<typeof librarySchema>} ClubLibrary */

// A starting list: each league's clubs with one main colour. Black-and-white
// clubs are given white, since a card's background is dark.
//
// Which clubs are in La Liga and the Premier League was checked on 2026-11-20,
// at the owner's request, against the 2026-27 season. "Europe" is a league of
// the tool's own: leading clubs of Italy, France, Germany and Portugal, chosen
// by hand. "Champions League" is the 36 clubs of the 2026-27 league phase,
// from the table the owner pointed to that day. A club that is in two leagues
// is two entries; the second is written without a colour and takes the first's.
// The colours are from memory and approximate.
const SEED = {
  'La Liga': [
    ['Alavés', '#0057b8'], ['Athletic Club', '#ee2523'], ['Atlético Madrid', '#cb3524'], ['Barcelona', '#a50044'],
    ['Celta Vigo', '#8ac3ee'], ['Deportivo La Coruña', '#0a5eb0'], ['Elche', '#05642c'], ['Espanyol', '#007fc8'],
    ['Getafe', '#005999'], ['Levante', '#b4053f'], ['Málaga', '#5aa9e6'], ['Osasuna', '#d91a21'],
    ['Racing Santander', '#0b8a3c'], ['Rayo Vallecano', '#e53027'], ['Real Betis', '#00954c'], ['Real Madrid', '#ffffff'],
    ['Real Sociedad', '#0067b1'], ['Sevilla', '#d8061b'], ['Valencia', '#f18e00'], ['Villarreal', '#fbe10f'],
  ],
  'Premier League': [
    ['Arsenal', '#ef0107'], ['Aston Villa', '#670e36'], ['Bournemouth', '#da291c'], ['Brentford', '#e30613'],
    ['Brighton', '#0057b8'], ['Chelsea', '#034694'], ['Coventry City', '#6fb7e9'], ['Crystal Palace', '#1b458f'],
    ['Everton', '#003399'], ['Fulham', '#ffffff'], ['Hull City', '#f5a12d'], ['Ipswich Town', '#1f4fa3'],
    ['Leeds United', '#ffcd00'], ['Liverpool', '#c8102e'], ['Manchester City', '#6cabdd'], ['Manchester United', '#da291c'],
    ['Newcastle United', '#ffffff'], ['Nottingham Forest', '#dd0000'], ['Sunderland', '#eb172b'], ['Tottenham Hotspur', '#ffffff'],
  ],
  Europe: [
    // Italy
    ['Atalanta', '#1e71b8'], ['Como', '#003a8c'], ['Inter', '#0068a8'], ['Juventus', '#ffffff'], ['Lazio', '#87d8f7'], ['Milan', '#fb090b'],
    ['Napoli', '#12a0d7'], ['Roma', '#8e1f2f'],
    // France
    ['Lille', '#e01e13'], ['Lyon', '#da001a'], ['Marseille', '#2faee0'], ['Monaco', '#e51b22'], ['Paris Saint-Germain', '#004170'],
    // Germany
    ['Bayer Leverkusen', '#e32221'], ['Bayern Munich', '#dc052d'], ['Borussia Dortmund', '#fde100'], ['Eintracht Frankfurt', '#e1000f'], ['RB Leipzig', '#dd0741'],
    // Portugal
    ['Benfica', '#e30613'], ['Braga', '#d1001c'], ['Porto', '#00428c'], ['Sporting CP', '#008057'],
  ],
  'Champions League': [
    ['AEK Athens', '#ffd100'], ['Arsenal'], ['Aston Villa'], ['Atlético Madrid'], ['Barcelona'], ['Bayern Munich'],
    ['Bodø/Glimt', '#ffdd00'], ['Borussia Dortmund'], ['Club Brugge', '#0067b1'], ['Como'], ['Fenerbahçe', '#ffed00'], ['Feyenoord', '#e3001b'],
    ['Galatasaray', '#fdb912'], ['Inter'], ['LASK', '#ffffff'], ['Lens', '#ffd700'], ['Lille'], ['Liverpool'],
    ['Manchester City'], ['Manchester United'], ['Napoli'], ['Paris Saint-Germain'], ['Porto'], ['PSV Eindhoven', '#ed1c24'],
    ['RB Leipzig'], ['Real Betis'], ['Real Madrid'], ['Roma'], ['Sabah', '#5b6475'], ['Shakhtar Donetsk', '#f58220'],
    ['Slavia Prague', '#d7141a'], ['Slovan Bratislava', '#1d8ecf'], ['Sporting CP'], ['Stuttgart', '#e32219'], ['Viking', '#1c3f94'], ['Villarreal'],
  ],
};

/** A name as an id: "Atlético Madrid" becomes atletico-madrid. */
const slug = (text) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

/** An id made from `name` that none of `taken` has: real-madrid, then real-madrid-2. */
function freeId(name, taken) {
  const base = slug(name) || 'item';
  let free = base;
  for (let n = 2; taken.has(free); n++) free = `${base}-${n}`;
  return free;
}

/** The list a new project starts with. */
export function startingLibrary() {
  const leagues = [];
  const clubs = [];
  const taken = new Set();
  for (const [name, members] of Object.entries(SEED)) {
    const league = { id: slug(name), name };
    leagues.push(league);
    for (const [clubName, clubColour] of members) {
      const clubId = freeId(clubName, taken);
      taken.add(clubId);
      // A club listed without a colour is one already in an earlier league, and has the same colour here.
      const colour = clubColour ?? clubs.find((club) => club.name === clubName).colour;
      clubs.push({ id: clubId, name: clubName, league: league.id, colour, icon: '' });
    }
  }
  return { leagues, clubs };
}

export function parseLibrary(data) {
  const result = librarySchema.safeParse(data);
  if (!result.success) throw new Error(`The list of leagues and clubs is not valid:\n${z.prettifyError(result.error)}`);
  return result.data;
}

const libraryFile = (dataDir) => path.join(dataDir, 'clubs.json');

/**
 * The owner's leagues and clubs. The first time, the starting list is
 * written out, and from then on it is the owner's own to change.
 *
 * @returns {Promise<ClubLibrary>}
 */
export async function readLibrary(dataDir) {
  let text;
  try {
    text = await readFile(libraryFile(dataDir), 'utf8');
  } catch {
    return saveLibrary(dataDir, startingLibrary());
  }
  return parseLibrary(JSON.parse(text));
}

/** Put a whole list of leagues and clubs in place of the saved one, as a load of the owner's data does. */
export function replaceLibrary(dataDir, data) {
  return saveLibrary(dataDir, data);
}

async function saveLibrary(dataDir, data) {
  const library = parseLibrary(data);
  // Leagues keep the order they were made in. Clubs are kept by name.
  library.clubs.sort((a, b) => a.name.localeCompare(b.name));
  await mkdir(dataDir, { recursive: true });
  const text = `${JSON.stringify(library, null, 2)}\n`;
  // The list as it stood is copied first (data/backups/clubs). It holds every logo, so only a few copies are kept.
  await keepCopy(libraryFile(dataDir), text, { dataDir, name: 'clubs', keep: 5 });
  await writeFile(libraryFile(dataDir), text);
  return library;
}

/** Add a league, or rename one when `leagueId` is given. */
export async function saveLeague(dataDir, { id: leagueId, name }) {
  const library = await readLibrary(dataDir);
  if (leagueId) {
    const league = library.leagues.find((known) => known.id === leagueId);
    if (!league) throw new Error('No such league.');
    league.name = name;
  } else {
    library.leagues.push({ id: freeId(String(name ?? ''), new Set(library.leagues.map((league) => league.id))), name });
  }
  return saveLibrary(dataDir, library);
}

/** Remove a league and every club in it. */
export async function removeLeague(dataDir, leagueId) {
  const library = await readLibrary(dataDir);
  if (!library.leagues.some((league) => league.id === leagueId)) throw new Error('No such league.');
  return saveLibrary(dataDir, {
    leagues: library.leagues.filter((league) => league.id !== leagueId),
    clubs: library.clubs.filter((club) => club.league !== leagueId),
  });
}

/**
 * Add a club, or change one when `id` is given. A change may leave out
 * anything that stays as it is, so sending only a new colour is enough.
 */
export async function saveClub(dataDir, { id: clubId, ...changes }) {
  const library = await readLibrary(dataDir);
  if (clubId) {
    const at = library.clubs.findIndex((club) => club.id === clubId);
    if (at < 0) throw new Error('No such club.');
    library.clubs[at] = { ...library.clubs[at], ...changes, id: clubId };
  } else {
    library.clubs.push({ ...changes, id: freeId(String(changes.name ?? ''), new Set(library.clubs.map((club) => club.id))) });
  }
  return saveLibrary(dataDir, library);
}

export async function removeClub(dataDir, clubId) {
  const library = await readLibrary(dataDir);
  if (!library.clubs.some((club) => club.id === clubId)) throw new Error('No such club.');
  return saveLibrary(dataDir, { ...library, clubs: library.clubs.filter((club) => club.id !== clubId) });
}
