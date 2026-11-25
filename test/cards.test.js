import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readLibrary, removeClub, removeLeague, saveClub, saveLeague, startingLibrary } from '../src/cards/clubs.js';
import { GOAL_TYPES, isIcon, minuteLabel } from '../src/cards/config.js';
import { deleteMatch, listMatches, newMatchId, parseMatch, readMatch, saveCardPng, saveMatch, scorersFromGoals } from '../src/cards/match.js';
import { fitSize, textWidth } from '../src/cards/measure.js';
import { renderCard } from '../src/cards/templates.js';
import { run } from '../src/run.js';

const match = {
  id: 'barca-vs-united', home: 'FC Barcelona', away: 'Manchester United', competition: 'Champions League', date: '19 Nov 2026',
  colours: { home: '#a50044', away: '#da291c' },
};
const goal = { id: 'g1', type: 'goal', team: 'home', scorer: 'Robert Lewandowski', assist: 'Lamine Yamal', minute: 45, added: 2, goalType: 'header', homeScore: 1, awayScore: 0 };
const red = { id: 'r1', type: 'red', team: 'away', player: 'Lisandro Martínez', minute: 67, added: null, redType: 'second-yellow', showScore: true, homeScore: 2, awayScore: 1 };
const fullTime = { id: 'f1', type: 'fulltime', homeScore: 3, awayScore: 1, homeScorers: ["Lewandowski 12', 45+2'"], awayScorers: ["Fernandes 60' (pen)"] };
const intro = { id: 'i1', type: 'intro', showScore: false, homeScore: 0, awayScore: 0 };
// The smallest PNG there is, written the way an icon is stored: one clear pixel.
const ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const texts = (svg) => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);

