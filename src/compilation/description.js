// The text that goes under a compilation where it is posted: chapter times, the
// fan channels in the video, where the goal footage came from, a call to action,
// hashtags. Parts of it are worked out (the chapters, the channels, ideas for
// hashtags and titles) and parts are the owner's standing text, kept with the
// compilation (`post` in its timeline).
//
// Nothing here reads a file or the network, so the Compilations page uses the
// same functions to show the text as the engine uses to write description.txt.
import { minuteLabel, redType } from '../cards/config.js';

/** The longest title YouTube takes. */
export const MAX_TITLE = 100;
/** YouTube ignores every hashtag of a video that has more than this many. */
export const MAX_HASHTAGS = 60;
/** The longest description YouTube takes, counted in bytes: an emoji or a letter outside the Latin alphabet is more than one. */
export const MAX_DESCRIPTION_BYTES = 5000;
/** How many characters YouTube takes in a video's tags, the commas between them counted. */
export const MAX_TAGS_LENGTH = 500;
/** YouTube shows chapters only for at least this many, each at least this long. */
export const MIN_CHAPTERS = 3;
export const MIN_CHAPTER_SECONDS = 10;

/**
 * The owner's own text for a video's page, as a new compilation starts with it. The standing
 * sentences are neutral ones written for this tool; the owner makes them theirs once, and a
 * new compilation then starts from the last one's.
 *
 * @typedef {{ title: string, fanText: string, footageText: string, footage: string, callToAction: string, keywords: string, hashtags: string, music: string, tags: string }} Post
 */
export const DEFAULT_POST = {
  title: '',
  fanText: 'These are the fan channels in this video. Go and subscribe to them!',
  footageText: 'The goal footage is credited to the sources I could find. If any of it is yours, tell me and I will put the credit right.',
  footage: '',
  callToAction: 'Like the video and subscribe for more!',
  keywords: '',
  hashtags: '',
  music: '',
  // For the "Tags" box of the upload form, not for the description.
  tags: '',
};
/** The parts of the owner's text that stay the same from video to video. */
export const STANDING_POST = ['fanText', 'footageText', 'callToAction', 'keywords', 'music'];

const RULE = '----------------';

/**
 * A team as a chapter names it: the short name the owner gave it for the match (GER), or its
 * full name. No short name is ever guessed: a wrong one would go public.
 */
export function teamShort(match, side) {
  return (match.short?.[side] ?? '').trim() || (side === 'away' ? match.away : match.home) || (side === 'away' ? 'Away' : 'Home');
}

/**
 * The chapter title for a card: "GER 1-0 NED" for a goal, with the teams' short names when the
 * match has them.
 *
 * @param {{ home: string, away: string, short?: { home: string, away: string } }} match
 * @param {object} card
 */
export function cardTitle(match, card) {
  const score = `${teamShort(match, 'home')} ${card.homeScore ?? 0}-${card.awayScore ?? 0} ${teamShort(match, 'away')}`;
  if (card.type === 'goal') return score;
  if (card.type === 'red') {
    const minute = minuteLabel(card.minute, card.added);
    return `RED CARD ${card.player || 'Unknown'} (${teamShort(match, card.team)}${minute ? `, ${minute}` : ''}, ${redType(card.redType).label.toLowerCase()})`;
  }
  return `FULL TIME ${score}`;
}

/** A chapter time as YouTube's own examples write it: 00:00, 12:34, 1:02:03. Whole seconds, rounded down. */
export function chapterTime(seconds) {
  const whole = Math.floor(seconds + 1e-6);
  const s = String(whole % 60).padStart(2, '0');
  const m = String(Math.floor(whole / 60) % 60).padStart(2, '0');
  const h = Math.floor(whole / 3600);
  return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
}

/**
 * Where each chapter starts. A chapter starts at each card. YouTube wants the first one at
 * 00:00, so when the video does not open with a card, one named "START" is added there.
 *
 * @param {{ kind: 'video' | 'card', seconds: number, title?: string }[]} items  in order, with the length each really came out at
 * @returns {{ at: number, title: string, seconds: number }[]} `seconds` is how long the chapter lasts
 */
export function chaptersOf(items) {
  const chapters = [];
  let at = 0;
  for (const item of items) {
    if (item.kind === 'card') chapters.push({ at, title: item.title || 'Card' });
    at += item.seconds;
  }
  if (chapters.length === 0 || Math.floor(chapters[0].at) > 0) chapters.unshift({ at: 0, title: 'START' });
  return chapters.map((chapter, i) => ({ ...chapter, seconds: (chapters[i + 1]?.at ?? at) - chapter.at }));
}

/**
 * Why YouTube would not show these chapters, in plain words, or '' when it would.
 * Its rules: the first at 00:00, at least three, each ten seconds or longer.
 */
