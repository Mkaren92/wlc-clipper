import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GOAL_TYPES, minuteLabel } from '../src/cards/config.js';
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
    await expect(saveCardPng(dir, 'pngs', 'g1', 'landscape', await png('1080x1920'))).rejects.toThrow(/PNG of 1920x1080/);
    await expect(saveCardPng(dir, 'pngs', 'g1', 'landscape', Buffer.from('not a picture at all, just some text'))).rejects.toThrow(/PNG of 1920x1080/);
    await expect(saveCardPng(dir, 'pngs', 'nope', 'landscape', await png('1920x1080'))).rejects.toThrow(/No such card/);
    expect((await readdir(path.join(dir, 'matches', 'pngs', 'cards'))).sort()).toEqual(['g1-landscape.png', 'g1-portrait.png']);

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
