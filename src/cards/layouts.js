// The extra layouts of a goal, red or full-time card (asked for on 2026-11-25).
//
// Each kind of card is first turned into one list of what it says (`cardContent`), and a layout
// only decides where those things stand, wide and tall. So every layout shows the same fields,
// and a new field is added in one place. The classic layout is not here: it is the original
// drawing in templates.js, kept exactly as it was.
//
// Plain shapes and text only, like every card, except in the two logo layouts ("crests" and
// "badge", asked for the same day), which also show the clubs' icons: the same owner-chosen
// pictures the intro card shows, drawn by the same `icon`, with the same letter on the team's
// colour when a club has none. A team colour is only ever a filled block with black or white
// words on it, never the colour of words on the dark background, where a navy or black club
// would vanish.
import { CARD_SIZES, goalType, minuteLabel, redType } from './config.js';
import { fitSize, textWidth } from './measure.js';
import { frame, icon, line, MUTED, PANEL, readableOn, RED, round, safeColour, teamName, text, TEXT } from './parts.js';

const LAYOUTS = { side, centre, strip, crests, badge };

/**
 * The function that draws a card in the layout `id`, or null for "classic", for no layout
 * at all (a card saved before layouts existed) and for one this version does not know.
 *
 * @param {string | undefined} id
 * @returns {((options: { match: object, card: object, size: string }) => string) | null}
 */
export function layoutFor(id) {
  if (!Object.hasOwn(LAYOUTS, id ?? '')) return null;
  return ({ match, card, size }) => {
    const c = sheet(size);
    return frame(c, LAYOUTS[id](c, match, cardContent(match, card)));
  };
}

/**
 * What a card says, whatever its layout.
 *
 * @returns {{
 *   header: string, title: string, colour: string | null, team: 'home' | 'away' | null,
 *   minute: string, name: string, details: string,
 *   score: { home: number, away: number, lit?: 'home' | 'away' } | null,
 *   scorers: { home: string[], away: string[] } | null,
 * }} `colour` is the block the title stands on (null for full time, which belongs to neither
 *   team); `team` is the team the card is about: the one given the goal (for an own goal that
 *   is not the scorer's club) or the sent-off player's; `score` is null when the card does not
 *   show it; `scorers` only on a full-time card.
 */
export function cardContent(match, card) {
  const header = [match.competition, match.date].filter(Boolean).join('  ·  ').toUpperCase();
  const minute = minuteLabel(card.minute, card.added);
  const score = { home: card.homeScore ?? 0, away: card.awayScore ?? 0 };
  const team = card.team === 'away' ? 'away' : 'home';
  if (card.type === 'goal') {
    const type = goalType(card.goalType);
    const details = [type.label];
    if (type.assist && card.assist) details.push(`Assist: ${card.assist}`);
    return {
      header, title: type.id === 'own-goal' ? 'OWN GOAL' : 'GOAL', colour: safeColour(match.colours[card.team]), team, minute,
      name: card.scorer ?? '', details: details.join('  ·  '), score: { ...score, lit: card.team }, scorers: null,
    };
  }
  if (card.type === 'red') {
    return {
      header, title: 'RED CARD', colour: RED, team, minute, name: card.player ?? '',
      details: [teamName(match, card.team), redType(card.redType).label].join('  ·  '), score: card.showScore ? score : null, scorers: null,
    };
  }
  return {
    header, title: 'FULL TIME', colour: null, team: null, minute: '', name: '', details: '', score,
    scorers: { home: card.homeScorers ?? [], away: card.awayScorers ?? [] },
  };
}

/** The card's shape. One unit is a pixel on the 1920-wide card; the tall card scales to its 1080 width. */
function sheet(size) {
  const { width: w, height: h } = CARD_SIZES[size] ?? CARD_SIZES.landscape;
  const portrait = h > w;
  const u = portrait ? w / 1080 : w / 1920;
  return { w, h, u, portrait, margin: 90 * u };
}

// --- Side panel -------------------------------------------------------------------
// A block of the team's colour holds the title and the minute: down the left side of the wide
// card, across the top of the tall one. Everything else is left-aligned beside or under it,
// and the score is two rows, a team in each.

