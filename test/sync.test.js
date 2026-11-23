// Syncing the owner's data between machines through a repository. The
// "GitHub" here is a bare repository in a scratch folder: nothing in these
// tests touches the network or the owner's own data.
import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readLibrary, saveClub } from '../src/cards/clubs.js';
import { run } from '../src/run.js';
import { readSources, saveSources, setSourceClubs } from '../src/sources.js';
import { githubRepo } from '../src/sync/git.js';
import { joinLogos, splitLogos } from '../src/sync/logos.js';
import { mergeLibrary, mergeRecords, mergeSources, mergeSubscribers } from '../src/sync/merge.js';
import { createSync } from '../src/sync/sync.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'clipper-sync-'));
afterAll(() => rm(root, { recursive: true, force: true }));
const sh = (args, cwd) => run('git', args, { cwd, env: { GIT_TERMINAL_PROMPT: '0' } });
// A tiny real PNG, as text the way a logo is kept in the clubs list.
const PNG = `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]).toString('base64')}`;

describe('logos as files', () => {
  it('takes each logo out of the list into a file named by what it shows, and puts them back the same', async () => {
    const list = `${JSON.stringify({ leagues: [{ id: 'a', name: 'A' }], clubs: [
      { id: 'one', name: 'Öne', league: 'a', colour: '#112233', icon: PNG },
      { id: 'one-2', name: 'Öne', league: 'a', colour: '#112233', icon: PNG }, // the same club in a second league
      { id: 'two', name: 'Two', league: 'a', colour: '#445566', icon: '' },
    ] }, null, 2)}\n`;
    const { text, logos } = splitLogos(list);
    expect(logos.size).toBe(1); // one file for the logo both entries share
    expect(text).not.toContain('base64');
    expect(JSON.parse(text).clubs.map((club) => club.icon)).toEqual([expect.stringMatching(/^file:[0-9a-f]{32}\.png$/), expect.stringMatching(/^file:/), '']);
    expect(await joinLogos(text, async (name) => logos.get(name) ?? null)).toBe(list);
    // A logo file that did not arrive is refused; it must never quietly become "no logo".
    await expect(joinLogos(text, async () => null)).rejects.toThrow(/logo of Öne is missing/);
  });
});

