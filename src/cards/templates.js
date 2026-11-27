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
// The banner of that artwork is a pitch mown in stripes: sixteen across its width, every other
// one a little lighter, the first at the left edge. The cards have the same stripes behind them.
const STRIPE = '#12211b';
const STRIPE_WIDTH = 120;

/**
 * Draw any card.
 *
 * @param {{ match: object, card: object, size: 'landscape' | 'portrait', still?: boolean }} options
 *   `still` leaves out the logo that moves (see `movingLogo`), so a compilation can lay the
 *   moving one over the rest. A card with no such logo is drawn whole either way.
 * @returns {string} SVG
 */
export function renderCard({ match, card, size, still = false }) {
  const draw = { goal: goalCard, red: redCard, fulltime: fullTimeCard }[card.type];
  if (!draw) throw new Error(`Unknown kind of card: ${card.type}`);
  return draw({ match, card, size, still });
}

/**
 * The logo that moves when a compilation shows the card: on a goal card the club given the
 * goal, on a red card the sent-off player's club. Where it stands on the card (its middle and
 * its side, in the card's pixels) and the side of the square picture it is saved in, `room`,
 * which is larger than the logo so its corners stay inside when it leans.
 *
 * @param {{ card: object, size: 'landscape' | 'portrait' }} options
 * @returns {{ team: 'home' | 'away', x: number, y: number, size: number, room: number } | null}
 *   null for a card where no logo moves: full time, which belongs to both clubs.
 */
export function movingLogo({ card, size }) {
  if (card.type !== 'goal' && card.type !== 'red') return null;
  const c = canvas(size);
  const team = card.team === 'away' ? 'away' : 'home';
  const alone = card.type === 'red' && !card.showScore;
  const box = alone
    ? { x: c.w / 2, y: c.loneIconY, size: c.loneIcon }
    : { x: c.clubX[team === 'away' ? 1 : 0], y: c.clubsY, size: c.clubIcon };
  // A square leaning 10 degrees is 1.16 times as wide; an even number, so the logo sits on whole pixels.
  return { team, ...box, room: 2 * Math.ceil(box.size * 0.6) };
}

/** The moving logo by itself, in the middle of a see-through square of `room` pixels. Null when the card has none. */
export function movingLogoPicture({ match, card, size }) {
  const logo = movingLogo({ card, size });
  if (!logo) return null;
  return [opening(logo.room, logo.room), icon(canvas(size), match, logo.team, { x: logo.room / 2, y: logo.room / 2, size: logo.size }), '</svg>'].join('');
}

/** The score a match stands at: its full-time card's, else the one after its last goal, else none yet. */
export function matchScore(match) {
  const cards = match.cards ?? [];
  const last = cards.findLast((card) => card.type === 'fulltime') ?? cards.findLast((card) => card.type === 'goal');
  return last ? { home: last.homeScore ?? 0, away: last.awayScore ?? 0 } : null;
}

// The one name in a picture, for the blur behind the thumbnail. Cards have none, since several
// cards can stand in one page; there is only ever one thumbnail.
const BLUR = 'thumbnail-blur';
// How much of the blurred logo shows in its half: enough to see, little enough that the half
// stays the club's own bright colour.
const FAINT = 0.4;
// How much of the dark plate behind the thumbnail's score there is: the halves show through the rest.
const SCORE_PLATE = 0.45;
// The dark of a credit's plate in a compilation: here the thin edge round a streamer's picture,
// and the disc of one who has no picture.
const PLATE = '#141414';
/** How many streamers the thumbnail lists at most. They take as many lines as they need. */
export const THUMBNAIL_STREAMERS = 40;

/**
 * The picture for the video's page on YouTube (asked for on 2026-11-25, in place of the intro
 * card): laid out like the full-time card without its title and scorers. The left half is the
 * home club's bright colour with its logo in it, zoomed in, blurred and faint; the right half
 * is the away club's. In front are both logos, the names and the score, which is the match's
 * own (`matchScore`), or "V" while the match has none. Across the top stand the streamers of
 * the video: each one's round picture in a white ring, without the name (the name stays on the
 * credit in the video itself).
 *
 * It is drawn on the wide card's 1920 by 1080 and exported smaller (`THUMBNAIL_SIZE`). It is
 * never part of a compilation, so it is not a kind of card.
 *
 * @param {{ match: object, streamers?: { name: string, picture?: string }[] }} options
 *   a streamer's `picture` is a small PNG written as text, like a club's icon, or nothing
 * @returns {string} SVG
 */
