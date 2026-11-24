// The cards themselves. One function per kind of card, each returning an SVG
// picture as text. The page shows that SVG as the preview and turns the very
// same SVG into the PNG, so the two cannot differ.
//
// Text and plain blocks of team colour, with one exception: the intro card
// shows a club icon for each team when the owner has added one to the match.
// Nothing here fetches a picture; an icon is only ever what the owner chose.
import { CARD_SIZES, goalType, isIcon, minuteLabel, redType } from './config.js';
import { fitSize, textWidth } from './measure.js';

/** Name the page and the PNG export give the bundled font. */
export const CARD_FONT = 'Clipper Card';

const BACKGROUND = '#12151b';
const PANEL = '#1c212b';
const TEXT = '#f4f5f7';
const MUTED = '#a7afbd';
const RED = '#d0202f';
// The end of the one rectangle that fills a card. renderCard swaps it for a see-through one.
const SOLID_BACKGROUND = `fill="${BACKGROUND}"/>`;

// How much of the card's dark background stays when a video plays behind it:
// enough to keep the words readable, little enough to see the video.
const SEE_THROUGH = 0.45;
// How dark the plate behind the intro card's score is. With the see-through background over it,
// about a fifth of the video still shows through there.
const PLATE = 0.7;

/**
 * Draw any card.
 *
 * @param {{ match: object, card: object, size: 'landscape' | 'portrait', clear?: boolean }} options
 *   `clear` draws the card to lie over a video: its background is see-through,
 *   the intro card's score (or "V") stands on a dark plate, and everything else is the same.
 * @returns {string} SVG
 */
export function renderCard({ match, card, size, clear = false }) {
  const draw = { intro: introCard, goal: goalCard, red: redCard, fulltime: fullTimeCard }[card.type];
  if (!draw) throw new Error(`Unknown kind of card: ${card.type}`);
  const svg = draw({ match, card, size, clear });
  return clear ? svg.replace(SOLID_BACKGROUND, `fill="${BACKGROUND}" fill-opacity="${SEE_THROUGH}"/>`) : svg;
}

/** The opening card: the two clubs, each with its icon and name, and "V" or the score between them. */
export function introCard({ match, card, size, clear = false }) {
  const c = canvas(size);
  const middle = card.showScore ? `${card.homeScore ?? 0} – ${card.awayScore ?? 0}` : 'V';
  const parts = [header(c, match)];
  const sides = c.portrait
    ? [{ side: 'home', x: c.w / 2, y: c.introHomeY }, { side: 'away', x: c.w / 2, y: c.introAwayY }]
    : [{ side: 'home', x: c.w / 2 - c.introSpread, y: c.introY }, { side: 'away', x: c.w / 2 + c.introSpread, y: c.introY }];
  for (const { side, x, y } of sides) {
    parts.push(icon(c, match, side, { x, y, size: c.introIcon }));
    parts.push(team(c, match, side, { x, y: y + c.introIcon / 2 + c.teamSize * 1.25, anchor: 'middle', width: c.introNameWidth }));
  }
  const middleSize = fitSize(middle, card.showScore ? c.scoreSize : c.scoreSize * 0.8, c.introMiddleWidth);
  // Over a video the middle gets a dark plate. The ordinary card is drawn exactly as before.
  if (clear) parts.push(plate(c, { x: c.w / 2, y: c.introMiddleY, width: textWidth(middle, middleSize), size: middleSize }));
  parts.push(text(middle, { x: c.w / 2, y: c.introMiddleY, anchor: 'middle', fill: card.showScore ? TEXT : MUTED, size: middleSize }));
  return frame(c, parts);
}

/**
 * A dark plate behind a line of text whose baseline is at `y`, so the text reads whatever a
 * video behind the card shows there (asked for on 2026-11-24: a white score over a white ball).
 * Only the card that lies over a video has one.
 */