describe('putting two changed lists together', () => {
  const rec = (id, value) => ({ id, value });
  const base = [rec('a', 1), rec('b', 1), rec('c', 1)];

  it('takes each record from the machine that changed it', () => {
    const here = [rec('a', 2), rec('b', 1), rec('c', 1), rec('new-here', 1)];
    const there = [rec('a', 1), rec('b', 5), rec('new-there', 1)]; // c was removed there
    const { merged, clashes } = mergeRecords(base, here, there, (one) => one.id);
    expect(clashes).toEqual([]);
    expect(merged).toEqual([rec('a', 2), rec('b', 5), rec('new-there', 1), rec('new-here', 1)]);
  });

  it('names a record changed on both, keeps the other machine\'s, and never drops one that was changed', () => {
    const { merged, clashes } = mergeRecords(base, [rec('a', 2), rec('b', 7), rec('c', 1)], [rec('a', 3), rec('c', 1)], (one) => one.id);
    expect(clashes.sort()).toEqual(['a', 'b']);
    expect(merged).toEqual([rec('a', 3), rec('c', 1), rec('b', 7)]); // b: removed there, changed here, so kept
    // Changed the same way on both is no clash.
    expect(mergeRecords(base, [rec('a', 9), rec('b', 1), rec('c', 1)], [rec('a', 9), rec('b', 1), rec('c', 1)], (one) => one.id).clashes).toEqual([]);
    // With nothing to compare against, a record that differs is a clash, and one that is the same is not.
    expect(mergeRecords(null, [rec('a', 1), rec('b', 2)], [rec('a', 1), rec('b', 3)], (one) => one.id)).toEqual({ merged: [rec('a', 1), rec('b', 3)], clashes: ['b'] });
  });

  it('merges channels, leagues with their clubs, and subscriber counts', () => {
    const channel = (id, clubs = []) => ({ id, name: id, clubs });
    expect(mergeSources([channel('x')], [channel('x', ['A'])], [channel('x'), channel('y')])).toEqual({ merged: [channel('x', ['A']), channel('y')], clashes: [] });
    expect(mergeSources([channel('x')], [channel('x', ['A'])], [channel('x', ['B'])]).clashes).toEqual(['channel x']);

    const league = (id) => ({ id, name: id });
    const club = (id, in_, colour = '#000000') => ({ id, name: id, league: in_, colour, icon: '' });
    const was = { leagues: [league('l1'), league('l2')], clubs: [club('c1', 'l1'), club('c2', 'l2')] };
    const mine = { leagues: [league('l1'), league('l2')], clubs: [club('c1', 'l1', '#ff0000'), club('c2', 'l2'), club('c3', 'l2')] };
    const theirs = { leagues: [league('l1')], clubs: [club('c1', 'l1')] }; // the league l2 and its club were removed there
    const result = mergeLibrary(was, mine, theirs);
    expect(result.merged.leagues).toEqual([league('l1')]);
    expect(result.merged.clubs).toEqual([club('c1', 'l1', '#ff0000')]); // the club added here to the removed league goes with it
    expect(result.clashes).toEqual([]);

    expect(mergeSubscribers({ a: { count: 1, checked: '2026-01-02' }, b: { count: 5, checked: '2026-01-01' } }, { a: { count: 2, checked: '2026-01-01' }, c: { count: 9, checked: '2026-01-01' } }))
      .toEqual({ a: { count: 1, checked: '2026-01-02' }, b: { count: 5, checked: '2026-01-01' }, c: { count: 9, checked: '2026-01-01' } });
  });
});

describe('a repository address', () => {
  it('is read in the three ways GitHub writes it, and nothing else', () => {
    for (const address of ['git@github.com:someone/my-data.git', 'https://github.com/someone/my-data', 'ssh://git@github.com/someone/my-data.git', ' https://github.com/someone/my-data.git/ ']) {
      expect(githubRepo(address), address).toEqual({ owner: 'someone', name: 'my-data' });
    }
    for (const address of ['', 'my-data', '/tmp/repo', 'git@gitlab.com:someone/x.git', 'https://github.com/someone', 'https://github.com/someone/x/y', '--upload-pack=evil', 'git@github.com:someone/x.git; rm -rf /']) {
      expect(githubRepo(address), address).toBeNull();
    }
  });
});

