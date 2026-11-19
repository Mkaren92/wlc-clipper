import { goalType, minuteLabel, redType } from '../cards/config.js';

/**
 * The text file written next to a compilation: who to credit, and chapter
 * times for the video's description.
 *
 * @param {{ kind: 'video' | 'card', seconds: number, credit?: string, title?: string }[]} items
 *   in order, with the length each one really came out at
 * @returns {string}
 */
export function buildDescription(items) {
  // Every streamer once, in the order they first appear.
  const credits = [];
  for (const item of items) {
    const name = item.kind === 'video' ? (item.credit ?? '').trim() : '';
    if (name && !credits.some((known) => known.toLowerCase() === name.toLowerCase())) credits.push(name);
  }

  // A chapter starts at each card. Players expect the first chapter at 0:00,
  // so when the video does not open with a card, one is added there.
  const chapters = [];
  let at = 0;
  for (const item of items) {
    if (item.kind === 'card') chapters.push({ at, title: item.title || 'Card' });
    at += item.seconds;
  }
  if (chapters.length === 0 || Math.floor(chapters[0].at) > 0) chapters.unshift({ at: 0, title: 'Start' });

  const lines = ['Credits:'];
  lines.push(...(credits.length > 0 ? credits.map((name) => `- ${name}`) : ['- (no credits were entered)']));
  lines.push('', 'Chapters:', ...chapters.map((chapter) => `${chapterTime(chapter.at)} ${chapter.title}`));
  return `${lines.join('\n')}\n`;
}

/** A chapter time as players read it: 0:00, 12:34, 1:02:03. Whole seconds, rounded down. */
export function chapterTime(seconds) {
  const whole = Math.floor(seconds + 1e-6);
  const s = String(whole % 60).padStart(2, '0');
  const m = Math.floor(whole / 60) % 60;
  const h = Math.floor(whole / 3600);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * The chapter title for a card.
 *
 * @param {{ home: string, away: string }} match
 * @param {object} card
 */
export function cardTitle(match, card) {
  const score = `${match.home} ${card.homeScore}–${card.awayScore} ${match.away}`;
  const minute = minuteLabel(card.minute, card.added);
  if (card.type === 'goal') {
    const type = goalType(card.goalType);
    const note = type.id === 'penalty' ? ' (pen)' : type.id === 'own-goal' ? ' (og)' : '';
    return `${minute} Goal: ${card.scorer || 'Unknown'}${note} (${score})`.trim();
  }
  if (card.type === 'red') return `${minute} Red card: ${card.player || 'Unknown'} (${redType(card.redType).label.toLowerCase()})`.trim();
  return `Full time: ${score}`;
}