export function thumbnail({ match, streamers = [] }) {
  const c = canvas('landscape');
  const { u, w, h } = c;
  const half = w / 2;
  const sides = ['home', 'away'];
  const colours = sides.map((side) => safeColour(match.colours[side]));
  // What is written on a half is black or white, whichever reads on the club's colour.
  const inks = colours.map(readableOn);
  // Much larger than its half, so the blur's soft edge falls outside it.
  const zoom = 1500 * u;
  const halves = sides.map((side, i) => {
    const picture = match.icons?.[side];
    const blurred = isIcon(picture)
      ? `<image href="${picture}" x="${round((half - zoom) / 2)}" y="${round((h - zoom) / 2)}" width="${round(zoom)}" height="${round(zoom)}" preserveAspectRatio="xMidYMid meet" opacity="${FAINT}" filter="url(#${BLUR})"/>`
      : '';
    // A picture inside a picture shows only what falls inside it, which keeps each logo in its half.
    return `<svg x="${round(i * half)}" y="0" width="${round(half)}" height="${h}" viewBox="0 0 ${round(half)} ${h}">${box(0, 0, half, h, colours[i])}${blurred}</svg>`;
  });

  const listed = streamers.filter((streamer) => streamer?.name?.trim()).slice(0, THUMBNAIL_STREAMERS);
  const xs = [420 * u, w - 420 * u];
  const logoSize = 440 * u;
  // With streamers across the top the clubs stand lower: a little for one line, more for several.
  const lines = streamerLines(c, listed, 1).length;
  const logoY = (lines === 0 ? 470 : lines === 1 ? 560 : 610) * u;
  const names = sides.map((side) => teamName(match, side).toUpperCase());
  const nameSize = Math.min(...names.map((name) => fitSize(name, 84 * u, 780 * u)));
  const base = logoY + logoSize / 2 + 60 * u + 0.72 * 84 * u;
  const clubs = sides.map((side, i) => {
    const bar = Math.max(160 * u, textWidth(names[i], nameSize));
    // A club without an icon gets its letter, in its colour, on a disc that shows on that colour.
    const logo = isIcon(match.icons?.[side])
      ? icon(c, match, side, { x: xs[i], y: logoY, size: logoSize })
      : `<circle cx="${round(xs[i])}" cy="${round(logoY)}" r="${round(logoSize / 2)}" fill="${inks[i]}"/>${text(names[i].trim().charAt(0), { x: xs[i], y: logoY + logoSize * 0.18, size: logoSize * 0.5, anchor: 'middle', fill: colours[i] })}`;
    return [
      logo,
      text(names[i], { x: xs[i], y: base, size: nameSize, anchor: 'middle', fill: inks[i] }),
      box(xs[i] - bar / 2, base + 24 * u, bar, 16 * u, inks[i]),
    ].join('');
  });

  // The score stands on a plate of the dark green, on the line between the halves. The plate
  // is see-through (the owner found a solid one too black, and none at all too little,
  // 2026-11-25), so each figure also has a thin dark edge to read on a white club's half.
  const score = matchScore(match);
  const label = score ? `${score.home} – ${score.away}` : 'V';
  const plate = { width: 560 * u, height: 300 * u };
  const size = fitSize(label, 250 * u, plate.width - 100 * u);
  return [
    opening(w, h),
    `<defs><filter id="${BLUR}" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="${round(45 * u)}"/></filter></defs>`,
    `<rect width="${w}" height="${h}" fill="${BACKGROUND}"/>`,
    ...halves,
    box(w / 2 - 5 * u, 0, 10 * u, h, BACKGROUND),
    ...clubs,
    `<rect x="${round(w / 2 - plate.width / 2)}" y="${round(logoY - plate.height / 2)}" width="${round(plate.width)}" height="${round(plate.height)}" rx="${round(40 * u)}" fill="${BACKGROUND}" fill-opacity="${SCORE_PLATE}"></rect>`,
    `<text x="${round(w / 2)}" y="${round(logoY + 0.36 * size)}" font-size="${round(size)}" text-anchor="middle" stroke="${BACKGROUND}" stroke-width="${round(size * 0.05)}" stroke-linejoin="round" paint-order="stroke" fill="${score ? TEXT : ACCENT}">${escapeXml(label)}</text>`,
    streamerRows(c, listed, logoY - logoSize / 2),
    '</svg>',
  ].join('');
}