function plate(c, { x, y, width, size }) {
  const pad = size * 0.3;
  const top = y - size * 0.72 - pad; // digits and capitals stand 0.72 of the font size above the baseline
  return `<rect x="${round(x - width / 2 - pad * 1.4)}" y="${round(top)}" width="${round(width + pad * 2.8)}" height="${round(size * 0.72 + pad * 2)}" rx="${round(28 * c.u)}" fill-opacity="${PLATE}" fill="${BACKGROUND}"></rect>`;
}

export function goalCard({ match, card, size }) {
  const c = canvas(size);
  const type = goalType(card.goalType);
  const colour = match.colours[card.team];
  const ownGoal = type.id === 'own-goal';
  const details = [type.label];
  if (type.assist && card.assist) details.push(`Assist: ${card.assist}`);

  return frame(c, [
    header(c, match),
    banner(c, { colour, title: ownGoal ? 'OWN GOAL' : 'GOAL', minute: minuteLabel(card.minute, card.added) }),
    line(c, card.scorer, { y: c.nameY, size: c.nameSize, fill: TEXT }),
    line(c, details.join('  ·  '), { y: c.detailY, size: c.detailSize, fill: MUTED }),
    scoreboard(c, match, { home: card.homeScore, away: card.awayScore, lit: card.team }),
  ]);
}

export function redCard({ match, card, size }) {
  const c = canvas(size);
  const details = [teamName(match, card.team), redType(card.redType).label];
  const parts = [
    header(c, match),
    banner(c, { colour: RED, title: 'RED CARD', minute: minuteLabel(card.minute, card.added) }),
    line(c, card.player, { y: c.nameY, size: c.nameSize, fill: TEXT }),
    line(c, details.join('  ·  '), { y: c.detailY, size: c.detailSize, fill: MUTED }),
  ];
  if (card.showScore) parts.push(scoreboard(c, match, { home: card.homeScore, away: card.awayScore }));
  return frame(c, parts);
}

export function fullTimeCard({ match, card, size }) {
  const c = canvas(size);
  const parts = [
    header(c, match),
    banner(c, { colour: PANEL, title: 'FULL TIME', minute: '' }),
    scoreboard(c, match, { home: card.homeScore, away: card.awayScore, y: c.fullTimeScoreY }),
  ];
  // Scorers: home on the left, away on the right; stacked in the tall card.
  const columns = c.portrait
    ? [{ team: 'home', x: c.w / 2, anchor: 'middle', y: c.scorersY }, { team: 'away', x: c.w / 2, anchor: 'middle', y: c.scorersY + c.scorersGap }]
    : [{ team: 'home', x: c.w / 2 - c.gutter, anchor: 'end', y: c.scorersY }, { team: 'away', x: c.w / 2 + c.gutter, anchor: 'start', y: c.scorersY }];
  for (const column of columns) {
    const lines = (column.team === 'home' ? card.homeScorers : card.awayScorers) ?? [];
    const width = c.portrait ? c.w - 2 * c.margin : c.w / 2 - c.gutter - c.margin;
    // Stacked lists need a label each, or nobody can tell whose scorers they are.
    if (c.portrait && lines.length > 0) {
      parts.push(line(c, teamName(match, column.team).toUpperCase(), { y: column.y - c.scorerStep, size: c.scorerSize * 0.8, fill: TEXT }));
    }
    lines.slice(0, c.maxScorers).forEach((text, i) => {
      parts.push(line(c, text, { x: column.x, anchor: column.anchor, y: column.y + i * c.scorerStep, size: c.scorerSize, fill: MUTED, maxWidth: width }));
    });
  }
  return frame(c, parts);
}

// --- Layout -------------------------------------------------------------------

