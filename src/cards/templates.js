// The cards themselves. One function per kind of card, each returning an SVG
// picture as text. The page shows that SVG as the preview and turns the very
// same SVG into the PNG, so the two cannot differ.
//
// Text and plain blocks of team colour, with one exception: a card shows a
// club icon for each team when the owner has added one to the match. Nothing
// here fetches a picture; an icon is only ever what the owner chose.
import { CARD_SIZES, goalType, isIcon, minuteLabel, redType } from './config.js';
import { fitSize, textWidth } from './measure.js';

/** Name the page and the PNG export give the bundled font. */
export const CARD_FONT = 'Clipper Card';

// The cards' own colours, taken on 2026-11-25 from the artwork of the owner's channel (its logo
// and banner): the dark green of their background, their white, and their lime for the things
// that belong to neither team. The grey is the white thinned with that green. A red card stays red.
const BACKGROUND = '#0a1a14';
const TEXT = '#ffffff';
const MUTED = '#a3b0aa';
const ACCENT = '#c6ff3d';
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
  parts.push(text(middle, { x: c.w / 2, y: c.introMiddleY, anchor: 'middle', fill: card.showScore ? TEXT : ACCENT, size: middleSize }));
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

/** A goal: the title and the minute on the scoring team's colour, the scorer, and both clubs with the score. */
export function goalCard({ match, card, size }) {
  const c = canvas(size);
  const type = goalType(card.goalType);
  const details = [type.label];
  if (type.assist && card.assist) details.push(`Assist: ${card.assist}`);
  // The team is the one given the goal, so for an own goal it is not the scorer's club.
  return frame(c, [
    header(c, match),
    pill(c, { colour: safeColour(match.colours[card.team]), title: type.id === 'own-goal' ? 'OWN GOAL' : 'GOAL', minute: minuteLabel(card.minute, card.added) }),
    line(c, card.scorer, { y: c.nameY, size: c.nameSize, fill: TEXT }),
    line(c, details.join('  ·  '), { y: c.detailY, size: c.detailSize, fill: MUTED }),
    scoreboard(c, match, { home: card.homeScore, away: card.awayScore, lit: card.team }, { y: c.clubsY, iconSize: c.clubIcon, nameSize: c.clubNameSize, scoreY: c.scoreY }),
  ]);
}

/** A red card: the player and his club. With the score it shows both clubs, without it only the player's. */
export function redCard({ match, card, size }) {
  const c = canvas(size);
  const details = [teamName(match, card.team), redType(card.redType).label];
  return frame(c, [
    header(c, match),
    pill(c, { colour: RED, title: 'RED CARD', minute: minuteLabel(card.minute, card.added) }),
    line(c, card.player, { y: c.nameY, size: c.nameSize, fill: TEXT }),
    line(c, details.join('  ·  '), { y: c.detailY, size: c.detailSize, fill: MUTED }),
    card.showScore
      ? scoreboard(c, match, { home: card.homeScore, away: card.awayScore }, { y: c.clubsY, iconSize: c.clubIcon, nameSize: c.clubNameSize, scoreY: c.scoreY })
      : icon(c, match, card.team === 'away' ? 'away' : 'home', { x: c.w / 2, y: c.loneIconY, size: c.loneIcon }),
  ]);
}

/** Full time: both clubs with the final score, and each club's scorers under it. */
export function fullTimeCard({ match, card, size }) {
  const c = canvas(size);
  const parts = [
    header(c, match),
    pill(c, { colour: ACCENT, title: 'FULL TIME', minute: '' }),
    scoreboard(c, match, { home: card.homeScore, away: card.awayScore }, { y: c.fullTimeClubsY, iconSize: c.fullTimeIcon, nameSize: c.fullTimeNameSize, scoreY: c.fullTimeScoreY }),
  ];
  [card.homeScorers, card.awayScorers].forEach((lines, i) => (lines ?? []).slice(0, c.maxScorers).forEach((value, n) => {
    parts.push(line(c, value, { x: c.clubX[i], y: c.scorersY + n * c.scorerStep, size: c.scorerSize, fill: MUTED, maxWidth: c.clubRoom }));
  }));
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
  // `scoreY` is where the score stands when it is under the two clubs; on the wide card it is between them.
  return portrait
    ? {
        w, h, u, portrait, margin,
        headerY: 150 * u, headerSize: 44 * u,
        pillY: 220 * u, pillH: 150 * u, titleSize: 96 * u,
        nameY: 580 * u, nameSize: 130 * u, detailY: 675 * u, detailSize: 52 * u,
        clubX: [290 * u, 790 * u], clubRoom: 440 * u,
        clubsY: 980 * u, clubIcon: 320 * u, clubNameSize: 52 * u, scoreY: 1480 * u,
        fullTimeClubsY: 640 * u, fullTimeIcon: 340 * u, fullTimeNameSize: 52 * u, fullTimeScoreY: 1150 * u,
        scorersY: 1290 * u, scorerStep: 62 * u, scorerSize: 42 * u, maxScorers: 4,
        loneIconY: 1180 * u, loneIcon: 400 * u,
        scoreSize: 230 * u, teamSize: 76 * u, barH: 16 * u,
        introIcon: 400 * u, introHomeY: 430 * u, introAwayY: 1340 * u, introMiddleY: 1040 * u,
        introNameWidth: w - 2 * margin, introMiddleWidth: w - 2 * margin, introSpread: 0,
      }
    : {
        w, h, u, portrait, margin,
        headerY: 110 * u, headerSize: 38 * u,
        pillY: 160 * u, pillH: 120 * u, titleSize: 78 * u,
        nameY: 430 * u, nameSize: 130 * u, detailY: 515 * u, detailSize: 48 * u,
        clubX: [400 * u, w - 400 * u], clubRoom: 600 * u,
        clubsY: 745 * u, clubIcon: 270 * u, clubNameSize: 50 * u, scoreY: null,
        fullTimeClubsY: 470 * u, fullTimeIcon: 280 * u, fullTimeNameSize: 54 * u, fullTimeScoreY: null,
        scorersY: 780 * u, scorerStep: 54 * u, scorerSize: 42 * u, maxScorers: 4,
        loneIconY: 770 * u, loneIcon: 300 * u,
        scoreSize: 170 * u, teamSize: 76 * u, barH: 14 * u,
        introIcon: 400 * u, introY: 480 * u, introMiddleY: 540 * u, introSpread: 560 * u,
        introNameWidth: 700 * u, introMiddleWidth: 420 * u,
      };
}