function side(c, match, k) {
  const { u, w, h } = c;
  const fill = k.colour ?? PANEL;
  const ink = readableOn(fill);
  const words = k.title.split(' ');
  const parts = [];

  if (c.portrait) {
    const x = c.margin;
    const right = w - c.margin;
    const panel = 620 * u;
    const size = 170 * u;
    const first = 312 * u + (2 - words.length) * 85 * u; // one word stands in the middle of the room for two
    parts.push(box(0, 0, w, panel, fill));
    parts.push(line(c, k.header, { x, y: 120 * u, size: 40 * u, anchor: 'start', fill: ink, opacity: 0.8 }));
    words.forEach((word, i) => parts.push(text(word, { x, y: first + i * size, size, anchor: 'start', fill: ink })));
    parts.push(line(c, k.minute, { x: right, y: panel - 60 * u, size: 120 * u, anchor: 'end', fill: ink, maxWidth: 380 * u }));
    if (k.scorers) {
      parts.push(teamBlocks(c, match, k, { x, right, tops: [780 * u, 1320 * u], max: 3, nameSize: 76 * u, digitSize: 200 * u, lineSize: 48 * u, step: 66 * u }));
      return parts;
    }
    const nameY = k.score ? 900 * u : 1100 * u;
    parts.push(line(c, k.name, { x, y: nameY, size: 120 * u, anchor: 'start', fill: TEXT }));
    parts.push(line(c, k.details, { x, y: nameY + 90 * u, size: 50 * u, anchor: 'start', fill: MUTED }));
    if (k.score) {
      parts.push(box(x, 1130 * u, right - x, 4 * u, PANEL));
      parts.push(scoreRows(c, match, k.score, { x, right, y: 1360 * u, step: 200 * u, nameSize: 72 * u, digitSize: 130 * u }));
    }
    return parts;
  }

  const panel = 600 * u;
  const pad = 70 * u;
  const size = Math.min(...words.map((word) => fitSize(word, 160 * u, panel - 2 * pad)));
  const minuteSize = 130 * u;
  // The title and the minute are one group, in the middle of the panel's height.
  const group = 0.72 * size + (words.length - 1) * size + (k.minute ? 70 * u + 0.72 * minuteSize : 0);
  const first = (h - group) / 2 + 0.72 * size;
  parts.push(box(0, 0, panel, h, fill));
  words.forEach((word, i) => parts.push(text(word, { x: pad, y: first + i * size, size, anchor: 'start', fill: ink })));
  parts.push(line(c, k.minute, { x: pad, y: first + (words.length - 1) * size + 70 * u + 0.72 * minuteSize, size: minuteSize, anchor: 'start', fill: ink, maxWidth: panel - 2 * pad }));

  const x = panel + 90 * u;
  const right = w - c.margin;
  const width = right - x;
  parts.push(line(c, k.header, { x, y: 130 * u, size: 38 * u, anchor: 'start', fill: MUTED, maxWidth: width }));
  if (k.scorers) {
    parts.push(teamBlocks(c, match, k, { x, right, tops: [240 * u, 640 * u], max: 4, nameSize: 76 * u, digitSize: 200 * u, lineSize: 42 * u, step: 55 * u }));
    return parts;
  }
  const nameY = k.score ? 420 * u : 540 * u;
  parts.push(line(c, k.name, { x, y: nameY, size: 130 * u, anchor: 'start', fill: TEXT, maxWidth: width }));
  parts.push(line(c, k.details, { x, y: nameY + 90 * u, size: 50 * u, anchor: 'start', fill: MUTED, maxWidth: width }));
  if (k.score) {
    parts.push(box(x, 610 * u, width, 4 * u, PANEL));
    parts.push(scoreRows(c, match, k.score, { x, right, y: 770 * u, step: 140 * u, nameSize: 68 * u, digitSize: 110 * u }));
  }
  return parts;
}

/** Full time, a block for each team: its name, its scorers under it, its score large at the right. */
function teamBlocks(c, match, k, { x, right, tops, max, nameSize, digitSize, lineSize, step }) {
  const u = c.u;
  const inset = 44 * u;
  const width = right - x - inset - textWidth('00', digitSize) - 50 * u;
  const size = namesSize(match, nameSize, width);
  return ['home', 'away'].map((team, i) => {
    const top = tops[i];
    const nameY = top + 0.72 * nameSize;
    const lines = k.scorers[team].slice(0, max);
    const bar = 0.72 * nameSize + (lines.length > 0 ? 24 * u + lines.length * step : 0);
    return [
      box(x, top, 14 * u, bar, safeColour(match.colours[team])),
      text(teamName(match, team).toUpperCase(), { x: x + inset, y: nameY, size, anchor: 'start', fill: TEXT }),
      text(String(k.score[team]), { x: right, y: top + 0.72 * digitSize, size: digitSize, anchor: 'end', fill: TEXT }),
      ...lines.map((value, n) => line(c, value, { x: x + inset, y: nameY + 16 * u + (n + 1) * step, size: lineSize, anchor: 'start', fill: MUTED, maxWidth: width })),
    ].join('');
  }).join('');
}