// A streamer's picture at its usual size, in the card's units: the same whether one streamer
// is listed or many (2026-11-25: sized to fill the line, one or two came out far too big).
const STREAMER = { size: 124, ring: 5, edge: 3, space: 26, between: 22, top: 44 };

/** The streamers shared out over lines, in order: each line holds as many as fit across the picture. */
function streamerLines(c, streamers, k) {
  const each = Math.max(1, Math.floor((c.w - 2 * 60 * c.u + STREAMER.space * k * c.u) / ((STREAMER.size + STREAMER.space) * k * c.u)));
  const lines = [];
  for (let i = 0; i < streamers.length; i += each) lines.push(streamers.slice(i, i + each));
  return lines;
}

/**
 * The streamers across the top of the thumbnail, each line in the middle: only their pictures
 * (the owner had the names taken off, 2026-11-25; the credit in the video keeps the name). Each
 * is the channel's round picture in a white ring with a thin dark edge, so it shows on a white
 * club's half and on a dark one. A streamer without a picture is a dark disc with the first
 * letter of the name, so nobody credited is left out. The pictures keep their size however few
 * there are. When one line cannot hold them all they go on to the next, and only when the lines
 * would reach down to the logos (at `bottom`) are they all made smaller together, so the last
 * streamer added is still there.
 */
function streamerRows(c, streamers, bottom) {
  if (streamers.length === 0) return '';
  const { u, w } = c;
  const tall = (lines, k) => (lines.length * STREAMER.size + (lines.length - 1) * STREAMER.between) * k * u;
  const room = bottom - (STREAMER.top + 24) * u;
  let k = 1;
  let lines = streamerLines(c, streamers, k);
  while (tall(lines, k) > room && k > 0.3) {
    k -= 0.05;
    lines = streamerLines(c, streamers, k);
  }
  const s = k * u;
  const r = (STREAMER.size * s) / 2;
  return lines.map((line, row) => {
    const total = line.length * STREAMER.size * s + (line.length - 1) * STREAMER.space * s;
    const y = STREAMER.top * u + row * (STREAMER.size + STREAMER.between) * s + r;
    return line.map((streamer, i) => {
      const x = (w - total) / 2 + i * (STREAMER.size + STREAMER.space) * s + r;
      const inner = r - (STREAMER.ring + STREAMER.edge) * s;
      const face = isIcon(streamer.picture)
        ? `<image href="${streamer.picture}" x="${round(x - inner)}" y="${round(y - inner)}" width="${round(2 * inner)}" height="${round(2 * inner)}" preserveAspectRatio="xMidYMid meet"/>`
        : `<circle cx="${round(x)}" cy="${round(y)}" r="${round(inner)}" fill="${PLATE}"/>${text(streamer.name.trim().charAt(0).toUpperCase(), { x, y: y + 0.36 * inner, size: inner, anchor: 'middle', fill: TEXT })}`;
      return `<circle cx="${round(x)}" cy="${round(y)}" r="${round(r)}" fill="${PLATE}"/><circle cx="${round(x)}" cy="${round(y)}" r="${round(r - STREAMER.edge * s)}" fill="${TEXT}"/>${face}`;
    }).join('');
  }).join('');
}

/**
 * A goal: the title and the minute on the scoring team's colour, the scorer, and both clubs with the score.
 * A missed penalty is drawn the same way, titled "PENALTY MISSED", on the colour of the team that missed.
 */
export function goalCard({ match, card, size, still = false }) {
  const c = canvas(size);
  const type = goalType(card.goalType);
  // A missed penalty's title already says what it is, so the line under the name is left empty.
  const details = type.missed ? [] : [type.label];
  if (type.assist && card.assist) details.push(`Assist: ${card.assist}`);
  // The team is the one given the goal, so for an own goal it is not the scorer's club.
  return frame(c, [
    header(c, match),
    pill(c, { colour: safeColour(match.colours[card.team]), title: type.missed ? 'PENALTY MISSED' : type.id === 'own-goal' ? 'OWN GOAL' : 'GOAL', minute: minuteLabel(card.minute, card.added) }),
    line(c, card.scorer, { y: c.nameY, size: c.nameSize, fill: TEXT }),
    line(c, details.join('  ·  '), { y: c.detailY, size: c.detailSize, fill: MUTED }),
    scoreboard(c, match, { home: card.homeScore, away: card.awayScore, lit: card.team }, { y: c.clubsY, iconSize: c.clubIcon, nameSize: c.clubNameSize, scoreY: c.scoreY, without: still ? movingLogo({ card, size }).team : null }),
  ]);
}