/** Competition and date, small, at the top. */
function header(c, match) {
  const text = [match.competition, match.date].filter(Boolean).join('  ·  ');
  return text ? line(c, text.toUpperCase(), { y: c.headerY, size: c.headerSize, fill: MUTED }) : '';
}

/**
 * The card's title and the minute in a rounded block of colour, in the middle of the card's
 * width: the title at its left end, the minute at its right. A team's colour is only ever a
 * block like this with black or white words on it, never the colour of words on the dark
 * background, where a navy or black club would vanish.
 */
function pill(c, { colour, title, minute }) {
  const { u, w } = c;
  const ink = readableOn(colour);
  const gap = minute ? 50 * u : 0;
  const size = fitSize(`${title}${minute}`, c.titleSize, w - 2 * c.margin - 140 * u - gap);
  const width = textWidth(`${title}${minute}`, size) + gap + 140 * u;
  const base = c.pillY + c.pillH / 2 + size * 0.36;
  const parts = [box((w - width) / 2, c.pillY, width, c.pillH, colour, c.pillH / 2)];
  if (minute) {
    parts.push(text(title, { x: (w - width) / 2 + 70 * u, y: base, size, anchor: 'start', fill: ink }));
    parts.push(text(minute, { x: (w + width) / 2 - 70 * u, y: base, size, anchor: 'end', fill: ink }));
  } else {
    parts.push(text(title, { x: w / 2, y: base, size, anchor: 'middle', fill: ink }));
  }
  return parts.join('');
}

/**
 * The two clubs side by side with the score: each club's icon, its name under it and a bar of
 * its colour under the name. The score stands between the two icons where the card is wide
 * enough, and under them (at `scoreY`) on the tall card. The other team's name is dimmed when
 * one is `lit`. Both names are written at one size, the largest at which the longer one fits.
 */
function scoreboard(c, match, { home, away, lit }, { y, iconSize, nameSize, scoreY }) {
  const u = c.u;
  const [left, right] = c.clubX;
  const names = ['home', 'away'].map((side) => teamName(match, side).toUpperCase());
  const fitted = Math.min(...names.map((name) => fitSize(name, nameSize, c.clubRoom)));
  const base = y + iconSize / 2 + 30 * u + 0.72 * nameSize;
  const parts = ['home', 'away'].map((side, i) => {
    const bar = Math.max(120 * u, textWidth(names[i], fitted));
    return [
      icon(c, match, side, { x: c.clubX[i], y, size: iconSize }),
      text(names[i], { x: c.clubX[i], y: base, size: fitted, anchor: 'middle', fill: lit && lit !== side ? MUTED : TEXT }),
      box(c.clubX[i] - bar / 2, base + 18 * u, bar, 12 * u, safeColour(match.colours[side])),
    ].join('');
  });
  const score = `${home ?? 0} – ${away ?? 0}`;
  const size = fitSize(score, 230 * u, scoreY ? c.w - 2 * c.margin : right - left - iconSize - 180 * u);
  parts.push(text(score, { x: c.w / 2, y: scoreY ?? y + 0.36 * size, size, anchor: 'middle', fill: TEXT }));
  return parts.join('');
}

/** A team name with a bar of its colour under it, on the intro card. */
function team(c, match, side, { x, y, anchor, width }) {
  const name = teamName(match, side).toUpperCase();
  const size = fitSize(name, c.teamSize, width);
  const barWidth = Math.min(width, Math.max(120 * c.u, textWidth(name, size)));
  const barX = anchor === 'end' ? x - barWidth : anchor === 'middle' ? x - barWidth / 2 : x;
  return [
    text(name, { x, y, size, anchor, fill: TEXT }),
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

function frame(c, parts) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${c.w} ${c.h}" width="${c.w}" height="${c.h}" font-family="'${CARD_FONT}', 'Liberation Sans', Arial, sans-serif" font-weight="bold">`,
    `<rect width="${c.w}" height="${c.h}" ${SOLID_BACKGROUND}`,
    ...parts.filter(Boolean),
    '</svg>',
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

/** A filled block. Written so it can never be taken for the card's own background, which only `frame` draws. */
function box(x, y, width, height, fill, radius = 0) {
  const corners = radius ? ` rx="${round(radius)}"` : '';
  return `<rect x="${round(x)}" y="${round(y)}" width="${round(width)}" height="${round(height)}"${corners} fill="${fill}"></rect>`;
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

/** The cards' dark colour or white, whichever is easier to read on `colour`. */
function readableOn(colour) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(colour.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? BACKGROUND : '#ffffff';
}