/** The score as two rows: a bar of the team's colour, its name, its goals at the right. */
function scoreRows(c, match, score, { x, right, y, step, nameSize, digitSize }) {
  const u = c.u;
  const inset = 44 * u;
  const size = namesSize(match, nameSize, right - x - inset - textWidth('00', digitSize) - 40 * u);
  return ['home', 'away'].map((team, i) => {
    const middle = y + i * step - 0.36 * nameSize; // half way up the capitals, wherever the names end up
    const fill = score.lit && score.lit !== team ? MUTED : TEXT;
    return [
      box(x, middle - 0.4 * digitSize, 14 * u, 0.8 * digitSize, safeColour(match.colours[team])),
      text(teamName(match, team).toUpperCase(), { x: x + inset, y: middle + 0.36 * size, size, anchor: 'start', fill }),
      text(String(score[team]), { x: right, y: middle + 0.36 * digitSize, size: digitSize, anchor: 'end', fill }),
    ].join('');
  }).join('');
}

// --- Centre ---------------------------------------------------------------------
// Everything in the middle: the title and the minute in a pill of the team's colour, the name
// very large, the score on a plate. A line of the colour runs along the top and bottom edges.

function centre(c, match, k) {
  const { u, w, h } = c;
  const tall = c.portrait;
  const parts = [];
  const edge = (tall ? 24 : 20) * u;
  for (const y of [0, h - edge]) {
    // Full time belongs to both teams: half the line each.
    if (k.colour) parts.push(box(0, y, w, edge, k.colour));
    else parts.push(box(0, y, w / 2, edge, safeColour(match.colours.home)), box(w / 2, y, w / 2, edge, safeColour(match.colours.away)));
  }
  parts.push(line(c, k.header, { y: (tall ? 150 : 120) * u, size: (tall ? 44 : 38) * u, fill: MUTED }));

  parts.push(pill(c, k, { top: (tall ? 240 : 180) * u, height: (tall ? 150 : 130) * u, max: (tall ? 96 : 84) * u }));

  if (k.scorers) {
    parts.push(tiles(c, match, k));
    return parts;
  }
  const nameY = tall ? (k.score ? 820 : 1020) * u : (k.score ? 600 : 680) * u;
  parts.push(line(c, k.name, { y: nameY, size: (tall ? 150 : 180) * u, fill: TEXT }));
  parts.push(line(c, k.details, { y: nameY + 100 * u, size: (tall ? 52 : 54) * u, fill: MUTED }));
  if (k.score && tall) parts.push(scoreTile(c, match, k.score, { x: c.margin, y: 1240 * u, width: w - 2 * c.margin, height: 520 * u }));
  else if (k.score) parts.push(scorePlate(c, match, k.score, { x: (w - 1500 * u) / 2, y: 830 * u, width: 1500 * u, height: 150 * u, nameSize: 60 * u, scoreSize: 100 * u }));
  return parts;
}

/** The title and the minute in a rounded block of the colour, in the middle of the card's width: the title at its left end, the minute at its right. */
function pill(c, k, { top, height, max }) {
  const { u, w } = c;
  const fill = k.colour ?? TEXT;
  const ink = readableOn(fill);
  const gap = k.minute ? 50 * u : 0;
  const size = fitSize(`${k.title}${k.minute}`, max, w - 2 * c.margin - 140 * u - gap);
  const width = textWidth(`${k.title}${k.minute}`, size) + gap + 140 * u;
  const base = top + height / 2 + size * 0.36;
  const parts = [box((w - width) / 2, top, width, height, fill, height / 2)];
  if (k.minute) {
    parts.push(text(k.title, { x: (w - width) / 2 + 70 * u, y: base, size, anchor: 'start', fill: ink }));
    parts.push(text(k.minute, { x: (w + width) / 2 - 70 * u, y: base, size, anchor: 'end', fill: ink }));
  } else {
    parts.push(text(k.title, { x: w / 2, y: base, size, anchor: 'middle', fill: ink }));
  }
  return parts.join('');
}