describe('syncing two machines', () => {
  const github = path.join(root, 'github.git');
  const code = path.join(root, 'code');
  /** A machine: its folders, and its sync. */
  const machine = (name) => {
    const folders = Object.fromEntries(['data', 'sounds', 'briefs', 'overlays'].map((folder) => [folder, path.join(root, name, folder)]));
    const hooks = { pause: null };
    return { folders, hooks, sync: createSync({ folders, codeDir: code, anyAddress: true, pause: async () => hooks.pause?.() }) };
  };
  const put = async ({ folders }, name, content) => {
    const [folder, ...rest] = name.split('/');
    await mkdir(path.join(folders[folder], ...rest.slice(0, -1)), { recursive: true });
    await writeFile(path.join(folders[folder], ...rest), content);
  };
  const has = ({ folders }, name) => {
    const [folder, ...rest] = name.split('/');
    return readFile(path.join(folders[folder], ...rest), 'utf8').catch(() => null);
  };
  const channel = (id, clubs = []) => ({ id, name: `Channel ${id} é`, url: `https://www.youtube.com/@${id}`, clubs });
  const clubsOf = async (one) => Object.fromEntries((await readSources(one.folders.data)).map((source) => [source.id, source.clubs.join('+')]));
  /** What the repository holds at its newest state. */
  const onGithub = async () => (await sh(['-C', github, 'ls-tree', '-r', '--name-only', 'main'])).stdout.trim().split('\n').filter(Boolean);

  const office = machine('office');
  const home = machine('home');

  beforeAll(async () => {
    await sh(['init', '-q', '--bare', '-b', 'main', github]);
    // The project's own repository, standing in for the public one with the code.
    await sh(['init', '-q', '-b', 'main', code]);
    await sh(['-C', code, 'remote', 'add', 'origin', 'git@github.com:someone/the-code.git']);

    await saveSources(office.folders.data, [channel('one', ['Barcelona']), channel('two'), channel('three')]);
    await readLibrary(office.folders.data);
    await saveClub(office.folders.data, { id: 'barcelona', icon: PNG });
    await put(office, 'data/source-subscribers.json', `${JSON.stringify({ one: { count: 18000, checked: '2026-11-20T10:00:00.000Z' } }, null, 2)}\n`);
    await put(office, 'data/source-pictures/one.png', 'picture of one');
    await put(office, 'sounds/goal.mp3', 'a shout');
    await put(office, 'sounds/intro.mp4', 'the video behind the intro card');
    await put(office, 'briefs/mine.json', '{"id":"mine"}');
    // Things that must never leave the machine.
    await put(office, 'data/youtube-cookies.txt', 'a sign-in, as good as a password');
    await put(office, 'data/backups/sources/older.json', '[]');
    await put(office, 'data/compilations/c/timeline.json', '{}');
    await writeFile(path.join(root, 'office', '.env'), 'OPENAI_API_KEY=made-up-not-a-key');
  });

  it('refuses the code\'s own repository, and an address that is not GitHub\'s unless told otherwise', async () => {
    const strict = createSync({ folders: office.folders, codeDir: code });
    await expect(strict.look('git@github.com:someone/the-code.git')).rejects.toThrow(/repository with the tool's code/);
    await expect(strict.look('https://github.com/SomeOne/The-Code')).rejects.toThrow(/repository with the tool's code/);
    await expect(strict.look(github)).rejects.toThrow(/Give the repository's address as GitHub shows it/);
    await expect(strict.connect('--upload-pack=evil')).rejects.toThrow(/as GitHub shows it/);
    expect(await strict.state()).toEqual({ connected: false });
  });

  it('sends the first machine\'s data to an empty repository: what travels, logos as files, and nothing private', async () => {
    expect(await office.sync.look(github)).toMatchObject({ empty: true, there: null, here: { channels: 3, channelsWithClub: 1, clubsWithLogo: 1, sounds: 2, briefs: 1 } });
    expect(await office.sync.state()).toEqual({ connected: false }); // looking does not connect
    await office.sync.connect(github);
    expect(await office.sync.state()).toMatchObject({ connected: true, remote: github });

    const names = await onGithub();
    expect(names).toEqual(expect.arrayContaining(['data/sources.json', 'data/clubs.json', 'data/source-subscribers.json', 'data/source-pictures/one.png', 'sounds/goal.mp3', 'sounds/intro.mp4', 'briefs/mine.json']));
    expect(names.filter((name) => name.startsWith('data/club-logos/'))).toHaveLength(1);
    expect(names.filter((name) => /cookies|backups|compilations|\.env|\.sync/.test(name))).toEqual([]);
    const everything = (await sh(['-C', github, 'log', '-p', '--all'])).stdout;
    expect(everything).not.toContain('made-up-not-a-key');
    expect(everything).not.toContain('as good as a password');
    expect(everything).not.toContain('base64'); // the list on GitHub holds no pictures
    // Nothing was done to the code's own repository.
    expect((await sh(['-C', code, 'status', '--porcelain'])).stdout).toBe('');
    await expect(sh(['-C', code, 'log', '--oneline'])).rejects.toThrow();
  });

  it('connects a second machine that takes GitHub\'s data: identical lists, its own lists kept aside, its own files kept', async () => {
    // The second machine starts with its own channel and a sound of its own.
    await saveSources(home.folders.data, [channel('home-only')]);
    await readLibrary(home.folders.data);
    await put(home, 'sounds/only-at-home.wav', 'stays');
    const look = await home.sync.look(github);
    expect(look).toMatchObject({ empty: false, there: { channels: 3, channelsWithClub: 1, clubsWithLogo: 1, sounds: 2 }, here: { channels: 1, clubsWithLogo: 0, sounds: 1 } });
    await expect(home.sync.connect(github)).rejects.toThrow(/Say which side to keep/);
    expect((await readSources(home.folders.data)).map((one) => one.id)).toEqual(['home-only']); // nothing changed yet

    const result = await home.sync.connect(github, 'github');
    expect(result.arrived).toEqual(expect.arrayContaining(['data/sources.json', 'data/clubs.json', 'sounds/goal.mp3']));
    for (const name of ['data/sources.json', 'data/clubs.json', 'data/source-subscribers.json', 'data/source-pictures/one.png', 'sounds/intro.mp4', 'briefs/mine.json']) {
      expect(await has(home, name), name).toBe(await has(office, name)); // byte for byte, the logo written back into the list
    }
    expect((await readLibrary(home.folders.data)).clubs.find((club) => club.id === 'barcelona').icon).toBe(PNG);
    // Its own list from before is kept for good; its own sound stays, and goes to GitHub for the other machine.
    const aside = (await readdir(path.join(home.folders.data, 'backups'))).find((name) => name.startsWith('before-connect-'));
    expect(JSON.parse(await readFile(path.join(home.folders.data, 'backups', aside, 'data', 'sources.json'), 'utf8')).map((one) => one.id)).toEqual(['home-only']);
    expect(await has(home, 'sounds/only-at-home.wav')).toBe('stays');
    expect(await onGithub()).toContain('sounds/only-at-home.wav');
    expect((await office.sync.sync()).arrived).toEqual(['sounds/only-at-home.wav']);
    expect(await has(office, 'sounds/only-at-home.wav')).toBe('stays');
  });

  it('carries a change from one machine to the other, both ways, and does nothing when nothing changed', async () => {
    expect(await home.sync.sync()).toMatchObject({ state: 'synced', sent: false, arrived: [], setAside: [], clashes: [] });
    const mark = await office.sync.fingerprint();
    await setSourceClubs(office.folders.data, 'two', ['Arsenal']);
    expect(await office.sync.fingerprint()).not.toBe(mark); // a cheap sign that something changed here
    expect(await home.sync.behind()).toBe(false);
    expect(await office.sync.sync()).toMatchObject({ state: 'synced', sent: true, arrived: [] });
    expect(await home.sync.behind()).toBe(true); // a cheap sign that GitHub has something new
    expect(await home.sync.sync()).toMatchObject({ sent: false, arrived: ['data/sources.json'], clashes: [] });
    expect(await clubsOf(home)).toEqual({ one: 'Barcelona', two: 'Arsenal', three: '' });

    await saveClub(home.folders.data, { id: 'arsenal', icon: PNG, colour: '#ff0000' });
    await home.sync.sync();
    expect((await office.sync.sync()).arrived).toEqual(['data/clubs.json']);
    expect((await readLibrary(office.folders.data)).clubs.find((club) => club.id === 'arsenal')).toMatchObject({ icon: PNG, colour: '#ff0000' });
    expect(await has(office, 'data/clubs.json')).toBe(await has(home, 'data/clubs.json'));
  });

  it('puts together changes made on both machines before either synced', async () => {
    // Different channels changed on each, and each added a channel: all four changes survive.
    await setSourceClubs(office.folders.data, 'one', ['Real Madrid']);
    await saveSources(office.folders.data, [...(await readSources(office.folders.data)), channel('from-office')]);
    await setSourceClubs(home.folders.data, 'three', ['Chelsea']);
    await saveSources(home.folders.data, [...(await readSources(home.folders.data)), channel('from-home')]);
    await put(office, 'sounds/office.wav', 'made at the office');
    await put(home, 'sounds/home.wav', 'made at home');

    expect(await office.sync.sync()).toMatchObject({ sent: true, clashes: [] });
    const merged = await home.sync.sync(); // this one finds GitHub changed, and its own changes too
    expect(merged).toMatchObject({ state: 'synced', sent: true, clashes: [] });
    expect(merged.arrived.sort()).toEqual(['data/sources.json', 'sounds/office.wav']);
    await office.sync.sync();
    const expected = { one: 'Real Madrid', two: 'Arsenal', three: 'Chelsea', 'from-office': '', 'from-home': '' };
    expect(await clubsOf(home)).toEqual(expected);
    expect(await clubsOf(office)).toEqual(expected);
    expect(await has(office, 'sounds/home.wav')).toBe('made at home');
    expect(await has(home, 'data/sources.json')).toBe(await has(office, 'data/sources.json'));
  });

  it('says so when the same channel was changed on both, keeps the first one sent, and loses neither for good', async () => {
    await setSourceClubs(office.folders.data, 'two', ['Liverpool']);
    await setSourceClubs(home.folders.data, 'two', ['Juventus']);
    await office.sync.sync();
    const result = await home.sync.sync();
    expect(result.clashes).toEqual(['channel two']);
    expect((await clubsOf(home)).two).toBe('Liverpool');
    // The version that lost is in the repository's history, where it can be read back.
    // (--full-history: without it git leaves out the side of a merge whose change did not survive.)
    expect((await sh(['-C', github, 'log', '-p', '--all', '--full-history', '--', 'data/sources.json'])).stdout).toContain('Juventus');
    await office.sync.sync();
    expect((await clubsOf(office)).two).toBe('Liverpool');
  });

  it('removes on the other machine what was removed on one, by setting it aside there', async () => {
    await rm(path.join(office.folders.sounds, 'office.wav'));
    await office.sync.sync();
    const result = await home.sync.sync();
    expect(result.setAside).toEqual(['sounds/office.wav']);
    expect(await has(home, 'sounds/office.wav')).toBeNull();
    const aside = (await readdir(path.join(home.folders.data, 'backups', 'sync'))).sort().at(-1);
    expect(await readFile(path.join(home.folders.data, 'backups', 'sync', aside, 'sounds', 'office.wav'), 'utf8')).toBe('made at the office');
    // It does not come back.
    await office.sync.sync();
    expect(await has(office, 'sounds/office.wav')).toBeNull();
    expect(await onGithub()).not.toContain('sounds/office.wav');
  });

  // The round takes seconds against the real GitHub, and it runs just when the owner is clicking.
  it('keeps what is marked and added here while a round is running, and sends it on', async () => {
    await setSourceClubs(home.folders.data, 'one', ['Milan']);
    await home.sync.sync();
    office.hooks.pause = async () => {
      office.hooks.pause = null;
      await setSourceClubs(office.folders.data, 'three', ['Porto']);
      await put(office, 'sounds/mid.wav', 'added while syncing');
    };
    const result = await office.sync.sync();
    expect(result).toMatchObject({ state: 'synced', setAside: [], clashes: [] });
    expect(await clubsOf(office)).toMatchObject({ one: 'Milan', three: 'Porto' }); // the other PC's change, and this one's
    expect(await has(office, 'sounds/mid.wav')).toBe('added while syncing');
    await home.sync.sync();
    expect(await clubsOf(home)).toMatchObject({ one: 'Milan', three: 'Porto' });
    expect(await has(home, 'sounds/mid.wav')).toBe('added while syncing');
    expect(await office.sync.sync()).toMatchObject({ sent: false, arrived: [], setAside: [] });
  });

  it('changes nothing without the internet, and sends the work on the next try', async () => {
    await rename_(github, `${github}.away`);
    await setSourceClubs(home.folders.data, 'three', ['Inter']);
    expect(await home.sync.sync()).toMatchObject({ state: 'offline', sent: false, arrived: [] });
    expect((await clubsOf(home)).three).toBe('Inter'); // this machine keeps its change
    await rename_(`${github}.away`, github);
    expect(await home.sync.sync()).toMatchObject({ state: 'synced', sent: true });
    await office.sync.sync();
    expect((await clubsOf(office)).three).toBe('Inter');
  });

  it('touches nothing here when what is on GitHub is not a list this tool can read', async () => {
    // Someone edits the list on GitHub by hand and breaks it.
    const hand = path.join(root, 'by-hand');
    await sh(['clone', '-q', github, hand]);
    await writeFile(path.join(hand, 'data', 'sources.json'), '[{"id":"../x","name":"X","url":"nowhere"}]');
    await writeFile(path.join(hand, 'sounds', 'by-hand.wav'), 'added on GitHub');
    await sh(['-C', hand, 'add', '-A']);
    await sh(['-C', hand, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-am', 'broken by hand']);
    await sh(['-C', hand, 'push', '-q', 'origin', 'main']);
    const before = await has(office, 'data/sources.json');
    await expect(office.sync.sync()).rejects.toThrow(/sources list is not valid/);
    expect(await has(office, 'data/sources.json')).toBe(before);
    expect(await has(office, 'sounds/by-hand.wav')).toBeNull(); // not half of it either
    // A round that did not finish must not turn "has not arrived here yet" into "removed here":
    // a change made here now, and another round, send nothing and remove nothing.
    await setSourceClubs(office.folders.data, 'two', ['Benfica']);
    await expect(office.sync.sync()).rejects.toThrow(/not a list this tool can read/);
    expect(await onGithub()).toContain('sounds/by-hand.wav');
    expect((await clubsOf(office)).two).toBe('Benfica');
    // Put right on GitHub, syncing works again.
    await sh(['-C', hand, 'checkout', 'HEAD~1', '--', 'data/sources.json']); // the list only; the sound stays
    await sh(['-C', hand, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'list put right']);
    await sh(['-C', hand, 'push', '-q', 'origin', 'main']);
    expect(await office.sync.sync()).toMatchObject({ state: 'synced', sent: true, setAside: [], arrived: ['sounds/by-hand.wav'] });
    expect(await onGithub()).toContain('sounds/by-hand.wav');
    expect(await has(office, 'sounds/by-hand.wav')).toBe('added on GitHub');
    expect((await clubsOf(office)).two).toBe('Benfica'); // this machine's change was kept, and sent
    await home.sync.sync();
    expect((await clubsOf(home)).two).toBe('Benfica');
  });

  it('refuses to run when its copy of the data is not a repository of its own, so it can never act on the code\'s', async () => {
    const lost = machine('lost');
    await saveSources(lost.folders.data, [channel('x')]);
    await lost.sync.connect(github, 'github');
    await rm(path.join(lost.folders.data, '.sync', 'repo', '.git'), { recursive: true });
    await expect(lost.sync.sync()).rejects.toThrow(/missing or damaged/);
    expect(await lost.sync.state()).toEqual({ connected: false });
    // Disconnecting leaves the machine's data where it is.
    await lost.sync.disconnect();
    expect((await readSources(lost.folders.data)).length).toBeGreaterThan(0);
    expect(await readdir(lost.folders.data)).not.toContain('.sync');
    await expect(lost.sync.sync()).rejects.toThrow(/not connected/);
  });
});

/** Rename a folder, standing in for GitHub going away and coming back. */
async function rename_(from, to) {
  const { rename } = await import('node:fs/promises');
  await rename(from, to);
}