/** Sizes and positions for one of the two card shapes, in pixels. */
function canvas(size) {
  const { width: w, height: h } = CARD_SIZES[size] ?? CARD_SIZES.landscape;
  const portrait = h > w;
  // One unit is a pixel on the 1920-wide card; the tall card scales its text to its 1080 width.
  const u = portrait ? w / 1080 : w / 1920;
  const margin = 90 * u;
  return portrait
    ? {
        w, h, u, portrait, margin, gutter: 0,
        headerY: 150 * u, headerSize: 44 * u,
        bannerY: 290 * u, bannerH: 300 * u, titleSize: 170 * u, minuteSize: 110 * u,
        nameY: 950 * u, nameSize: 120 * u, detailY: 1060 * u, detailSize: 52 * u,
        scoreY: 1560 * u, fullTimeScoreY: 1000 * u, scoreSize: 230 * u, teamSize: 76 * u, barH: 16 * u,
        scorersY: 1360 * u, scorersGap: 290 * u, scorerStep: 68 * u, scorerSize: 52 * u, maxScorers: 3,
        introIcon: 400 * u, introHomeY: 430 * u, introAwayY: 1340 * u, introMiddleY: 1040 * u,
        introNameWidth: w - 2 * margin, introMiddleWidth: w - 2 * margin, introSpread: 0,
      }
    : {
        w, h, u, portrait, margin, gutter: 150 * u,
        headerY: 110 * u, headerSize: 38 * u,
        bannerY: 170 * u, bannerH: 250 * u, titleSize: 170 * u, minuteSize: 120 * u,
        nameY: 590 * u, nameSize: 130 * u, detailY: 690 * u, detailSize: 52 * u,
        scoreY: 940 * u, fullTimeScoreY: 660 * u, scoreSize: 170 * u, teamSize: 76 * u, barH: 14 * u,
        scorersY: 800 * u, scorersGap: 0, scorerStep: 62 * u, scorerSize: 46 * u, maxScorers: 4,
        introIcon: 400 * u, introY: 480 * u, introMiddleY: 540 * u, introSpread: 560 * u,
        introNameWidth: 700 * u, introMiddleWidth: 420 * u,
      };
}

function frame(c, parts) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${c.w} ${c.h}" width="${c.w}" height="${c.h}" font-family="'${CARD_FONT}', 'Liberation Sans', Arial, sans-serif" font-weight="bold">`,
    `<rect width="${c.w}" height="${c.h}" ${SOLID_BACKGROUND}`,
    ...parts.filter(Boolean),
    '</svg>',
  ].join('');
}

/** Competition and date, small, at the top. */
function header(c, match) {
  const text = [match.competition, match.date].filter(Boolean).join('  ·  ');
  return text ? line(c, text.toUpperCase(), { y: c.headerY, size: c.headerSize, fill: MUTED }) : '';
}

/** A full-width block of colour with the card's title, and the minute beside it. */
function banner(c, { colour, title, minute }) {
  const fill = safeColour(colour);
  const ink = readableOn(fill);
  const baseline = c.bannerY + c.bannerH / 2 + c.titleSize * 0.36;
  const parts = [`<rect x="0" y="${c.bannerY}" width="${c.w}" height="${c.bannerH}" fill="${fill}"/>`];
  if (c.portrait || !minute) {
    parts.push(text(title, { x: c.w / 2, y: baseline, size: fitSize(title, c.titleSize, c.w - 2 * c.margin), anchor: 'middle', fill: ink }));
    // In the tall card the minute sits under the block instead of beside the title.
    if (minute) parts.push(text(minute, { x: c.w / 2, y: c.bannerY + c.bannerH + c.minuteSize * 1.15, size: c.minuteSize, anchor: 'middle', fill: TEXT }));
  } else {
    parts.push(text(title, { x: c.margin, y: baseline, size: c.titleSize, anchor: 'start', fill: ink }));
    parts.push(text(minute, { x: c.w - c.margin, y: baseline, size: c.minuteSize, anchor: 'end', fill: ink }));
  }
  return parts.join('');
}