export function chapterProblem(chapters) {
  if (chapters.length < MIN_CHAPTERS) return `YouTube shows chapters only when there are at least ${MIN_CHAPTERS}; this video has ${chapters.length}.`;
  const short = chapters.find((chapter) => chapter.seconds < MIN_CHAPTER_SECONDS - 0.01);
  if (short) return `YouTube shows chapters only when each lasts at least ${MIN_CHAPTER_SECONDS} seconds; "${short.title}" lasts ${Math.max(0, Math.round(short.seconds))}.`;
  return '';
}

/** Every credited streamer once, in the order they first appear. */
export function creditsOf(items) {
  const credits = [];
  for (const item of items) {
    const name = item.kind === 'video' ? (item.credit ?? '').trim() : '';
    if (name && !credits.some((known) => known.toLowerCase() === name.toLowerCase())) credits.push(name);
  }
  return credits;
}

/** The lines of a typed box that have something in them. */
const linesOf = (text) => String(text ?? '').split('\n').map((line) => line.trim()).filter(Boolean);

/**
 * The whole text for under the video. A part with nothing in it is left out, with its heading.
 *
 * @param {{ kind: 'video' | 'card', seconds: number, credit?: string, title?: string }[]} items
 *   in order, with the length each one really came out at; none yet, before the video was first made
 * @param {Record<string, string>} [links]   a channel's address for a credited name, by the name in lower case
 * @param {Partial<Post>} [post]             the owner's own text
 * @param {string[]} [credits]               the streamers to list, when they are not to be taken from `items`:
 *   the page gives the timeline's own, so the list is right before the video is made and after it changes
 * @returns {string}
 */
export function buildDescription(items, links = {}, post = {}, credits = creditsOf(items)) {
  const own = { ...DEFAULT_POST, ...post };
  const parts = [];

  if (items.length > 0) parts.push(['TIMESTAMP', ...chaptersOf(items).map((chapter) => `${chapterTime(chapter.at)} ${chapter.title}`)]);

  // A channel is written as its address, which YouTube shows as the channel's name; a credit
  // that is not a channel in the sources list goes by its name alone.
  if (credits.length > 0) {
    parts.push(['FAN CHANNELS IN THE VIDEO 🎥', ...linesOf(own.fanText), '', ...credits.map((name) => links[name.toLowerCase()] ?? name)]);
  }

  const footage = linesOf(own.footage);
  if (footage.length > 0) parts.push(['SOURCE GOAL FOOTAGE 🎥', ...linesOf(own.footageText), '', ...footage]);

  const call = [...linesOf(own.callToAction), ...linesOf(own.title)];
  if (call.length > 0) parts.push(call);

  const last = [linesOf(own.keywords), linesOf(own.hashtags), linesOf(own.music)].filter((lines) => lines.length > 0);
  if (last.length > 0) parts.push(last.flatMap((lines, i) => (i === 0 ? lines : ['', ...lines])));

  return parts.length > 0 ? `${parts.map((lines) => lines.join('\n')).join(`\n\n${RULE}\n`)}\n` : '';
}