/** Full time, a tile for each team: its name, its score, its scorers. Side by side, or stacked in the tall card. */
function tiles(c, match, k) {
  const { u, w } = c;
  const tall = c.portrait;
  const width = tall ? w - 2 * c.margin : 810 * u;
  const height = (tall ? 640 : 630) * u;
  const spots = tall
    ? [{ x: c.margin, y: 470 * u }, { x: c.margin, y: 1170 * u }]
    : [{ x: c.margin, y: 350 * u }, { x: w - c.margin - width, y: 350 * u }];
  const [max, lineSize, step] = tall ? [3, 46 * u, 64 * u] : [4, 40 * u, 52 * u];
  return ['home', 'away'].map((team, i) => {
    const { x, y } = spots[i];
    const middle = x + width / 2;
    const room = width - 80 * u;
    return [
      box(x, y, width, height, PANEL),
      box(x, y, width, 18 * u, safeColour(match.colours[team])),
      text(teamName(match, team).toUpperCase(), { x: middle, y: y + 120 * u, size: namesSize(match, 68 * u, room), anchor: 'middle', fill: TEXT }),
      text(String(k.score[team]), { x: middle, y: y + (tall ? 370 : 360) * u, size: 250 * u, anchor: 'middle', fill: TEXT }),
      ...k.scorers[team].slice(0, max).map((value, n) => line(c, value, { x: middle, y: y + (tall ? 450 : 440) * u + n * step, size: lineSize, fill: MUTED, maxWidth: room })),
    ].join('');
  }).join('');
}

/** The score on one plate: a team's name each side of it, and the two colours at the plate's ends. */
function scorePlate(c, match, score, { x, y, width, height, nameSize, scoreSize }) {
  const u = c.u;
  const end = 24 * u;
  const middle = x + width / 2;
  const label = `${score.home} – ${score.away}`;
  const half = textWidth(label, scoreSize) / 2 + 50 * u;
  const room = width / 2 - half - end - 30 * u;
  const size = namesSize(match, nameSize, room);
  const name = (team, at, anchor) => text(teamName(match, team).toUpperCase(), {
    x: at, y: y + height / 2 + size * 0.36, size, anchor, fill: score.lit && score.lit !== team ? MUTED : TEXT,
  });
  return [
    box(x, y, width, height, PANEL),
    box(x, y, end, height, safeColour(match.colours.home)),
    box(x + width - end, y, end, height, safeColour(match.colours.away)),
    name('home', middle - half, 'end'),
    text(label, { x: middle, y: y + height / 2 + scoreSize * 0.36, size: scoreSize, anchor: 'middle', fill: TEXT }),
    name('away', middle + half, 'start'),
  ].join('');
}

/** The score on a tile, for the tall card: home name, the score, away name, a colour along the top and the bottom. */
function scoreTile(c, match, score, { x, y, width, height }) {
  const u = c.u;
  const edge = 18 * u;
  const middle = x + width / 2;
  const scoreSize = 200 * u;
  const size = namesSize(match, 70 * u, width - 80 * u);
  const name = (team, at) => text(teamName(match, team).toUpperCase(), {
    x: middle, y: at, size, anchor: 'middle', fill: score.lit && score.lit !== team ? MUTED : TEXT,
  });
  return [
    box(x, y, width, height, PANEL),
    box(x, y, width, edge, safeColour(match.colours.home)),
    box(x, y + height - edge, width, edge, safeColour(match.colours.away)),
    name('home', y + 125 * u),
    text(`${score.home} – ${score.away}`, { x: middle, y: y + height / 2 + scoreSize * 0.36, size: scoreSize, anchor: 'middle', fill: TEXT }),
    name('away', y + height - 75 * u),
  ].join('');
}

// --- Lower strip ----------------------------------------------------------------
// The way a broadcast writes it: everything in bars in the lower part of the picture, the
// title on a tab above the name. The upper part is left free, with the title very large and
// faint, so a video behind the card shows there.

