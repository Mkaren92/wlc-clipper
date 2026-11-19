// A match and its cards, saved as JSON in the data folder:
//
//   data/matches/<match id>/match.json
//   data/matches/<match id>/cards/<card id>-landscape.png   (and -portrait.png)
//
// The PNG files are made in the browser from the same SVG as the preview and
// sent here when a match is saved. The compilation builder reads them.
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { CARD_SIZES, GOAL_TYPES, goalType, minuteLabel, RED_TYPES } from './config.js';

const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const id = z.string().regex(ID, 'an id is lower-case letters, digits and dashes');
const name = z.string().trim().max(80);
const colour = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a colour looks like #a50044');
const minute = z.number().int().min(0).max(200).nullable();
const added = z.number().int().min(0).max(60).nullable();
const score = z.number().int().min(0).max(99);
const side = z.enum(['home', 'away']);

const goalCard = z.strictObject({
  id, type: z.literal('goal'), team: side, scorer: name, assist: name.default(''),
  minute, added: added.default(null),
  goalType: z.enum(GOAL_TYPES.map((type) => type.id)),
  homeScore: score, awayScore: score,
});
const redCard = z.strictObject({
  id, type: z.literal('red'), team: side, player: name, minute, added: added.default(null),
  redType: z.enum(RED_TYPES.map((type) => type.id)),
  showScore: z.boolean().default(false), homeScore: score.default(0), awayScore: score.default(0),
});
const fullTimeCard = z.strictObject({
  id, type: z.literal('fulltime'), homeScore: score, awayScore: score,
  homeScorers: z.array(name).max(12).default([]), awayScorers: z.array(name).max(12).default([]),
});

export const matchSchema = z.strictObject({
  id,
  home: name,
  away: name,
  competition: name.default(''),
  date: name.default(''),
  colours: z.strictObject({ home: colour, away: colour }),
  cards: z.array(z.discriminatedUnion('type', [goalCard, redCard, fullTimeCard])).max(100).default([]),
}).superRefine((match, ctx) => {
  const seen = new Set();
  for (const card of match.cards) {
    if (seen.has(card.id)) ctx.addIssue({ code: 'custom', path: ['cards'], message: `two cards share the id "${card.id}"` });
    seen.add(card.id);
  }
});

/** @typedef {z.infer<typeof matchSchema>} Match */

export function parseMatch(data) {
  const result = matchSchema.safeParse(data);
  if (!result.success) throw new Error(`The match is not valid:\n${z.prettifyError(result.error)}`);
  return result.data;
}

export const isId = (value) => typeof value === 'string' && ID.test(value);
export const isCardSize = (value) => Object.hasOwn(CARD_SIZES, value);

const matchDir = (dataDir, matchId) => path.join(dataDir, 'matches', matchId);
/** Where a card's picture is kept. */
export const cardPngPath = (dataDir, matchId, cardId, size) => path.join(matchDir(dataDir, matchId), 'cards', `${cardId}-${size}.png`);

/** Every saved match, newest name first is not needed: sorted by team names. */
export async function listMatches(dataDir) {
  const ids = (await readdir(path.join(dataDir, 'matches')).catch(() => [])).filter(isId);
  const matches = await Promise.all(ids.map((matchId) => readMatch(dataDir, matchId).catch(() => null)));
  return matches.filter(Boolean).sort((a, b) => `${a.home} ${a.away}`.localeCompare(`${b.home} ${b.away}`));
}

export async function readMatch(dataDir, matchId) {
  if (!isId(matchId)) throw new Error('No such match.');
  let text;
  try {
    text = await readFile(path.join(matchDir(dataDir, matchId), 'match.json'), 'utf8');
  } catch {
    throw new Error('No such match.');
  }
  return parseMatch(JSON.parse(text));
}

/**
 * Save a match with its cards. Pictures of cards that are no longer in the
 * match are removed.
 *
 * @returns {Promise<Match>}
 */
export async function saveMatch(dataDir, data) {
  const match = parseMatch(data);
  const dir = matchDir(dataDir, match.id);
  await mkdir(path.join(dir, 'cards'), { recursive: true });
  await writeFile(path.join(dir, 'match.json'), `${JSON.stringify(match, null, 2)}\n`);
  const kept = new Set(match.cards.flatMap((card) => Object.keys(CARD_SIZES).map((size) => `${card.id}-${size}.png`)));
  for (const file of await readdir(path.join(dir, 'cards'))) {
    if (!kept.has(file)) await rm(path.join(dir, 'cards', file), { force: true });
  }
  return match;
}

export async function deleteMatch(dataDir, matchId) {
  await readMatch(dataDir, matchId); // throws unless it is a saved match
  await rm(matchDir(dataDir, matchId), { recursive: true });
}

/**
 * Save a card's picture. It must be a PNG of exactly the size it claims.
 *
 * @param {Buffer} png
 */
export async function saveCardPng(dataDir, matchId, cardId, size, png) {
  const match = await readMatch(dataDir, matchId);
  if (!match.cards.some((card) => card.id === cardId)) throw new Error('No such card in this match.');
  if (!isCardSize(size)) throw new Error('A card is "landscape" or "portrait".');
  const { width, height } = CARD_SIZES[size];
  const isPng = png.length > 24 && png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  // A PNG states its width and height right after its first header.
  if (!isPng || png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== height) {
    throw new Error(`The ${size} picture must be a PNG of ${width}x${height}.`);
  }
  const file = cardPngPath(dataDir, matchId, cardId, size);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, png);
}

/** A free id for a new match, from the team names: barcelona-vs-real-madrid, then -2. */
export async function newMatchId(dataDir, home, away) {
  const slug = (text) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const base = ([slug(home), slug(away)].filter(Boolean).join('-vs-') || 'match').slice(0, 60).replace(/-+$/, '');
  const taken = await readdir(path.join(dataDir, 'matches')).catch(() => []);
  let free = base;
  for (let n = 2; taken.includes(free); n++) free = `${base}-${n}`;
  return free;
}

/**
 * The scorer lines for a full-time card, worked out from the match's goal
 * cards: one line per scorer with all their minutes, in the order they
 * first scored. An own goal is listed for the team that was given the goal.
 *
 * @param {{ cards: object[] }} match
 * @returns {{ homeScorers: string[], awayScorers: string[], homeScore: number, awayScore: number }}
 */
export function scorersFromGoals(match) {
  const goals = match.cards
    .filter((card) => card.type === 'goal')
    .sort((a, b) => (a.minute ?? 0) - (b.minute ?? 0) || (a.added ?? 0) - (b.added ?? 0));
  const lines = { home: new Map(), away: new Map() };
  for (const goal of goals) {
    const type = goalType(goal.goalType);
    const note = type.id === 'penalty' ? ' (pen)' : type.id === 'own-goal' ? ' (og)' : '';
    const scorer = goal.scorer || 'Unknown';
    const minutes = lines[goal.team].get(scorer) ?? [];
    minutes.push(`${minuteLabel(goal.minute, goal.added)}${note}`.trim());
    lines[goal.team].set(scorer, minutes);
  }
  const write = (map) => [...map].map(([scorer, minutes]) => `${scorer} ${minutes.filter(Boolean).join(', ')}`.trim());
  const last = goals.at(-1);
  return {
    homeScorers: write(lines.home),
    awayScorers: write(lines.away),
    homeScore: last?.homeScore ?? 0,
    awayScore: last?.awayScore ?? 0,
  };
}