/** How many hashtags a text holds. */
export function countHashtags(text) {
  return (String(text ?? '').match(/#[\p{L}\p{N}_]+/gu) ?? []).length;
}

/** A word or a name as a hashtag: its letters and digits run together, each word with a capital. */
function hashtag(text) {
  const words = String(text ?? '').normalize('NFC').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.length > 0 ? `#${words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('')}` : '';
}

/**
 * Hashtags worked out from a match, for the owner to change: the two clubs, the competition,
 * the fixture, and a few about fans reacting. YouTube shows up to three of a video's hashtags
 * by its title, so the clubs and the competition come first.
 *
 * @param {{ home: string, away: string, competition?: string }} match
 * @returns {string}
 */
export function suggestHashtags(match) {
  const tags = [
    hashtag(match.home), hashtag(match.away), hashtag(match.competition),
    match.home && match.away ? `${hashtag(match.home)}Vs${hashtag(match.away).slice(1)}` : '',
    '#FanReactions', '#FootballFans', '#MatchReactions', '#Football',
    match.home ? `${hashtag(match.home)}Fans` : '', match.away ? `${hashtag(match.away)}Fans` : '',
  ].filter(Boolean);
  return [...new Set(tags)].join(' ');
}

/** The tags in a typed box: split at commas and line ends, each once whatever its capitals. */
export function tagsOf(text) {
  const seen = new Set();
  return String(text ?? '').split(/[,\n]/).map((tag) => tag.trim()).filter((tag) => tag && !seen.has(tag.toLowerCase()) && seen.add(tag.toLowerCase()));
}

/**
 * Tags for the "Tags" box of YouTube's upload form, worked out from the match for the owner to
 * change: what somebody might type to find the video. The fixture both ways round, each club
 * with "fans" and "reaction", the competition, the score, the streamers in the video, then a
 * few general ones. They are plain words in lower case, the most telling first, and the list
 * stops before it would pass YouTube's limit.
 *
 * @param {{ home: string, away: string, competition?: string }} match
 * @param {{ home: number, away: number } | null} score
 * @param {string[]} [streamers]  the channels credited in the video
 * @returns {string[]}
 */
export function suggestTags(match, score, streamers = []) {
  const plain = (text) => String(text ?? '').normalize('NFC').replace(/[,<>"]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  const [home, away, competition] = [plain(match.home), plain(match.away), plain(match.competition)];
  const both = home && away;
  const tags = [
    both && `${home} vs ${away}`, both && `${away} vs ${home}`,
    both && score && `${home} ${score.home}-${score.away} ${away}`,
    both && `${home} ${away} fan reactions`,
    home && `${home} fans`, away && `${away} fans`,
    home && `${home} fan reactions`, away && `${away} fan reactions`,
    home && `${home} reaction`, away && `${away} reaction`,
    home, away, competition, competition && `${competition} reactions`,
    'fan reactions', 'football fans react', 'match reactions', 'watchalong', 'watchalong reactions', 'goal reactions', 'football',
    ...streamers.map(plain),
  ].filter(Boolean);
  const kept = [];
  let length = 0;
  for (const tag of tagsOf(tags.join(','))) {
    // YouTube counts the commas between tags, and two more characters for a tag with a space in it.
    const cost = tag.length + (tag.includes(' ') ? 2 : 0) + (kept.length > 0 ? 1 : 0);
    if (length + cost > MAX_TAGS_LENGTH) break;
    kept.push(tag);
    length += cost;
  }
  return kept;
}

/** How much of YouTube's room for tags a typed box takes: the commas counted, and two more for each tag with a space in it. */
export function tagsLength(text) {
  const tags = tagsOf(text);
  return tags.reduce((sum, tag) => sum + tag.length + (tag.includes(' ') ? 2 : 0), 0) + Math.max(0, tags.length - 1);
}

/**
 * Ideas for the video's title, worked out from the match and true to its score: nobody is
 * "humiliated" by a draw or a one-goal game. They are starting points in the shape such videos
 * often have (who reacts, to what, the score, then what kind of video it is); the owner picks
 * one and makes it theirs. Nothing is sent anywhere to make them.
 *
 * @param {{ home: string, away: string }} match
 * @param {{ home: number, away: number } | null} score  the match's score, or null when it has none yet
 * @returns {string[]}
 */
export function titleIdeas(match, score) {
  const home = (match.home || 'Home').toUpperCase();
  const away = (match.away || 'Away').toUpperCase();
  if (!score) return [`${home} v ${away} 🔥 FANS REACT LIVE | MATCH REACTIONS`, `${home} vs ${away}: EVERY FAN REACTION | WATCHALONG REACTIONS`];
  const line = `${match.home || 'Home'} ${score.home}-${score.away} ${match.away || 'Away'}`;
  if (score.home === score.away) {
    const goals = score.home > 0;
    return [
      `${goals ? 'WHAT A GAME' : 'NOTHING BETWEEN THEM'} 😱 FANS REACT TO ${home} ${score.home}-${score.away} ${away} | MATCH REACTIONS`,
      `${home} AND ${away} FANS CAN'T BELIEVE IT 😳 ${line} | FAN REACTIONS`,
      `POINTS SHARED! ${home} & ${away} FANS REACT | ${line}`,
      `${line}: EVERY FAN REACTION${goals ? ' TO EVERY GOAL' : ''} | WATCHALONG REACTIONS`,
    ];
  }
  const [winner, loser, won, lost] = score.home > score.away ? [home, away, score.home, score.away] : [away, home, score.away, score.home];
  const margin = won - lost;
  const ideas = [];
  if (margin >= 3) {
    ideas.push(`${loser} FANS SHOCKED 😮 FANS REACT TO ${won}-${lost} THRASHING BY ${winner} | MATCH REACTIONS`);
    ideas.push(`${winner} DESTROY ${loser} ${won}-${lost} 🔥 FANS LOSE THEIR HEADS | FAN REACTIONS`);
  } else if (margin === 1) {
    ideas.push(`${winner} EDGE IT ${won}-${lost} 😱 ${loser} FANS HEARTBROKEN | MATCH REACTIONS`);
    ideas.push(`${loser} FANS GUTTED 💔 FANS REACT TO ${line} | FAN REACTIONS`);
  } else {
    ideas.push(`${winner} FANS GO WILD 🔥 FANS REACT TO ${won}-${lost} WIN OVER ${loser} | MATCH REACTIONS`);
    ideas.push(`${loser} FANS FURIOUS 😡 FANS REACT TO ${line} | FAN REACTIONS`);
  }
  ideas.push(`${winner} FANS vs ${loser} FANS 😂 EVERY REACTION | ${line}`);
  ideas.push(`${line}: EVERY FAN REACTION TO EVERY GOAL | WATCHALONG REACTIONS`);
  return ideas;
}