/** A red card: the player and his club. With the score it shows both clubs, without it only the player's. */
export function redCard({ match, card, size, still = false }) {
  const c = canvas(size);
  const details = [teamName(match, card.team), redType(card.redType).label];
  return frame(c, [
    header(c, match),
    pill(c, { colour: RED, title: 'RED CARD', minute: minuteLabel(card.minute, card.added) }),
    line(c, card.player, { y: c.nameY, size: c.nameSize, fill: TEXT }),
    line(c, details.join('  ·  '), { y: c.detailY, size: c.detailSize, fill: MUTED }),
    card.showScore
      ? scoreboard(c, match, { home: card.homeScore, away: card.awayScore }, { y: c.clubsY, iconSize: c.clubIcon, nameSize: c.clubNameSize, scoreY: c.scoreY, without: still ? movingLogo({ card, size }).team : null })
      : !still && icon(c, match, card.team === 'away' ? 'away' : 'home', { x: c.w / 2, y: c.loneIconY, size: c.loneIcon }),
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
 * `without` names a team whose icon is left out, for the card whose logo moves.
 */
function scoreboard(c, match, { home, away, lit }, { y, iconSize, nameSize, scoreY, without = null }) {
  const u = c.u;
  const [left, right] = c.clubX;
  const names = ['home', 'away'].map((side) => teamName(match, side).toUpperCase());
  const fitted = Math.min(...names.map((name) => fitSize(name, nameSize, c.clubRoom)));
  const base = y + iconSize / 2 + 30 * u + 0.72 * nameSize;
  const parts = ['home', 'away'].map((side, i) => {
    const bar = Math.max(120 * u, textWidth(names[i], fitted));
    return [
      without === side ? '' : icon(c, match, side, { x: c.clubX[i], y, size: iconSize }),
      text(names[i], { x: c.clubX[i], y: base, size: fitted, anchor: 'middle', fill: lit && lit !== side ? MUTED : TEXT }),
      box(c.clubX[i] - bar / 2, base + 18 * u, bar, 12 * u, safeColour(match.colours[side])),
    ].join('');
  });
  const score = `${home ?? 0} – ${away ?? 0}`;
  const size = fitSize(score, 230 * u, scoreY ? c.w - 2 * c.margin : right - left - iconSize - 180 * u);
  parts.push(text(score, { x: c.w / 2, y: scoreY ?? y + 0.36 * size, size, anchor: 'middle', fill: TEXT }));
  return parts.join('');
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

/** The whole picture: the background, then the card's parts in order. */
function frame(c, parts) {
  return [
    opening(c.w, c.h),
    background(c),
    ...parts.filter(Boolean),
    '</svg>',
  ].join('');
}

/** How every picture begins: its size, and the font its words are in. */
function opening(width, height) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="'${CARD_FONT}', 'Liberation Sans', Arial, sans-serif" font-weight="bold">`;
}

/** What a card stands on: the dark green, mown in stripes like the pitch of the channel's banner. */
function background(c) {
  const width = STRIPE_WIDTH * c.u;
  const stripes = [];
  for (let x = 0; x < c.w; x += 2 * width) stripes.push(box(x, 0, Math.min(width, c.w - x), c.h, STRIPE));
  return `<rect width="${c.w}" height="${c.h}" fill="${BACKGROUND}"/>${stripes.join('')}`;
}

/** A centred line of text, made smaller if it would not fit. */
function line(c, value, { x = c.w / 2, y, size, fill, anchor = 'middle', maxWidth = c.w - 2 * c.margin }) {
  if (!value) return '';
  return text(value, { x, y, size: fitSize(value, size, maxWidth), anchor, fill });
}

function text(value, { x, y, size, anchor, fill }) {
  return `<text x="${round(x)}" y="${round(y)}" font-size="${round(size)}" text-anchor="${anchor}" fill="${fill}">${escapeXml(value)}</text>`;
}

/** A filled block. */
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