function strip(c, match, k) {
  const { u, w } = c;
  const tall = c.portrait;
  const x = c.margin;
  const right = w - c.margin;
  const width = right - x;
  const parts = [];

  const faint = fitSize(k.title, (tall ? 400 : 330) * u, width);
  parts.push(text(k.title, { x, y: (tall ? 700 : 400) * u, size: faint, anchor: 'start', fill: TEXT, opacity: 0.07 }));
  parts.push(line(c, k.header, { x, y: (tall ? 150 : 110) * u, size: (tall ? 44 : 38) * u, anchor: 'start', fill: MUTED }));

  const tabHeight = (tall ? 130 : 110) * u;
  const tabSize = (tall ? 84 : 72) * u;
  const barHeight = 170 * u;

  if (k.scorers) {
    const top = (tall ? 910 : 560) * u;
    parts.push(tab(c, k, { x, y: top - tabHeight, height: tabHeight, size: tabSize }));
    if (tall) {
      parts.push(rowsPlate(c, match, k.score, { x, y: top, width, height: 330 * u }));
      // Stacked lists need a label each, or nobody can tell whose scorers they are.
      [['home', 1340 * u], ['away', 1620 * u]].forEach(([team, y]) => {
        const lines = k.scorers[team].slice(0, 3);
        if (lines.length > 0) parts.push(line(c, teamName(match, team).toUpperCase(), { x, y, size: 40 * u, anchor: 'start', fill: TEXT }));
        lines.forEach((value, n) => parts.push(line(c, value, { x, y: y + (n + 1) * 62 * u, size: 46 * u, anchor: 'start', fill: MUTED })));
      });
    } else {
      parts.push(scorePlate(c, match, k.score, { x, y: top, width, height: barHeight, nameSize: 64 * u, scoreSize: 110 * u }));
      const middle = w / 2;
      const gutter = 60 * u;
      [['home', middle - gutter, 'end'], ['away', middle + gutter, 'start']].forEach(([team, at, anchor]) => {
        k.scorers[team].slice(0, 4).forEach((value, n) => {
          parts.push(line(c, value, { x: at, anchor, y: top + barHeight + 90 * u + n * 56 * u, size: 44 * u, fill: MUTED, maxWidth: middle - gutter - x }));
        });
      });
    }
    return parts;
  }

  // Without the score the bars stand lower, so the free part of the picture stays in one piece.
  const top = tall ? (k.score ? 1150 : 1480) * u : (k.score ? 590 : 760) * u;
  parts.push(tab(c, k, { x, y: top - tabHeight, height: tabHeight, size: tabSize }));
  parts.push(box(x, top, width, barHeight, PANEL));
  if (k.name) {
    const size = fitSize(k.name, (tall ? 100 : 110) * u, width - 88 * u);
    parts.push(text(k.name, { x: x + 44 * u, y: top + barHeight / 2 + size * 0.36, size, anchor: 'start', fill: TEXT }));
  }
  parts.push(line(c, k.details, { x, y: top + barHeight + 70 * u, size: 48 * u, anchor: 'start', fill: MUTED }));
  if (k.score && tall) parts.push(rowsPlate(c, match, k.score, { x, y: 1450 * u, width, height: 330 * u }));
  else if (k.score) parts.push(scorePlate(c, match, k.score, { x, y: 880 * u, width, height: 120 * u, nameSize: 54 * u, scoreSize: 84 * u }));
  return parts;
}

/** The title on a block of the team's colour, and the minute on a pale block joined to it. */
function tab(c, k, { x, y, height, size }) {
  const u = c.u;
  const fill = k.colour ?? TEXT;
  const base = y + height / 2 + size * 0.36;
  const titleWidth = textWidth(k.title, size) + 80 * u;
  const parts = [
    box(x, y, titleWidth, height, fill),
    text(k.title, { x: x + 40 * u, y: base, size, anchor: 'start', fill: readableOn(fill) }),
  ];
  if (k.minute) {
    parts.push(box(x + titleWidth, y, textWidth(k.minute, size) + 60 * u, height, TEXT));
    parts.push(text(k.minute, { x: x + titleWidth + 30 * u, y: base, size, anchor: 'start', fill: readableOn(TEXT) }));
  }
  return parts.join('');
}

/** The two score rows on a plate, for the tall card. */
function rowsPlate(c, match, score, { x, y, width, height }) {
  const u = c.u;
  const nameSize = 64 * u;
  return [
    box(x, y, width, height, PANEL),
    scoreRows(c, match, score, { x: x + 40 * u, right: x + width - 44 * u, y: y + 95 * u + 0.36 * nameSize, step: 140 * u, nameSize, digitSize: 100 * u }),
  ].join('');
}

// --- Both logos -------------------------------------------------------------------
// The two clubs' icons with the score: between them on the wide card, under them on the tall
// one, each with its club's name. The title and the minute are in a pill at the top. A red
// card without the score shows only the sent-off player's club.