/** The two team names with their colours, and the score between them. */
function scoreboard(c, match, { home, away, lit, y = c.scoreY }) {
  const score = `${home ?? 0} – ${away ?? 0}`;
  const parts = [];
  if (c.portrait) {
    const nameWidth = c.w - 2 * c.margin;
    parts.push(team(c, match, 'home', { x: c.w / 2, y: y - c.scoreSize * 1.05, anchor: 'middle', width: nameWidth, lit }));
    parts.push(text(score, { x: c.w / 2, y, size: c.scoreSize, anchor: 'middle', fill: TEXT }));
    parts.push(team(c, match, 'away', { x: c.w / 2, y: y + c.teamSize * 1.7, anchor: 'middle', width: nameWidth, lit }));
  } else {
    // Room kept clear for the score in the middle, however many digits it has.
    const half = textWidth(score, c.scoreSize) / 2 + 60 * c.u;
    const nameWidth = c.w / 2 - half - c.margin;
    parts.push(team(c, match, 'home', { x: c.w / 2 - half, y: y - c.scoreSize * 0.15, anchor: 'end', width: nameWidth, lit }));
    parts.push(text(score, { x: c.w / 2, y, size: c.scoreSize, anchor: 'middle', fill: TEXT }));
    parts.push(team(c, match, 'away', { x: c.w / 2 + half, y: y - c.scoreSize * 0.15, anchor: 'start', width: nameWidth, lit }));
  }
  return parts.join('');
}

/** A team name with a bar of its colour under it. The other team is dimmed when one is `lit`. */
function team(c, match, side, { x, y, anchor, width, lit }) {
  const name = teamName(match, side).toUpperCase();
  const size = fitSize(name, c.teamSize, width);
  const barWidth = Math.min(width, Math.max(120 * c.u, textWidth(name, size)));
  const barX = anchor === 'end' ? x - barWidth : anchor === 'middle' ? x - barWidth / 2 : x;
  const fill = lit && lit !== side ? MUTED : TEXT;
  return [
    text(name, { x, y, size, anchor, fill }),
    `<rect x="${round(barX)}" y="${round(y + size * 0.28)}" width="${round(barWidth)}" height="${round(c.barH)}" fill="${safeColour(match.colours[side])}"/>`,
  ].join('');
}

/**
 * A team's icon in a square of `size` centred on x, y. Without an icon, a
 * disc of the team's colour with the first letter of its name stands in, so
 * the card is whole either way.
 */
function icon(c, match, side, { x, y, size }) {
  const picture = match.icons?.[side];
  if (isIcon(picture)) {
    return `<image href="${picture}" x="${round(x - size / 2)}" y="${round(y - size / 2)}" width="${round(size)}" height="${round(size)}" preserveAspectRatio="xMidYMid meet"/>`;
  }
  const fill = safeColour(match.colours[side]);
  const letter = teamName(match, side).trim().charAt(0).toUpperCase();
  return [
    `<circle cx="${round(x)}" cy="${round(y)}" r="${round(size / 2)}" fill="${fill}"/>`,
    text(letter, { x, y: y + size * 0.18, size: size * 0.5, anchor: 'middle', fill: readableOn(fill) }),
  ].join('');
}

/** A centred line of text, made smaller if it would not fit. */
function line(c, value, { x = c.w / 2, y, size, fill, anchor = 'middle', maxWidth = c.w - 2 * c.margin }) {
  if (!value) return '';
  return text(value, { x, y, size: fitSize(value, size, maxWidth), anchor, fill });
}

function text(value, { x, y, size, anchor, fill }) {
  return `<text x="${round(x)}" y="${round(y)}" font-size="${round(size)}" text-anchor="${anchor}" fill="${fill}">${escapeXml(value)}</text>`;
}

// --- Small helpers --------------------------------------------------------------

const teamName = (match, side) => (side === 'away' ? match.away : match.home) || (side === 'away' ? 'Away' : 'Home');
const round = (n) => Math.round(n * 10) / 10;

/** Names are typed by a person, so anything with a meaning in SVG is escaped. */
export function escapeXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** A colour is used only if it is a plain #rrggbb value. */
function safeColour(colour) {
  return /^#[0-9a-fA-F]{6}$/.test(colour ?? '') ? colour : '#5b6475';
}

/** Black or white, whichever is easier to read on `colour`. */
function readableOn(colour) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(colour.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#101216' : '#ffffff';
}