describe('card templates', () => {
  it.each([
    ['landscape', 1920, 1080],
    ['portrait', 1080, 1920],
  ])('draws every kind of card at the %s size', (size, width, height) => {
    for (const card of [intro, goal, red, fullTime]) {
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

  it('opens with an intro card: both clubs by name, and "V" or the score between them', () => {
    for (const size of ['landscape', 'portrait']) {
      const plain = texts(renderCard({ match, card: intro, size }));
      expect(plain).toEqual(expect.arrayContaining(['CHAMPIONS LEAGUE  ·  19 NOV 2026', 'FC BARCELONA', 'MANCHESTER UNITED', 'V']));
      const scored = texts(renderCard({ match, card: { ...intro, showScore: true, homeScore: 3, awayScore: 1 }, size }));
      expect(scored).toContain('3 – 1');
      expect(scored).not.toContain('V');
    }
  });

  it('shows a club icon the owner added, and the team\'s first letter on its colour when there is none', () => {
    const without = renderCard({ match, card: intro, size: 'landscape' });
    expect(without).not.toContain('<image');
    expect((without.match(/<circle/g) ?? []).length).toBe(2);
    expect(without).toContain('fill="#a50044"');
    expect(texts(without)).toEqual(expect.arrayContaining(['F', 'M']));

    const withIcons = renderCard({ match: { ...match, icons: { home: ICON, away: '' } }, card: intro, size: 'landscape' });
    expect((withIcons.match(/<image /g) ?? []).length).toBe(1);
    expect(withIcons).toContain(`<image href="${ICON}"`);
    expect((withIcons.match(/<circle/g) ?? []).length).toBe(1);
  });

  it('draws nothing as an icon that is not a plain PNG written as text', () => {
    for (const bad of ['javascript:alert(1)', 'https://example.com/crest.png', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', `${ICON}" onload="x`, 'data:image/png;base64,', 7]) {
      expect(isIcon(bad), String(bad)).toBe(false);
      const svg = renderCard({ match: { ...match, icons: { home: bad, away: '' } }, card: intro, size: 'landscape' });
      expect(svg).not.toContain('<image');
      expect(svg).not.toContain('onload');
      expect(svg).not.toContain('example.com');
    }
    expect(isIcon(ICON)).toBe(true);
    expect(isIcon(`data:image/png;base64,${'A'.repeat(400_000)}`)).toBe(false); // too large to keep with a match
  });

  it('draws the same card with a see-through background, to lie over a video', () => {
    for (const card of [intro, goal, red, fullTime]) {
      const solid = renderCard({ match, card, size: 'landscape' });
      const clear = renderCard({ match, card, size: 'landscape', clear: true });
      expect(solid).not.toContain('fill-opacity');
      // The intro card has one more see-through thing: the plate behind its score.
      const plates = clear.match(/<rect [^>]*fill-opacity="[^>]*><\/rect>/g) ?? [];
      expect(plates.length).toBe(card.type === 'intro' ? 1 : 0);
      expect((clear.match(/fill-opacity="0\.\d+"/g) ?? []).length).toBe(1 + plates.length);
      // Nothing else differs: the words and where they sit are the same.
      expect(texts(clear)).toEqual(texts(solid));
      expect(clear.replace(plates[0] ?? '', '').replace(/ fill-opacity="[^"]*"/, '')).toBe(solid);
    }
  });

  it('puts a dark plate behind the intro card\'s score when a video plays behind it, wide enough for the score', () => {
    for (const size of ['landscape', 'portrait']) {
      for (const card of [intro, { ...intro, showScore: true, homeScore: 3, awayScore: 1 }, { ...intro, showScore: true, homeScore: 10, awayScore: 12 }]) {
        const svg = renderCard({ match, card, size, clear: true });
        const [, x, y, width, height] = /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" rx=/.exec(svg).map(Number);
        const middle = card.showScore ? `${card.homeScore} – ${card.awayScore}` : 'V';
        const [, textX, textY, fontSize] = new RegExp(`<text x="([\\d.]+)" y="([\\d.]+)" font-size="([\\d.]+)"[^>]*>${middle}</text>`).exec(svg).map(Number);
        // Centred on the text, around its glyphs, and drawn before it.
        expect(x + width / 2).toBeCloseTo(textX, 0);
        expect(y).toBeLessThan(textY - fontSize * 0.72);
        expect(y + height).toBeGreaterThan(textY);
        expect(svg.indexOf('<rect x=')).toBeLessThan(svg.indexOf(`>${middle}</text>`));
        // In the wide card it stays between the two club icons (each 400 wide, 560 from the middle).
        if (size === 'landscape') expect(width / 2).toBeLessThan(560 - 200);
      }
    }
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
        // Every picture in the card is one of the match's two icons, whole and inside the card, and no larger than the intro card draws it.
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
        // Without an icon the card is whole: a disc of the team's colour with its first letter, as on the intro card.
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

  it('draws the intro card exactly as recorded', () => {
    // Recorded on 2026-11-25, after the cards took the colours of the owner's channel artwork.
    // Before that change the fingerprint was the one of the commit before the goal, red and
    // full-time cards were redrawn (4e4aa22), and with every colour taken out the intro card was
    // still the same as then: only colours had changed. Renew it only when the intro card is
    // changed on purpose: saved matches are redrawn from these functions every time they are saved.
    const all = [];
    for (const m of [match, { ...match, icons: { home: ICON, away: '' } }]) {
      for (const card of [intro, { ...intro, showScore: true, homeScore: 3, awayScore: 1 }]) {
        for (const [size] of SIZES) for (const clear of [false, true]) all.push(renderCard({ match: m, card, size, clear }));
      }
    }
    expect(createHash('sha256').update(all.join('\n')).digest('hex')).toBe('ad9a6fee0ac4465dfb31fe8170fa92cda1092d62869a9dac80840169fbf026cd');
  });

  it('uses the colours of the owner\'s channel: its dark green behind every card, its lime for what belongs to neither team', () => {
    for (const card of [intro, goal, red, fullTime]) {
      expect(renderCard({ match, card, size: 'landscape' })).toContain('<rect width="1920" height="1080" fill="#0a1a14"/>');
      expect(renderCard({ match, card, size: 'portrait', clear: true })).toContain('<rect width="1080" height="1920" fill="#0a1a14" fill-opacity="0.45"/>');
    }
    // "FULL TIME" stands on the lime in the dark green; a goal on its team's colour and a red card on red, as before.
    expect(renderCard({ match, card: fullTime, size: 'landscape' })).toMatch(/fill="#c6ff3d"><\/rect><text [^>]*fill="#0a1a14">FULL TIME</);
    expect(renderCard({ match, card: goal, size: 'landscape' })).toMatch(/fill="#a50044"><\/rect><text [^>]*fill="#ffffff">GOAL</);
    expect(renderCard({ match, card: red, size: 'landscape' })).toMatch(/fill="#d0202f"><\/rect><text [^>]*fill="#ffffff">RED CARD</);
    expect(renderCard({ match, card: intro, size: 'landscape' })).toMatch(/fill="#c6ff3d">V</);
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
    const old = parseMatch({ ...match, cards: [{ ...goal, layout: 'centre' }, { ...red, layout: 'classic' }, { ...fullTime, layout: 'anything at all' }, intro] });
    expect(old.cards.map((card) => 'layout' in card)).toEqual([false, false, false, false]);
    expect(old.cards[0]).toEqual(parseMatch({ ...match, cards: [goal] }).cards[0]);
    // Any other field nobody knows is still an error.
    expect(() => parseMatch({ ...match, cards: [{ ...goal, colour: 'pink' }] })).toThrow(/not valid/);
    // A match saved before icons existed has none, and an intro card needs nothing but its id.
    expect(parseMatch({ ...match, cards: [{ id: 'i1', type: 'intro' }] })).toMatchObject({ icons: { home: '', away: '' }, cards: [intro] });
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
    // The see-through picture is kept beside the ordinary one, under its own name, and held to the same size.
    await saveCardPng(dir, 'pngs', 'g1', 'landscape', await png('1920x1080'), true);
    await expect(saveCardPng(dir, 'pngs', 'g1', 'portrait', await png('1920x1080'), true)).rejects.toThrow(/PNG of 1080x1920/);
    expect((await readdir(path.join(dir, 'matches', 'pngs', 'cards'))).sort()).toEqual(['g1-landscape-clear.png', 'g1-landscape.png', 'g1-portrait.png']);
    // Saving the match again keeps all of a card's pictures.
    await saveMatch(dir, { ...match, id: 'pngs', cards: [goal] });
    expect(await readdir(path.join(dir, 'matches', 'pngs', 'cards'))).toHaveLength(3);
    await expect(saveCardPng(dir, 'pngs', 'g1', 'landscape', await png('1080x1920'))).rejects.toThrow(/PNG of 1920x1080/);
    await expect(saveCardPng(dir, 'pngs', 'g1', 'landscape', Buffer.from('not a picture at all, just some text'))).rejects.toThrow(/PNG of 1920x1080/);
    await expect(saveCardPng(dir, 'pngs', 'nope', 'landscape', await png('1920x1080'))).rejects.toThrow(/No such card/);
    expect((await readdir(path.join(dir, 'matches', 'pngs', 'cards'))).sort()).toEqual(['g1-landscape-clear.png', 'g1-landscape.png', 'g1-portrait.png']);

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