function crests(c, match, k) {
  const { u, w } = c;
  const tall = c.portrait;
  const parts = [];
  parts.push(line(c, k.header, { y: (tall ? 150 : 110) * u, size: (tall ? 44 : 38) * u, fill: MUTED }));
  parts.push(pill(c, k, { top: (tall ? 220 : 160) * u, height: (tall ? 150 : 120) * u, max: (tall ? 96 : 78) * u }));

  const xs = tall ? [290 * u, 790 * u] : [400 * u, w - 400 * u];
  const room = (tall ? 440 : 600) * u;
  const label = k.score ? `${k.score.home} – ${k.score.away}` : '';
  // The score stands between the two icons where the card is wide enough, and under them otherwise.
  const scoreLine = ({ y, iconSize, under }) => {
    const size = fitSize(label, 230 * u, tall ? w - 2 * c.margin : xs[1] - xs[0] - iconSize - 180 * u);
    return text(label, { x: w / 2, y: tall ? under : y + 0.36 * size, size, anchor: 'middle', fill: TEXT });
  };

  if (k.scorers) {
    const [y, iconSize] = tall ? [640 * u, 340 * u] : [470 * u, 280 * u];
    parts.push(clubs(c, match, k.score, { xs, y, size: iconSize, room, nameSize: (tall ? 52 : 54) * u }));
    parts.push(scoreLine({ y, iconSize, under: 1150 * u }));
    const [first, step, lineSize, max] = tall ? [1290 * u, 62 * u, 42 * u, 4] : [780 * u, 54 * u, 42 * u, 4];
    ['home', 'away'].forEach((team, i) => k.scorers[team].slice(0, max).forEach((value, n) => {
      parts.push(line(c, value, { x: xs[i], y: first + n * step, size: lineSize, fill: MUTED, maxWidth: room }));
    }));
    return parts;
  }

  const nameY = (tall ? 580 : 430) * u;
  parts.push(line(c, k.name, { y: nameY, size: 130 * u, fill: TEXT }));
  parts.push(line(c, k.details, { y: nameY + (tall ? 95 : 85) * u, size: (tall ? 52 : 48) * u, fill: MUTED }));
  if (k.score) {
    const [y, iconSize] = tall ? [980 * u, 320 * u] : [745 * u, 270 * u];
    parts.push(clubs(c, match, k.score, { xs, y, size: iconSize, room, nameSize: (tall ? 52 : 50) * u }));
    parts.push(scoreLine({ y, iconSize, under: 1480 * u }));
  } else {
    parts.push(icon(c, match, k.team, { x: w / 2, y: (tall ? 1180 : 770) * u, size: (tall ? 400 : 300) * u }));
  }
  return parts;
}

/** The two clubs side by side: each one's icon, its name under it, and a bar of its colour under the name. */
function clubs(c, match, score, { xs, y, size, room, nameSize }) {
  const u = c.u;
  const fitted = namesSize(match, nameSize, room);
  const base = y + size / 2 + 30 * u + 0.72 * nameSize;
  return ['home', 'away'].map((team, i) => {
    const name = teamName(match, team).toUpperCase();
    const bar = Math.max(120 * u, textWidth(name, fitted));
    return [
      icon(c, match, team, { x: xs[i], y, size }),
      text(name, { x: xs[i], y: base, size: fitted, anchor: 'middle', fill: score.lit && score.lit !== team ? MUTED : TEXT }),
      box(xs[i] - bar / 2, base + 18 * u, bar, 12 * u, safeColour(match.colours[team])),
    ].join('');
  }).join('');
}

// --- Team logo --------------------------------------------------------------------
// The icon of the club the card is about, large on a panel of its own: the left part of the
// wide card, the top of the tall one. The title, the minute, the name and the details stand
// beside or under it, and the score is on a plate with both clubs' icons, small. Full time
// belongs to both clubs, so it is a row for each: icon, name, scorers, score.

