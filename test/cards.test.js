import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readLibrary, removeClub, removeLeague, saveClub, saveLeague, startingLibrary } from '../src/cards/clubs.js';
import { GOAL_TYPES, isIcon, minuteLabel, THUMBNAIL_SIZE } from '../src/cards/config.js';
import { deleteMatch, listMatches, newMatchId, parseMatch, readMatch, saveCardPng, saveMatch, scorersFromGoals } from '../src/cards/match.js';
import { fitSize, textWidth } from '../src/cards/measure.js';
import { matchScore, movingLogo, movingLogoPicture, renderCard, thumbnail, THUMBNAIL_STREAMERS } from '../src/cards/templates.js';
import { run } from '../src/run.js';

const match = {
  id: 'barca-vs-united', home: 'FC Barcelona', away: 'Manchester United', competition: 'Champions League', date: '19 Nov 2026',
  colours: { home: '#a50044', away: '#da291c' },
};
const goal = { id: 'g1', type: 'goal', team: 'home', scorer: 'Robert Lewandowski', assist: 'Lamine Yamal', minute: 45, added: 2, goalType: 'header', homeScore: 1, awayScore: 0 };
const red = { id: 'r1', type: 'red', team: 'away', player: 'Lisandro Martínez', minute: 67, added: null, redType: 'second-yellow', showScore: true, homeScore: 2, awayScore: 1 };
const fullTime = { id: 'f1', type: 'fulltime', homeScore: 3, awayScore: 1, homeScorers: ["Lewandowski 12', 45+2'"], awayScorers: ["Fernandes 60' (pen)"] };
// The smallest PNG there is, written the way an icon is stored: one clear pixel.
const ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
// A stripe of the mown pitch behind a card.
const STRIPE = '#12211b';
const texts = (svg) => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);