function badge(c, match, k) {
  const { u, w, h } = c;
  const tall = c.portrait;
  const x = c.margin;
  const right = w - c.margin;
  const parts = [];
  const tabHeight = (tall ? 130 : 110) * u;
  const tabAt = (left, y, room) => tab(c, k, { x: left, y, height: tabHeight, size: fitSize(`${k.title}${k.minute}`, (tall ? 84 : 72) * u, room - 140 * u) });

  if (k.scorers) {
    parts.push(line(c, k.header, { x, y: (tall ? 150 : 110) * u, size: (tall ? 44 : 38) * u, anchor: 'start', fill: MUTED }));
    parts.push(tabAt(x, (tall ? 220 : 150) * u, right - x));
    parts.push(tall
      ? clubBlocks(c, match, k, { x, right, tops: [470 * u, 1130 * u] })
      : clubRows(c, match, k, { x, right, tops: [330 * u, 670 * u] }));
    return parts;
  }

  if (tall) {
    const panel = 700 * u;
    parts.push(box(0, 0, w, panel, PANEL), box(0, panel - 18 * u, w, 18 * u, k.colour));
    parts.push(line(c, k.header, { y: 120 * u, size: 40 * u, fill: MUTED }));
    parts.push(icon(c, match, k.team, { x: w / 2, y: 390 * u, size: 400 * u }));
    // Without the score the words stand lower, in the middle of the room under the panel.
    const top = (k.score ? 780 : 960) * u;
    parts.push(tabAt(x, top, right - x));
    parts.push(line(c, k.name, { x, y: top + 310 * u, size: 120 * u, anchor: 'start', fill: TEXT }));
    parts.push(line(c, k.details, { x, y: top + 400 * u, size: 50 * u, anchor: 'start', fill: MUTED }));
    if (k.score) parts.push(crestRows(c, match, k.score, { x, y: 1330 * u, width: right - x, height: 380 * u }));
    return parts;
  }

  // The plate with the score runs under everything, so the panel ends above it.
  const panel = 640 * u;
  const panelHeight = k.score ? 830 * u : h;
  parts.push(box(0, 0, panel, panelHeight, PANEL), box(panel - 18 * u, 0, 18 * u, panelHeight, k.colour));
  parts.push(icon(c, match, k.team, { x: (panel - 18 * u) / 2, y: panelHeight / 2, size: 400 * u }));
  const left = panel + 80 * u;
  const width = right - left;
  const top = (k.score ? 200 : 330) * u;
  parts.push(line(c, k.header, { x: left, y: 130 * u, size: 38 * u, anchor: 'start', fill: MUTED, maxWidth: width }));
  parts.push(tabAt(left, top, width));
  parts.push(line(c, k.name, { x: left, y: top + 280 * u, size: 130 * u, anchor: 'start', fill: TEXT, maxWidth: width }));
  parts.push(line(c, k.details, { x: left, y: top + 365 * u, size: 50 * u, anchor: 'start', fill: MUTED, maxWidth: width }));
  if (k.score) parts.push(crestPlate(c, match, k.score, { x, y: 870 * u, width: right - x, height: 130 * u }));
  return parts;
}

/** The score on one plate, wide: a club's icon at each end, its name beside the score, its colour along the bottom of its half. */
function crestPlate(c, match, score, { x, y, width, height }) {
  const u = c.u;
  const middle = x + width / 2;
  const small = height - 30 * u;
  const inset = 25 * u + small / 2;
  const scoreSize = 96 * u;
  const label = `${score.home} – ${score.away}`;
  const half = textWidth(label, scoreSize) / 2 + 50 * u;
  const size = namesSize(match, 56 * u, width / 2 - half - 25 * u - small - 40 * u);
  const name = (team, at, anchor) => text(teamName(match, team).toUpperCase(), {
    x: at, y: y + height / 2 + size * 0.36, size, anchor, fill: score.lit && score.lit !== team ? MUTED : TEXT,
  });
  return [
    box(x, y, width, height, PANEL),
    box(x, y + height, width / 2, 10 * u, safeColour(match.colours.home)),
    box(middle, y + height, width / 2, 10 * u, safeColour(match.colours.away)),
    icon(c, match, 'home', { x: x + inset, y: y + height / 2, size: small }),
    icon(c, match, 'away', { x: x + width - inset, y: y + height / 2, size: small }),
    name('home', middle - half, 'end'),
    text(label, { x: middle, y: y + height / 2 + scoreSize * 0.36, size: scoreSize, anchor: 'middle', fill: TEXT }),
    name('away', middle + half, 'start'),
  ].join('');
}