describe('card templates', () => {
  it.each([
    ['landscape', 1920, 1080],
    ['portrait', 1080, 1920],
  ])('draws every kind of card at the %s size', (size, width, height) => {
    for (const card of [goal, red, fullTime]) {
      const svg = renderCard({ match, card, size });
      expect(svg).toMatch(new RegExp(`^<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"`));
      expect(svg.endsWith('</svg>')).toBe(true);
    }
  });

  it('puts the goal details on a goal card', () => {
    const shown = texts(renderCard({ match, card: goal, size: 'landscape' }));
    expect(shown).toEqual(expect.arrayContaining(['CHAMPIONS LEAGUE  ·  19 NOV 2026', 'GOAL', '45+2&#39;', 'Robert Lewandowski', 'Header  ·  Assist: Lamine Yamal', 'FC BARCELONA', '1 – 0', 'MANCHESTER UNITED']));
  });

  it('leaves the assist out for a penalty and an own goal, even when one is typed in', () => {
    for (const goalType of ['penalty', 'own-goal']) {
      const svg = renderCard({ match, card: { ...goal, goalType }, size: 'landscape' });
      expect(svg).not.toContain('Assist');
    }
    expect(texts(renderCard({ match, card: { ...goal, goalType: 'own-goal' }, size: 'portrait' }))).toContain('OWN GOAL');
  });

  it('shows a red card with the team and type, and the score only when asked', () => {
    const shown = texts(renderCard({ match, card: red, size: 'landscape' }));
    expect(shown).toEqual(expect.arrayContaining(['RED CARD', '67&#39;', 'Lisandro Martínez', 'Manchester United  ·  Second yellow', '2 – 1']));
    expect(texts(renderCard({ match, card: { ...red, showScore: false }, size: 'landscape' }))).not.toContain('2 – 1');
  });

  it('lists the scorers on a full-time card', () => {
    const shown = texts(renderCard({ match, card: fullTime, size: 'portrait' }));
    expect(shown).toEqual(expect.arrayContaining(['FULL TIME', '3 – 1', 'Lewandowski 12&#39;, 45+2&#39;', 'Fernandes 60&#39; (pen)']));
  });

  it('shows a club icon the owner added, and the team\'s first letter on its colour when there is none', () => {
    const without = renderCard({ match, card: goal, size: 'landscape' });
    expect(without).not.toContain('<image');
    expect((without.match(/<circle/g) ?? []).length).toBe(2);
    expect(without).toContain('fill="#a50044"');
    expect(texts(without)).toEqual(expect.arrayContaining(['F', 'M']));

    const withIcons = renderCard({ match: { ...match, icons: { home: ICON, away: '' } }, card: goal, size: 'landscape' });
    expect((withIcons.match(/<image /g) ?? []).length).toBe(1);
    expect(withIcons).toContain(`<image href="${ICON}"`);
    expect((withIcons.match(/<circle/g) ?? []).length).toBe(1);
  });

  it('draws nothing as an icon that is not a plain PNG written as text', () => {
    for (const bad of ['javascript:alert(1)', 'https://example.com/crest.png', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', `${ICON}" onload="x`, 'data:image/png;base64,', 7]) {
      expect(isIcon(bad), String(bad)).toBe(false);
      const svg = renderCard({ match: { ...match, icons: { home: bad, away: '' } }, card: goal, size: 'landscape' });
      expect(svg).not.toContain('<image');
      expect(svg).not.toContain('onload');
      expect(svg).not.toContain('example.com');
    }
    expect(isIcon(ICON)).toBe(true);
    expect(isIcon(`data:image/png;base64,${'A'.repeat(400_000)}`)).toBe(false); // too large to keep with a match
  });

  // Two icons that differ, so a test can tell whose is drawn: the one clear pixel, and the same file with a spare byte of padding.
  const AWAY_ICON = ICON.replace('AAAABJRU5ErkJggg==', 'AAAABJRU5ErkJgggAA');
  const withIcons = { ...match, icons: { home: ICON, away: AWAY_ICON } };
  const pictures = (svg) => [...svg.matchAll(/<image href="([^"]*)" x="([\d.-]+)" y="([\d.-]+)" width="([\d.]+)" height="([\d.]+)"/g)]
    .map(([, href, x, y, width, height]) => ({ href, x: Number(x), y: Number(y), width: Number(width), height: Number(height) }));
  const SIZES = [['landscape', 1920, 1080], ['portrait', 1080, 1920]];

  it('says the same things on the wide and the tall card', () => {
    const says = [
      [goal, ['CHAMPIONS LEAGUE  ·  19 NOV 2026', 'GOAL', '45+2&#39;', 'Robert Lewandowski', 'Header  ·  Assist: Lamine Yamal', 'FC BARCELONA', '1 – 0', 'MANCHESTER UNITED']],
      [{ ...goal, goalType: 'own-goal' }, ['OWN GOAL', 'Own goal', 'Robert Lewandowski', '1 – 0']],
      [red, ['RED CARD', '67&#39;', 'Lisandro Martínez', 'Manchester United  ·  Second yellow', 'FC BARCELONA', '2 – 1', 'MANCHESTER UNITED']],
      [fullTime, ['FULL TIME', 'FC BARCELONA', '3 – 1', 'MANCHESTER UNITED', 'Lewandowski 12&#39;, 45+2&#39;', 'Fernandes 60&#39; (pen)']],
    ];
    for (const [size] of SIZES) {
      for (const [card, words] of says) expect(texts(renderCard({ match, card, size })), `${size} ${card.type}`).toEqual(expect.arrayContaining(words));
      expect(renderCard({ match, card: { ...goal, goalType: 'penalty' }, size })).not.toContain('Assist');
      // A red card without the score names one club, the player's, and shows no number but the minute.
      const quiet = texts(renderCard({ match, card: { ...red, showScore: false }, size }));
      expect(quiet).not.toContain('2 – 1');
      expect(quiet).not.toContain('FC BARCELONA');
    }
  });

  it('shows both clubs\' icons on a goal, red and full-time card: only the owner\'s pictures, and a letter on the team\'s colour without one', () => {
    for (const [size, width, height] of SIZES) {
      for (const card of [goal, { ...goal, team: 'away', goalType: 'own-goal' }, red, { ...red, showScore: false }, fullTime]) {
        const where = `${size} ${card.type}`;
        const svg = renderCard({ match: withIcons, card, size });
        const drawn = pictures(svg);
        // Every picture in the card is one of the match's two icons, whole and inside the card, and no larger than 400.
        expect((svg.match(/<image /g) ?? []).length, where).toBe(drawn.length);
        for (const picture of drawn) {
          expect([ICON, AWAY_ICON], where).toContain(picture.href);
          expect(picture.x, where).toBeGreaterThanOrEqual(0);
          expect(picture.y, where).toBeGreaterThanOrEqual(0);
          expect(picture.x + picture.width, where).toBeLessThanOrEqual(width);
          expect(picture.y + picture.height, where).toBeLessThanOrEqual(height);
          expect(picture.width, where).toBeLessThanOrEqual(400);
          expect(picture.height).toBe(picture.width);
        }
        // Nothing that could clash when several cards are put into one page.
        expect(svg).not.toMatch(/<defs|<clipPath|Gradient| id="/);
        // Without the score there is no second club: only the sent-off player's.
        const quiet = card.type === 'red' && !card.showScore;
        expect(drawn.map((picture) => picture.href), where).toEqual(quiet ? [AWAY_ICON] : [ICON, AWAY_ICON]);
        // Without an icon the card is whole: a disc of the team's colour with its first letter.
        const plain = renderCard({ match, card, size });
        expect(plain, where).not.toContain('<image');
        expect((plain.match(/<circle /g) ?? []).length, where).toBe(drawn.length);
        const one = renderCard({ match: { ...match, icons: { home: '', away: AWAY_ICON } }, card, size });
        expect(pictures(one).every((picture) => picture.href === AWAY_ICON), where).toBe(true);
        // Something that is not a plain PNG written as text is never drawn.
        expect(renderCard({ match: { ...match, icons: { home: 'https://example.com/crest.png', away: 'data:image/svg+xml;base64,AAAA' } }, card, size }), where).toBe(plain);
      }
    }
  });

  it('draws the goal, red and full-time cards exactly as recorded', () => {
    // Recorded on 2026-11-25, when the intro card and the see-through cards were removed. A larger
    // fingerprint (768 drawings, long names and odd colours among them) was the same before and
    // after that removal. Renew this one only when a card's drawing is changed on purpose: saved
    // matches are redrawn from these functions every time they are saved. The card without its
    // moving logo and the logo by itself are in it too, since a compilation lays one over the other.
    const all = [];
    for (const m of [match, { ...match, icons: { home: ICON, away: '' } }]) {
      for (const card of [goal, { ...goal, team: 'away', goalType: 'own-goal' }, red, { ...red, showScore: false }, fullTime]) {
        for (const [size] of SIZES) all.push(renderCard({ match: m, card, size }), renderCard({ match: m, card, size, still: true }), String(movingLogoPicture({ match: m, card, size })));
      }
    }
    expect(createHash('sha256').update(all.join('\n')).digest('hex')).toBe('931466a9105921ca83689abbd330386cbc3e87e49292bd346a3941e988d36b28');
    // The intro card is gone, and so is the card drawn to lie over a video.
    expect(() => renderCard({ match, card: { id: 'i1', type: 'intro' }, size: 'landscape' })).toThrow(/Unknown kind of card: intro/);
    expect(renderCard({ match, card: goal, size: 'landscape', clear: true })).toBe(renderCard({ match, card: goal, size: 'landscape' }));
  });

  it('uses the colours of the owner\'s channel: its dark green behind every card, its lime for what belongs to neither team', () => {
    for (const card of [goal, red, fullTime]) {
      expect(renderCard({ match, card, size: 'landscape' })).toContain('<rect width="1920" height="1080" fill="#0a1a14"/>');
      expect(renderCard({ match, card, size: 'portrait' })).toContain('<rect width="1080" height="1920" fill="#0a1a14"/>');
    }
    // "FULL TIME" stands on the lime in the dark green; a goal on its team's colour and a red card on red, as before.
    expect(renderCard({ match, card: fullTime, size: 'landscape' })).toMatch(/fill="#c6ff3d"><\/rect><text [^>]*fill="#0a1a14">FULL TIME</);
    expect(renderCard({ match, card: goal, size: 'landscape' })).toMatch(/fill="#a50044"><\/rect><text [^>]*fill="#ffffff">GOAL</);
    expect(renderCard({ match, card: red, size: 'landscape' })).toMatch(/fill="#d0202f"><\/rect><text [^>]*fill="#ffffff">RED CARD</);
  });

  it('knows which logo moves in a compilation, and draws the card without it and the logo by itself', () => {
    for (const [size] of SIZES) {
      for (const card of [goal, { ...goal, team: 'away', goalType: 'own-goal' }, red, { ...red, team: 'home' }, { ...red, showScore: false }]) {
        const where = `${size} ${card.type} ${card.team}`;
        const logo = movingLogo({ card, size });
        // The club the card is about: the one given the goal, or the sent-off player's.
        expect(logo.team, where).toBe(card.team);
        const href = card.team === 'home' ? ICON : AWAY_ICON;
        const drawn = `<image href="${href}" x="${logo.x - logo.size / 2}" y="${logo.y - logo.size / 2}" width="${logo.size}" height="${logo.size}" preserveAspectRatio="xMidYMid meet"/>`;
        // The card without it is the card, less exactly that one icon.
        const whole = renderCard({ match: withIcons, card, size });
        expect(whole.split(drawn).length, where).toBe(2);
        expect(renderCard({ match: withIcons, card, size, still: true }), where).toBe(whole.replace(drawn, ''));
        // Without an icon it is the disc and its letter that go.
        const plain = renderCard({ match, card, size });
        const rest = renderCard({ match, card, size, still: true });
        expect((rest.match(/<circle /g) ?? []).length, where).toBe((plain.match(/<circle /g) ?? []).length - 1);
        expect(texts(rest).length, where).toBe(texts(plain).length - 1);
        // The logo by itself: the same icon at the same size, in the middle of a square with room to lean 10 degrees.
        expect(logo.room % 2, where).toBe(0);
        expect(logo.room, where).toBeGreaterThanOrEqual(logo.size * (Math.cos(Math.PI / 18) + Math.sin(Math.PI / 18)));
        const alone = movingLogoPicture({ match: withIcons, card, size });
        expect(alone.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${logo.room} ${logo.room}" width="${logo.room}" height="${logo.room}"`), where).toBe(true);
        expect(pictures(alone), where).toEqual([{ href, x: (logo.room - logo.size) / 2, y: (logo.room - logo.size) / 2, width: logo.size, height: logo.size }]);
        expect(alone, where).not.toMatch(/<rect|<text/);
        expect(movingLogoPicture({ match, card, size }), where).toMatch(/^<svg [^>]*><circle [^>]*\/><text [^>]*>[FM]<\/text><\/svg>$/);
      }
      // Nothing moves on the card that belongs to both clubs, and asking for it without changes nothing.
      expect(movingLogo({ card: fullTime, size })).toBeNull();
      expect(movingLogoPicture({ match: withIcons, card: fullTime, size })).toBeNull();
      expect(renderCard({ match: withIcons, card: fullTime, size, still: true })).toBe(renderCard({ match: withIcons, card: fullTime, size }));
    }
  });

  it('takes a match\'s score from its full-time card, else from its last goal', () => {
    expect(matchScore({ ...match, cards: [] })).toBeNull();
    expect(matchScore(match)).toBeNull(); // a match with no list of cards at all
    expect(matchScore({ ...match, cards: [goal, red] })).toEqual({ home: 1, away: 0 });
    expect(matchScore({ ...match, cards: [goal, { ...goal, id: 'g2', homeScore: 2, awayScore: 1 }, red] })).toEqual({ home: 2, away: 1 });
    expect(matchScore({ ...match, cards: [fullTime, goal] })).toEqual({ home: 3, away: 1 });
  });

  it('draws the YouTube thumbnail: each half its club\'s bright colour with its logo blurred in it, and both logos, the names and the score in front', () => {
    expect(THUMBNAIL_SIZE).toEqual({ width: 1280, height: 720 });
    const svg = thumbnail({ match: { ...withIcons, cards: [goal, fullTime] } });
    // Drawn on the wide card's 1920 by 1080, which is the thumbnail's shape, and made smaller when exported.
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 1920 1080" width="1920" height="1080"/);
    expect(1920 / 1080).toBeCloseTo(THUMBNAIL_SIZE.width / THUMBNAIL_SIZE.height, 5);
    // Like the full-time card without its title and its scorers.
    expect(texts(svg)).toEqual(['FC BARCELONA', 'MANCHESTER UNITED', '3 – 1']);
    // Two halves, each a picture of its own that shows only what falls inside it: home on the left,
    // in the club's colour, with its logo faint in it.
    const halves = [...svg.matchAll(/<svg x="([\d.]+)" y="0" width="960" height="1080" viewBox="0 0 960 1080"><rect [^>]*fill="(#[0-9a-f]{6})"><\/rect><image href="([^"]*)" x="([\d.-]+)" y="([\d.-]+)" width="([\d.]+)" height="([\d.]+)" preserveAspectRatio="xMidYMid meet" opacity="0\.4" filter="url\(#thumbnail-blur\)"\/><\/svg>/g)];
    expect(halves.map(([, x, colour, href]) => [Number(x), colour, href])).toEqual([[0, '#a50044', ICON], [960, '#da291c', AWAY_ICON]]);
    for (const [x, y, width, height] of halves.map((half) => half.slice(4).map(Number))) {
      // Zoomed in: the logo hangs over every edge of its half by more than the blur reaches (three times 45).
      expect(width).toBe(height);
      for (const over of [-x, -y, x + width - 960, y + height - 1080]) expect(over).toBeGreaterThan(135);
    }
    expect(svg).toContain('<filter id="thumbnail-blur"');
    expect(svg).toContain('<feGaussianBlur stdDeviation="45"/>');
    // Nothing dims the halves: the only see-through things are the logo inside each and the plate behind the score.
    expect((svg.match(/fill-opacity/g) ?? []).length).toBe(1);
    // In front, sharp: both logos, the same icons, drawn after the halves.
    const front = pictures(svg.slice(svg.lastIndexOf('</svg>', svg.length - 7)));
    expect(front.map((picture) => picture.href)).toEqual([ICON, AWAY_ICON]);
    for (const picture of front) expect(picture.width).toBeLessThanOrEqual(440);
    expect(front[0].x + front[0].width).toBeLessThan(960);
    expect(front[1].x).toBeGreaterThan(960);
    // The score stands on a see-through plate of the dark green, between the two logos: white figures with a thin dark edge.
    expect(svg).toMatch(/<rect x="680" y="[\d.]+" width="560" height="300" rx="40" fill="#0a1a14" fill-opacity="0\.45"><\/rect><text x="960" y="[\d.]+" font-size="[\d.]+" text-anchor="middle" stroke="#0a1a14" stroke-width="[\d.]+" stroke-linejoin="round" paint-order="stroke" fill="#ffffff">3 – 1<\/text>/);
    // Both clubs here are dark reds, so their names are white.
    expect(svg).toMatch(/fill="#ffffff">FC BARCELONA</);

    // Without an icon a half is the club's colour alone, and its logo in front is the letter, in that
    // colour, on a disc of what reads on it. On a light club's half the name is dark.
    const plain = thumbnail({ match: { ...match, colours: { home: '#a50044', away: '#ffe600' }, cards: [goal] } });
    expect(plain).not.toContain('<image');
    expect(texts(plain)).toEqual(['F', 'FC BARCELONA', 'M', 'MANCHESTER UNITED', '1 – 0']);
    expect((plain.match(/<svg x=/g) ?? []).length).toBe(2);
    expect(plain).toMatch(/<circle [^>]*fill="#ffffff"\/><text [^>]*fill="#a50044">F</);
    expect(plain).toMatch(/<circle [^>]*fill="#0a1a14"\/><text [^>]*fill="#ffe600">M</);
    expect(plain).toMatch(/fill="#0a1a14">MANCHESTER UNITED</);
    // A match with no score yet shows "V", in the lime.
    expect(thumbnail({ match: { ...match, cards: [red] } })).toMatch(/fill="#c6ff3d">V<\/text><\/svg>$/);
    // Names are escaped here as on a card, an icon that is not a plain PNG is not drawn, and long names stay inside.
    const odd = thumbnail({ match: { ...match, home: 'A<script>&"B', away: 'W'.repeat(80), icons: { home: 'https://example.com/crest.png', away: '' }, cards: [{ ...fullTime, homeScore: 99, awayScore: 99 }] } });
    expect(odd).not.toContain('<script>');
    expect(odd).not.toContain('example.com');
    for (const [, x, fontSize, anchor, words] of odd.matchAll(/<text x="([\d.-]+)" y="[\d.-]+" font-size="([\d.]+)" text-anchor="(\w+)" fill="[^"]*">([^<]*)<\/text>/g)) {
      expect(anchor).toBe('middle');
      const wide = textWidth(words.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'), Number(fontSize));
      expect(Number(x) - wide / 2).toBeGreaterThanOrEqual(0);
      expect(Number(x) + wide / 2).toBeLessThanOrEqual(1920);
    }
  });

  it('shows the video\'s streamers across the top of the thumbnail: their round pictures, without names', () => {
    const game = { ...withIcons, cards: [fullTime] };
    const bare = thumbnail({ match: game });
    // What the streamers add to the picture comes after the score, the last thing drawn without them.
    const added = (svg) => svg.slice(svg.indexOf('</text>', svg.indexOf('3 – 1')));
    const rings = (svg) => [...added(svg).matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)" fill="#141414"\/><circle cx="[\d.]+" cy="[\d.]+" r="[\d.]+" fill="#ffffff"\/>/g)].map((ring) => ring.slice(1).map(Number));
    const three = thumbnail({ match: game, streamers: [{ name: 'StreamerOne', picture: ICON }, { name: ' Big <Fan> TV ', picture: AWAY_ICON }, { name: 'no picture', picture: 'https://example.com/face.png' }] });
    // Three round pictures in the order given, each in a white ring with a dark edge; no name is written.
    expect(rings(three).length).toBe(3);
    expect(pictures(added(three)).map((picture) => picture.href)).toEqual([ICON, AWAY_ICON]);
    expect(three).not.toContain('StreamerOne');
    expect(three).not.toContain('Fan');
    expect(three).not.toContain('example.com');
    // One without a picture is not left out: a dark disc with the first letter of the name.
    expect(texts(three)).toEqual([...texts(bare), 'N']);
    // Each picture sits inside its ring, and the row is in the middle of the picture, above the clubs.
    const [first, second, third] = rings(three);
    expect(first[0] + third[0]).toBeCloseTo(1920, 0);
    expect(second[0]).toBeCloseTo(960, 0);
    for (const picture of pictures(added(three))) {
      expect(picture.width).toBe(picture.height);
      expect(picture.width).toBeLessThan(2 * first[2]);
    }
    const clubs = (svg) => pictures(svg.slice(0, svg.indexOf('3 – 1'))).slice(-2);
    for (const [, y, r] of rings(three)) for (const logo of clubs(three)) expect(y + r).toBeLessThan(logo.y);
    // With streamers the clubs stand lower than without.
    expect(clubs(three)[0].y).toBeGreaterThan(clubs(bare)[0].y);

    // The pictures are one size however few streamers there are: one alone is no larger than each of three.
    const alone = rings(thumbnail({ match: game, streamers: [{ name: 'StreamerOne', picture: ICON }] }));
    expect(alone.length).toBe(1);
    expect(alone[0][2]).toBe(first[2]);
    expect(alone[0][2] * 2).toBeLessThanOrEqual(130);
    expect(alone[0][0]).toBeCloseTo(960, 0);
    // When one line cannot hold them all they go on to the next, each line in the middle, at the
    // usual size, and the last one added is still there.
    const some = (n) => Array.from({ length: n }, (_, i) => ({ name: `Streamer ${i + 1}`, picture: i === n - 1 ? '' : ICON }));
    const fifteen = thumbnail({ match: game, streamers: some(15) });
    const wrapped = rings(fifteen);
    expect(wrapped.length).toBe(15);
    expect(wrapped[0][2]).toBe(first[2]);
    const lines = [...new Set(wrapped.map(([, y]) => y))];
    expect(lines.length).toBe(2);
    for (const y of lines) {
      const line = wrapped.filter((ring) => ring[1] === y);
      expect(line[0][0] - line[0][2]).toBeGreaterThanOrEqual(59);
      expect(line.at(-1)[0] + line.at(-1)[2]).toBeLessThanOrEqual(1861);
      expect(line[0][0] + line.at(-1)[0]).toBeCloseTo(1920, 0);
    }
    expect(texts(fifteen).at(-1)).toBe('S'); // the fifteenth has no picture, and is the last thing drawn
    // More lines than there is room for above the logos: all of them are made smaller together,
    // every streamer is still shown, and the lowest line ends above the logos. Forty at most.
    expect(THUMBNAIL_STREAMERS).toBe(40);
    const crowd = thumbnail({ match: game, streamers: some(45).map((streamer) => ({ ...streamer, picture: ICON })) });
    const small = rings(crowd);
    expect(small.length).toBe(40);
    expect(small[0][2]).toBeLessThan(first[2]);
    for (const [x, y, r] of small) {
      expect(x - r).toBeGreaterThanOrEqual(0);
      expect(x + r).toBeLessThanOrEqual(1920);
      expect(y - r).toBeGreaterThanOrEqual(0);
      for (const logo of clubs(crowd)) expect(y + r).toBeLessThan(logo.y);
    }
    // A streamer with no name is not shown, and with none at all the thumbnail is as without.
    expect(thumbnail({ match: game, streamers: [{ name: '  ' }, { picture: ICON }] })).toBe(bare);
  });

  it('stands every card on a pitch mown in stripes, as the channel\'s banner is: 120 wide, every other one lighter, from the left edge', () => {
    for (const card of [goal, red, fullTime]) {
      for (const [size, width, height] of SIZES) {
        const svg = renderCard({ match, card, size });
        const stripes = [...svg.matchAll(/<rect x="([\d.]+)" y="0" width="([\d.]+)" height="([\d.]+)" fill="#12211b"><\/rect>/g)].map(([, x, w, h]) => [Number(x), Number(w), Number(h)]);
        // Sixteen stripes across the wide card and nine across the tall one, so eight and five lighter ones.
        expect(stripes).toEqual(Array.from({ length: Math.ceil(width / 240) }, (_, i) => [i * 240, 120, height]));
        // They lie straight on the background, under everything else.
        expect(svg.indexOf(`fill="#0a1a14"/><rect x="0" y="0" width="120" height="${height}" fill="${STRIPE}">`)).toBeGreaterThan(0);
        expect(svg.lastIndexOf(STRIPE)).toBeLessThan(svg.search(/<text|<image|<circle/));
      }
    }
  });

  it('keeps every line, icon and disc inside the picture, however long the names', () => {
    const long = { ...match, home: 'Borussia Mönchengladbach Football Club Of The Lower Rhine', away: 'W'.repeat(80) };
    const cards = [
      { ...goal, scorer: 'W'.repeat(80), assist: 'W'.repeat(80), minute: 200, added: 60, homeScore: 99, awayScore: 99 },
      { ...goal, goalType: 'own-goal', minute: 200, added: 60 },
      { ...red, player: 'W'.repeat(80), homeScore: 99, awayScore: 99 },
      { ...red, showScore: false },
      { ...fullTime, homeScore: 99, awayScore: 99, homeScorers: Array(12).fill('W'.repeat(80)), awayScorers: Array(12).fill('W'.repeat(80)) },
    ];
    for (const [size, width, height] of SIZES) {
      for (const card of cards) {
        const svg = renderCard({ match: long, card, size });
        const lines = [...svg.matchAll(/<text x="([\d.-]+)" y="([\d.-]+)" font-size="([\d.]+)" text-anchor="(\w+)" fill="[^"]*">([^<]*)<\/text>/g)];
        expect(lines.length).toBe((svg.match(/<text /g) ?? []).length);
        for (const [, x, y, fontSize, anchor, words] of lines) {
          const wide = textWidth(words.replace(/&#39;/g, "'").replace(/&amp;/g, '&'), Number(fontSize));
          const left = anchor === 'start' ? Number(x) : anchor === 'end' ? Number(x) - wide : Number(x) - wide / 2;
          const where = `${size} ${card.type}: "${words.slice(0, 30)}"`;
          expect(left, where).toBeGreaterThanOrEqual(-1);
          expect(left + wide, where).toBeLessThanOrEqual(width + 1);
          expect(Number(y), where).toBeLessThanOrEqual(height);
          expect(Number(y) - 0.72 * Number(fontSize), where).toBeGreaterThanOrEqual(0);
        }
        for (const [, cx, cy, r] of svg.matchAll(/<circle cx="([\d.-]+)" cy="([\d.-]+)" r="([\d.]+)"/g)) {
          const where = `${size} ${card.type}: a disc`;
          expect(Number(cx) - Number(r), where).toBeGreaterThanOrEqual(0);
          expect(Number(cx) + Number(r), where).toBeLessThanOrEqual(width);
          expect(Number(cy) - Number(r), where).toBeGreaterThanOrEqual(0);
          expect(Number(cy) + Number(r), where).toBeLessThanOrEqual(height);
        }
      }
    }
  });

  it('escapes names, so text cannot break or add to the picture', () => {
    const svg = renderCard({ match: { ...match, home: 'A<script>&"B' }, card: { ...goal, scorer: '<b>Tom & Jerry</b>' }, size: 'landscape' });
    expect(svg).toContain('&lt;b&gt;Tom &amp; Jerry&lt;/b&gt;');
    expect(svg).not.toContain('<script>');
    expect(svg).not.toContain('<b>');
  });

  it('uses a team colour only when it is a plain colour value', () => {
    const svg = renderCard({ match: { ...match, colours: { home: 'red" onload="x', away: '#da291c' } }, card: goal, size: 'landscape' });
    expect(svg).not.toContain('onload');
  });

  it('makes a long name smaller so it fits the card', () => {
    const long = 'Jan Vennegoor of Hesselink the Third of Somewhere';
    const svg = renderCard({ match, card: { ...goal, scorer: long }, size: 'portrait' });
    const size = Number(new RegExp(`font-size="([\\d.]+)"[^>]*>${long}<`).exec(svg)[1]);
    expect(size).toBeLessThan(120);
    expect(textWidth(long, size)).toBeLessThanOrEqual(1080 - 2 * 90);
  });

  it('has an entry for every goal type in the one list', () => {
    expect(GOAL_TYPES.map((type) => type.label)).toEqual(['Open play', 'Penalty', 'Free kick', 'Header', 'Corner', 'Own goal']);
    for (const type of GOAL_TYPES) expect(texts(renderCard({ match, card: { ...goal, goalType: type.id, assist: '' }, size: 'landscape' }))).toContain(type.label);
  });
});

describe('text measuring', () => {
  it('measures with the font the cards use', () => {
    // 908 px was measured from a rendered frame for this text at one em = 77 px, outline excluded: 896.
    expect(Math.abs(textWidth('EVERYTHING HAPPENS', 77) - 896)).toBeLessThanOrEqual(4);
    expect(textWidth('é', 100)).toBe(textWidth('e', 100));
  });

  it('only ever shrinks text', () => {
    expect(fitSize('Short', 100, 1000)).toBe(100);
    expect(fitSize('A much longer line of text', 100, 400)).toBeLessThan(100);
  });

  it('writes minutes the way a card shows them', () => {
    expect([minuteLabel(12, null), minuteLabel(45, 2), minuteLabel(null, null)]).toEqual(["12'", "45+2'", '']);
  });
});

describe('saved matches', () => {
  let dir;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'clipper-cards-'));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('saves, lists, reads and deletes a match with its cards', async () => {
    const saved = await saveMatch(dir, { ...match, cards: [goal, red, fullTime] });
    expect(saved.cards).toHaveLength(3);
    expect((await listMatches(dir)).map((m) => m.id)).toEqual(['barca-vs-united']);
    expect((await readMatch(dir, 'barca-vs-united')).cards[0]).toMatchObject({ scorer: 'Robert Lewandowski', added: 2 });
    expect(await newMatchId(dir, 'FC Barcelona', 'Manchester United')).toBe('fc-barcelona-vs-manchester-united');
    expect(await newMatchId(dir, 'Barca', 'United')).toBe('barca-vs-united-2');
    await deleteMatch(dir, 'barca-vs-united');
    expect(await listMatches(dir)).toEqual([]);
    await expect(readMatch(dir, '../../etc')).rejects.toThrow(/No such match/);
  });

  it('rejects a match that is not well formed', () => {
    expect(() => parseMatch({ ...match, colours: { home: 'red', away: '#000000' } })).toThrow(/colour looks like/);
    expect(() => parseMatch({ ...match, cards: [goal, { ...red, id: 'g1' }] })).toThrow(/share the id/);
    expect(() => parseMatch({ ...match, cards: [{ ...goal, goalType: 'bicycle' }] })).toThrow(/not valid/);
    expect(() => parseMatch({ ...match, id: '../x' })).toThrow(/not valid/);
    // For one day (2026-11-25) a card was saved with a layout. Such a match still opens, and the field is gone from what is read.
    const old = parseMatch({ ...match, cards: [{ ...goal, layout: 'centre' }, { ...red, layout: 'classic' }, { ...fullTime, layout: 'anything at all' }] });
    expect(old.cards.map((card) => 'layout' in card)).toEqual([false, false, false]);
    expect(old.cards[0]).toEqual(parseMatch({ ...match, cards: [goal] }).cards[0]);
    // Any other field nobody knows is still an error.
    expect(() => parseMatch({ ...match, cards: [{ ...goal, colour: 'pink' }] })).toThrow(/not valid/);
    // A match saved while there was an intro card still opens, without it: the cards around it stay, in their order.
    const opened = parseMatch({ ...match, cards: [{ id: 'i1', type: 'intro', showScore: true, homeScore: 3, awayScore: 1 }, goal, { id: 'i2', type: 'intro' }, fullTime] });
    expect(opened.cards.map((card) => card.id)).toEqual(['g1', 'f1']);
    // A match saved before icons existed has none.
    expect(parseMatch({ ...match, cards: [] })).toMatchObject({ icons: { home: '', away: '' }, cards: [] });
    expect(parseMatch({ ...match, icons: { home: ICON, away: '' } }).icons.home).toBe(ICON);
    expect(() => parseMatch({ ...match, icons: { home: 'https://example.com/crest.png', away: '' } })).toThrow(/icon is a PNG/);
    expect(() => parseMatch({ ...match, icons: { home: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', away: '' } })).toThrow(/icon is a PNG/);
  });

  it('keeps a card picture only if it is a PNG of the right size, and drops it with its card', async () => {
    await saveMatch(dir, { ...match, id: 'pngs', cards: [goal] });
    const png = async (size) => {
      const file = path.join(dir, `${size}.png`);
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=navy:s=${size}`, '-frames:v', '1', file]);
      return (await import('node:fs/promises')).readFile(file);
    };
    await saveCardPng(dir, 'pngs', 'g1', 'landscape', await png('1920x1080'));
    await saveCardPng(dir, 'pngs', 'g1', 'portrait', await png('1080x1920'));
    await expect(saveCardPng(dir, 'pngs', 'g1', 'portrait', await png('1920x1080'))).rejects.toThrow(/PNG of 1080x1920/);
    // The two pieces of a card whose logo moves are kept beside it, under their own names.
    await saveCardPng(dir, 'pngs', 'g1', 'landscape', await png('1920x1080'), 'still');
    await saveCardPng(dir, 'pngs', 'g1', 'landscape', await png('324x324'), 'logo');
    const names = ['g1-landscape-logo.png', 'g1-landscape-still.png', 'g1-landscape.png', 'g1-portrait.png'];
    expect((await readdir(path.join(dir, 'matches', 'pngs', 'cards'))).sort()).toEqual(names);
    await expect(saveCardPng(dir, 'pngs', 'g1', 'landscape', await png('1080x1920'))).rejects.toThrow(/PNG of 1920x1080/);
    await expect(saveCardPng(dir, 'pngs', 'g1', 'landscape', Buffer.from('not a picture at all, just some text'))).rejects.toThrow(/PNG of 1920x1080/);
    await expect(saveCardPng(dir, 'pngs', 'nope', 'landscape', await png('1920x1080'))).rejects.toThrow(/No such card/);
    // Saving the match again keeps all of a card's pictures, and clears away the see-through ones
    // (`-clear.png`) a match was saved with while a video could play behind a card.
    const { writeFile } = await import('node:fs/promises');
    for (const left of ['g1-landscape-clear.png', 'g1-landscape-still-clear.png', 'i1-landscape.png']) await writeFile(path.join(dir, 'matches', 'pngs', 'cards', left), 'from before');
    await saveMatch(dir, { ...match, id: 'pngs', cards: [goal] });
    expect((await readdir(path.join(dir, 'matches', 'pngs', 'cards'))).sort()).toEqual(names);

    await saveMatch(dir, { ...match, id: 'pngs', cards: [] });
    expect(await readdir(path.join(dir, 'matches', 'pngs', 'cards'))).toEqual([]);
  }, 60_000);
});

describe('scorersFromGoals', () => {
  it('groups goals by scorer in time order, and marks penalties and own goals', () => {
    const cards = [
      { ...goal, id: 'a', scorer: 'Yamal', minute: 78, added: null, goalType: 'open-play', homeScore: 3, awayScore: 1 },
      { ...goal, id: 'b', scorer: 'Lewandowski', minute: 12, added: null, homeScore: 1, awayScore: 0 },
      { ...goal, id: 'c', team: 'away', scorer: 'Fernandes', minute: 60, added: null, goalType: 'penalty', homeScore: 2, awayScore: 1 },
      { ...goal, id: 'd', scorer: 'Lewandowski', minute: 45, added: 2, homeScore: 2, awayScore: 0 },
      { ...goal, id: 'e', team: 'away', scorer: 'Araújo', minute: 88, added: null, goalType: 'own-goal', homeScore: 3, awayScore: 2 },
      red,
    ];
    expect(scorersFromGoals({ cards })).toEqual({
      homeScorers: ["Lewandowski 12', 45+2'", "Yamal 78'"],
      awayScorers: ["Fernandes 60' (pen)", "Araújo 88' (og)"],
      homeScore: 3,
      awayScore: 2,
    });
    expect(scorersFromGoals({ cards: [] })).toEqual({ homeScorers: [], awayScorers: [], homeScore: 0, awayScore: 0 });
  });
});

describe('leagues and clubs', () => {
  let dir;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'clipper-clubs-'));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('starts with four leagues and their clubs: a name and a colour, no logo', () => {
    const { leagues, clubs } = startingLibrary();
    expect(leagues.map((league) => league.name)).toEqual(['La Liga', 'Premier League', 'Europe', 'Champions League']);
    expect(leagues.map((league) => clubs.filter((club) => club.league === league.id).length)).toEqual([20, 20, 22, 36]);
    expect(new Set(clubs.map((club) => club.id)).size).toBe(98);
    // A club in two leagues is two entries with their own ids and the same colour.
    const madrid = clubs.filter((club) => club.name === 'Real Madrid');
    expect(madrid.map((club) => [club.id, club.league, club.colour])).toEqual([['real-madrid', 'la-liga', '#ffffff'], ['real-madrid-2', 'champions-league', '#ffffff']]);
    expect(clubs.every((club) => /^#[0-9a-f]{6}$/.test(club.colour) && club.icon === '' && club.name.length > 2)).toBe(true);
    expect(clubs.find((club) => club.name === 'Atlético Madrid')).toMatchObject({ id: 'atletico-madrid', league: 'la-liga' });
    // The 2026-27 season: the clubs that came up are in, the ones that went down are out.
    const names = (league) => clubs.filter((club) => club.league === league).map((club) => club.name);
    expect(names('la-liga')).toEqual(expect.arrayContaining(['Deportivo La Coruña', 'Málaga', 'Racing Santander']));
    expect(names('la-liga')).not.toEqual(expect.arrayContaining(['Girona']));
    expect(names('premier-league')).toEqual(expect.arrayContaining(['Coventry City', 'Hull City', 'Ipswich Town']));
    expect(names('premier-league')).not.toEqual(expect.arrayContaining(['Burnley']));
    // "Europe" holds leading clubs of four countries.
    expect(names('europe')).toEqual(expect.arrayContaining(['Inter', 'Como', 'Lazio', 'Paris Saint-Germain', 'Bayern Munich', 'Benfica']));
  });

  it('writes the starting list out the first time, and from then on it is the owner\'s', async () => {
    expect((await readdir(dir)).includes('clubs.json')).toBe(false);
    const first = await readLibrary(dir);
    expect(first.clubs).toHaveLength(98);
    expect((await readdir(dir)).includes('clubs.json')).toBe(true);
    // Deleting a club sticks: the starting list does not come back.
    await removeClub(dir, 'getafe');
    expect((await readLibrary(dir)).clubs.some((club) => club.id === 'getafe')).toBe(false);
  });

  it('adds, renames and deletes a league, taking its clubs with it', async () => {
    const added = await saveLeague(dir, { name: 'Countries' });
    expect(added.leagues.at(-1)).toEqual({ id: 'countries', name: 'Countries' });
    expect((await saveLeague(dir, { name: 'Countries' })).leagues.at(-1).id).toBe('countries-2'); // the same name again gets its own id
    expect((await saveLeague(dir, { id: 'countries', name: 'National teams' })).leagues.find((league) => league.id === 'countries').name).toBe('National teams');
    await expect(saveLeague(dir, { name: '  ' })).rejects.toThrow(/not valid/);
    await expect(saveLeague(dir, { id: 'nowhere', name: 'X' })).rejects.toThrow(/No such league/);

    await saveClub(dir, { name: 'Armenia', league: 'countries', colour: '#d90012' });
    const after = await removeLeague(dir, 'countries');
    expect(after.leagues.some((league) => league.id === 'countries')).toBe(false);
    expect(after.clubs.some((club) => club.name === 'Armenia')).toBe(false);
    expect(after.clubs.filter((club) => club.league === 'europe')).toHaveLength(22); // the others are untouched
    await expect(removeLeague(dir, 'countries')).rejects.toThrow(/No such league/);
  });

  it('keeps a copy of the list as it was before each change, the newest five', async () => {
    const copies = () => readdir(path.join(dir, 'backups', 'clubs')).then((names) => names.sort(), () => []);
    for (let n = 0; n < 7; n++) await saveClub(dir, { id: 'barcelona', colour: `#00000${n}` });
    const kept = await copies();
    expect(kept).toHaveLength(5);
    // The newest copy is the list just before the last change.
    const last = JSON.parse(await readFile(path.join(dir, 'backups', 'clubs', kept.at(-1)), 'utf8'));
    expect(last.clubs.find((club) => club.id === 'barcelona').colour).toBe('#000005');
    expect((await readLibrary(dir)).clubs.find((club) => club.id === 'barcelona').colour).toBe('#000006');
  });

  it('adds a club to a league and changes only what it is told to', async () => {
    const added = await saveClub(dir, { name: 'Real Zaragoza', league: 'la-liga', colour: '#004a99' });
    expect(added.clubs.find((club) => club.id === 'real-zaragoza')).toEqual({ id: 'real-zaragoza', name: 'Real Zaragoza', league: 'la-liga', colour: '#004a99', icon: '' });
    // Clubs are kept in order of name.
    const names = added.clubs.map((club) => club.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));

    const logo = (await saveClub(dir, { id: 'real-zaragoza', icon: ICON })).clubs.find((club) => club.id === 'real-zaragoza');
    expect(logo).toMatchObject({ name: 'Real Zaragoza', colour: '#004a99', icon: ICON });
    const recoloured = (await saveClub(dir, { id: 'real-zaragoza', colour: '#112233' })).clubs.find((club) => club.id === 'real-zaragoza');
    expect(recoloured).toMatchObject({ colour: '#112233', icon: ICON });
    expect((await saveClub(dir, { name: 'Real Zaragoza', league: 'la-liga' })).clubs.at(-1)).toBeDefined(); // a second one of the same name is allowed
    expect((await readLibrary(dir)).clubs.filter((club) => club.name === 'Real Zaragoza').map((club) => club.id).sort()).toEqual(['real-zaragoza', 'real-zaragoza-2']);
  });

  it('refuses a club that is not well formed', async () => {
    await expect(saveClub(dir, { name: 'Nowhere FC', league: 'no-such-league' })).rejects.toThrow(/league that does not exist/);
    await expect(saveClub(dir, { name: '', league: 'la-liga' })).rejects.toThrow(/not valid/);
    await expect(saveClub(dir, { name: 'X', league: 'la-liga', colour: 'red' })).rejects.toThrow(/colour looks like/);
    await expect(saveClub(dir, { id: 'barcelona', icon: 'https://example.com/crest.png' })).rejects.toThrow(/logo is a PNG/);
    await expect(saveClub(dir, { id: 'barcelona', icon: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' })).rejects.toThrow(/logo is a PNG/);
    await expect(saveClub(dir, { id: 'no-such-club', name: 'X' })).rejects.toThrow(/No such club/);
    await expect(removeClub(dir, 'no-such-club')).rejects.toThrow(/No such club/);
    // Nothing above changed the list.
    expect((await readLibrary(dir)).clubs.find((club) => club.id === 'barcelona')).toMatchObject({ name: 'Barcelona', icon: '' });
  });
});