/** The score as two rows on a plate, tall: a club's colour at the plate's edge, its icon, its name, its goals at the right. */
function crestRows(c, match, score, { x, y, width, height }) {
  const u = c.u;
  const small = 120 * u;
  const digitSize = 100 * u;
  const nameX = x + 50 * u + small + 30 * u;
  const end = x + width - 44 * u;
  const size = namesSize(match, 64 * u, end - nameX - textWidth('00', digitSize) - 40 * u);
  return [
    box(x, y, width, height, PANEL),
    ...['home', 'away'].map((team, i) => {
      const middle = y + height / 4 + i * height / 2;
      const fill = score.lit && score.lit !== team ? MUTED : TEXT;
      return [
        box(x, y + i * height / 2, 14 * u, height / 2, safeColour(match.colours[team])),
        icon(c, match, team, { x: x + 50 * u + small / 2, y: middle, size: small }),
        text(teamName(match, team).toUpperCase(), { x: nameX, y: middle + 0.36 * size, size, anchor: 'start', fill }),
        text(String(score[team]), { x: end, y: middle + 0.36 * digitSize, size: digitSize, anchor: 'end', fill }),
      ].join('');
    }),
  ].join('');
}

/** Full time, wide: a row for each club, with its icon, a bar of its colour, its name, its scorers, and its score large at the right. */
function clubRows(c, match, k, { x, right, tops }) {
  const u = c.u;
  const iconSize = 240 * u;
  const digitSize = 200 * u;
  const nameSize = 76 * u;
  const textX = x + iconSize + 72 * u;
  const width = right - textX - textWidth('00', digitSize) - 50 * u;
  const size = namesSize(match, nameSize, width);
  return ['home', 'away'].map((team, i) => {
    const top = tops[i];
    const nameY = top + 0.72 * nameSize;
    return [
      icon(c, match, team, { x: x + iconSize / 2, y: top + iconSize / 2, size: iconSize }),
      box(x + iconSize + 30 * u, top, 12 * u, iconSize, safeColour(match.colours[team])),
      text(teamName(match, team).toUpperCase(), { x: textX, y: nameY, size, anchor: 'start', fill: TEXT }),
      text(String(k.score[team]), { x: right, y: top + iconSize / 2 + 0.36 * digitSize, size: digitSize, anchor: 'end', fill: TEXT }),
      ...k.scorers[team].slice(0, 4).map((value, n) => line(c, value, { x: textX, y: nameY + 18 * u + (n + 1) * 50 * u, size: 40 * u, anchor: 'start', fill: MUTED, maxWidth: width })),
    ].join('');
  }).join('');
}

/** Full time, tall: a block for each club, its icon and its score on one line, then its name and its scorers beside a bar of its colour. */
function clubBlocks(c, match, k, { x, right, tops }) {
  const u = c.u;
  const iconSize = 200 * u;
  const digitSize = 200 * u;
  const nameSize = 72 * u;
  const inset = 44 * u;
  const width = right - x - inset;
  const size = namesSize(match, nameSize, width);
  return ['home', 'away'].map((team, i) => {
    const top = tops[i];
    const capTop = top + iconSize + 50 * u;
    const nameY = capTop + 0.72 * nameSize;
    const lines = k.scorers[team].slice(0, 3);
    return [
      icon(c, match, team, { x: x + iconSize / 2, y: top + iconSize / 2, size: iconSize }),
      text(String(k.score[team]), { x: right, y: top + iconSize / 2 + 0.36 * digitSize, size: digitSize, anchor: 'end', fill: TEXT }),
      box(x, capTop, 14 * u, 0.72 * nameSize + (lines.length > 0 ? 24 * u + lines.length * 62 * u : 0), safeColour(match.colours[team])),
      text(teamName(match, team).toUpperCase(), { x: x + inset, y: nameY, size, anchor: 'start', fill: TEXT }),
      ...lines.map((value, n) => line(c, value, { x: x + inset, y: nameY + 18 * u + (n + 1) * 62 * u, size: 46 * u, anchor: 'start', fill: MUTED, maxWidth: width })),
    ].join('');
  }).join('');
}

/** One size for both team names, the largest at which the longer one fits, so the two look equal. */
function namesSize(match, size, room) {
  return Math.min(...['home', 'away'].map((team) => fitSize(teamName(match, team).toUpperCase(), size, room)));
}

/** A filled rectangle. Never the card's own background, which only `frame` draws. */
function box(x, y, width, height, fill, radius = 0) {
  const corners = radius ? ` rx="${round(radius)}"` : '';
  return `<rect x="${round(x)}" y="${round(y)}" width="${round(width)}" height="${round(height)}"${corners} fill="${fill}"></rect>`;
}
