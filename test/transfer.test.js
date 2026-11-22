// Moving the owner's data between machines: the file that is downloaded, and
// loading it somewhere else without ever losing what is already there.
import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readLibrary, saveClub, startingLibrary } from '../src/cards/clubs.js';
import { run } from '../src/run.js';
import { readSources, saveSources } from '../src/sources.js';
import { acceptEntry, listTransfer } from '../src/transfer/contents.js';
import { isSafePath, readTar, tarSize, tarStream } from '../src/transfer/tar.js';
import { countHere, dataFile, discardWaiting, putInPlace, takeIn, waiting } from '../src/transfer/transfer.js';

// Made at once, since the machines below are named from it while the tests are being read.
const root = mkdtempSync(path.join(os.tmpdir(), 'clipper-transfer-'));
afterAll(() => rm(root, { recursive: true, force: true }));

const collect = async (stream) => {
  const pieces = [];
  for await (const piece of stream) pieces.push(piece);
  return Buffer.concat(pieces);
};
/** Read a tar file held in memory, in small pieces as a network would deliver it. */
async function unpack(bytes) {
  const found = {};
  const pieces = [];
  for (let at = 0; at < bytes.length; at += 700) pieces.push(bytes.subarray(at, at + 700));
  await readTar(Readable.from(pieces), async (name) => {
    const parts = [];
    return { write: async (piece) => void parts.push(Buffer.from(piece)), close: async () => void (found[name] = Buffer.concat(parts)) };
  });
  return found;
}

describe('the tar file', () => {
  const long = `in/${'a-very-long-video-name-'.repeat(7)}.mp4`;
  const entries = [
    { name: 'manifest.json', size: 2, content: Buffer.from('{}') },
    { name: 'data/empty.json', size: 0, content: Buffer.alloc(0) },
    { name: 'data/exactly-one-block.bin', size: 512, content: Buffer.alloc(512, 7) },
    { name: 'sounds/héllo ünïcode.mp3', size: 5, content: Buffer.from('sound') },
    { name: long, size: 1300, content: Buffer.alloc(1300, 65) },
  ];

  it('is as long as it says, reads back byte for byte, and the tar program reads it too', async () => {
    const bytes = await collect(tarStream(entries));
    expect(bytes.length).toBe(tarSize(entries));
    expect(bytes.length % 512).toBe(0);
    const back = await unpack(bytes);
    expect(Object.keys(back)).toEqual(entries.map((entry) => entry.name));
    for (const entry of entries) expect(back[entry.name].equals(entry.content), entry.name).toBe(true);

    const file = path.join(root, 'made.tar');
    await writeFile(file, bytes);
    const { stdout } = await run('tar', ['-tf', file]);
    expect(stdout.trim().split('\n')).toEqual(entries.map((entry) => entry.name));
  });

  it('streams a file from disk, and stops if the file is not what it was', async () => {
    const file = path.join(root, 'video.bin');
    await writeFile(file, Buffer.alloc(100_000, 3));
    const back = await unpack(await collect(tarStream([{ name: 'in/video.mp4', size: 100_000, file }])));
    expect(back['in/video.mp4'].equals(Buffer.alloc(100_000, 3))).toBe(true);
    await expect(collect(tarStream([{ name: 'in/video.mp4', size: 200_000, file }]))).rejects.toThrow(/changed while it was being read/);
  });

  it('knows a name that stays where it is put from one that does not', () => {
    for (const good of ['data/sources.json', 'out/a-clip/work/meta.json', 'in/my video (1).mp4']) expect(isSafePath(good), good).toBe(true);
    for (const bad of ['/etc/passwd', '../x', 'data/../../x', 'data//x', 'data/.env', '.env', 'data\\x', 'a\0b', '', 'data/./x']) expect(isSafePath(bad), bad).toBe(false);
  });

  it('refuses a file that holds a link, a name that leaves its folder, or that ends early', async () => {
    // A link, made by the real tar program.
    const dir = path.join(root, 'with-link');
    await mkdir(path.join(dir, 'data'), { recursive: true });
    await writeFile(path.join(dir, 'data', 'real.json'), '{}');
    await symlink('/etc/passwd', path.join(dir, 'data', 'sources.json'));
    const linked = path.join(root, 'linked.tar');
    await run('tar', ['-cf', linked, '-C', dir, 'data']);
    await expect(unpack(await readFile(linked))).rejects.toThrow(/not a plain file/);

    await expect(unpack(await collect(tarStream([{ name: '../outside.json', size: 2, content: Buffer.from('{}') }])))).rejects.toThrow(/name that cannot be used/);
    await expect(unpack(await collect(tarStream([{ name: '/etc/cron.d/x', size: 2, content: Buffer.from('{}') }])))).rejects.toThrow(/name that cannot be used/);

    const whole = await collect(tarStream(entries));
    await expect(unpack(whole.subarray(0, whole.length - 1024))).rejects.toThrow(/ends before its end mark/);
    await expect(unpack(whole.subarray(0, 3000))).rejects.toThrow(/ends in the middle|ends before/);
    await expect(unpack(Buffer.alloc(2048, 1))).rejects.toThrow(/not a data file made by this tool/);
  });
});

describe('what counts as the owner\'s data', () => {
  it('takes what the owner chose to carry: the lists, pictures, sounds and briefs', () => {
    for (const name of [
      'data/sources.json', 'data/clubs.json', 'data/source-subscribers.json', 'data/source-pictures/north-stand.png',
      'sounds/goal.mp3', 'sounds/intro.mp4', 'briefs/mine.json', 'overlays/kreek-logo.webp', 'overlays/logo.png',
    ]) expect(acceptEntry(name), name).toBe(true);
  });

  it('leaves the rest on the machine: videos, clips, combinations, compilations, matches and cards', () => {
    for (const name of [
      'in/a video.mp4', 'parts/a_1m00s-1m30s.mp4', 'out/first-clip/clip.mp4', 'out/first-clip/work/meta.json',
      'data/combinations/goal/combination.json', 'data/combinations/goal/combined.mp4',
      'data/compilations/reactions/timeline.json', 'data/compilations/reactions/final.mp4',
      'data/matches/home-v-away/match.json', 'data/matches/home-v-away/cards/c1-landscape.png',
    ]) expect(acceptEntry(name), name).toBe(false);
  });

  it('never takes the key, the backups, code, or a name that is not a plain file in its folder', () => {
    for (const name of [
      'data/backups/sources/x.json', 'data/sounds-made/goal-v2.wav', 'data/clubs.before-something.json', 'data/.incoming/files/data/sources.json',
      'env', '.env', 'package.json', 'src/cli.js', 'server/app.js', 'sounds/readme.txt', 'sounds/sub/goal.mp3', 'briefs/notes.txt',
      'overlays/logo.webp:Zone.Identifier', 'overlays/sub/logo.png', 'overlays/notes.txt', 'data/youtube-cookies.txt',
      'data/source-pictures/../../x.png', 'data/sources.json/x',
    ]) expect(acceptEntry(name), name).toBe(false);
  });
});

describe('downloading and loading', () => {
  /** A machine: its folders under one scratch folder. The last three hold what stays local. */
  const machine = (name) => Object.fromEntries(['data', 'sounds', 'briefs', 'in', 'parts', 'out'].map((folder) => [folder, path.join(root, name, folder)]));
  const travelling = ({ data, sounds, briefs }) => ({ data, sounds, briefs });
  const put = async (folders, name, content) => {
    const [folder, ...rest] = name.split('/');
    const file = path.join(folders[folder], ...rest);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  };
  const has = (folders, name) => {
    const [folder, ...rest] = name.split('/');
    return readFile(path.join(folders[folder], ...rest));
  };
  const upload = async (folders, bytes) => takeIn(travelling(folders), Readable.from([bytes]), bytes.length);
  const download = async (folders) => collect((await dataFile(travelling(folders))).stream());
  const channel = (id, clubs = []) => ({ id, name: `Channel ${id}`, url: `https://www.youtube.com/@${id}`, clubs });
  const LOCAL = [
    'data/matches/home-v-away/match.json', 'data/matches/home-v-away/cards/c1-landscape.png', 'data/combinations/goal/combination.json',
    'data/combinations/goal/combined.mp4', 'data/compilations/reactions/timeline.json', 'data/compilations/reactions/final.mp4',
    'in/reaction.mp4', 'parts/reaction_1m00s-1m30s.mp4', 'out/first-clip/clip.mp4',
  ];

  const office = machine('office');
  beforeAll(async () => {
    await saveSources(office.data, [channel('one', ['Barcelona']), channel('two')]);
    await readLibrary(office.data); // writes the starting list out
    await saveClub(office.data, { id: 'barcelona', icon: 'data:image/png;base64,AAAA' });
    // Written as the tool writes it, so that a second load of the same file finds nothing to change.
    await put(office, 'data/source-subscribers.json', `${JSON.stringify({ one: { count: 18000, checked: '2026-11-20T10:00:00.000Z' } }, null, 2)}\n`);
    await put(office, 'data/source-pictures/one.png', 'picture of one');
    await put(office, 'sounds/goal.mp3', 'a shout');
    await put(office, 'sounds/intro.mp4', 'the video behind the intro card');
    await put(office, 'briefs/mine.json', '{"id":"mine"}');
    // What stays local.
    for (const name of LOCAL) await put(office, name, `local: ${name}`);
    await put(office, 'data/backups/sources/older.json', '[]');
    await mkdir(path.join(root, 'office'), { recursive: true });
    await writeFile(path.join(root, 'office', '.env'), 'OPENAI_API_KEY=made-up-not-a-key');
  });

  it('puts in the file exactly what the owner chose, and never the key, the backups or anything that stays local', async () => {
    const names = (await listTransfer(travelling(office))).map((entry) => entry.name).sort();
    expect(names).toEqual([
      'briefs/mine.json', 'data/clubs.json', 'data/source-pictures/one.png', 'data/source-subscribers.json', 'data/sources.json',
      'sounds/goal.mp3', 'sounds/intro.mp4',
    ]);
    // Even when handed every folder, nothing that stays local is taken.
    expect((await listTransfer(office)).map((entry) => entry.name).sort()).toEqual(names);
    const bytes = await download(office);
    expect(bytes.includes('made-up-not-a-key')).toBe(false);
    expect(bytes.includes('local: ')).toBe(false);
    const file = await dataFile(travelling(office));
    expect([file.bytes, file.files, file.name]).toEqual([bytes.length, names.length, expect.stringMatching(/^wlc-clipper-data-\d{4}-\d\d-\d\d\.tar$/)]);
  });

  it('loads into a machine with nothing on it: the same lists, byte for byte, and nothing set aside', async () => {
    const home = machine('home-empty');
    const summary = await upload(home, await download(office));
    expect(summary).toMatchObject({
      replaces: [], passedOver: 0,
      holds: { channels: 2, channelsWithClub: 1, channelPictures: 1, leagues: 4, clubsWithLogo: 1, sounds: 2, briefs: 1 },
      here: { channels: 0, clubs: 0, sounds: 0 },
    });
    expect(summary.holds.clubs).toBe(startingLibrary().clubs.length);
    // Nothing is in place yet: taking a file in changes nothing.
    expect(await readSources(home.data)).toEqual([]);
    expect(await waiting(travelling(home))).toMatchObject({ files: summary.files, holds: summary.holds });

    const report = await putInPlace(travelling(home));
    expect(report).toEqual({ added: summary.files, replaced: 0, same: 0, kept: null });
    for (const entry of await listTransfer(travelling(office))) expect((await has(home, entry.name)).equals(await readFile(entry.file)), entry.name).toBe(true);
    expect(await countHere(travelling(home))).toEqual(await countHere(travelling(office)));
    expect((await readLibrary(home.data)).clubs.find((club) => club.id === 'barcelona').icon).toBe('data:image/png;base64,AAAA');
    expect((await readSources(home.data))[0].clubs).toEqual(['Barcelona']);
    expect(await waiting(travelling(home))).toBeNull();
    // Only what travels arrived: no videos, clips, combinations, compilations or matches.
    expect((await readdir(home.data)).sort()).toEqual(['clubs.json', 'source-pictures', 'source-subscribers.json', 'sources.json']);
    expect(await readdir(home.in).catch(() => [])).toEqual([]);
    // Loading the very same file again changes nothing at all.
    await upload(home, await download(office));
    expect(await putInPlace(travelling(home))).toEqual({ added: 0, replaced: 0, same: summary.files, kept: null });
  });

  it('loads onto a machine that has data: the file wins, what it replaces is kept aside, and what stays local is not touched', async () => {
    const home = machine('home-busy');
    await saveSources(home.data, [channel('three', ['Arsenal']), channel('four'), channel('five')]);
    await readLibrary(home.data);
    await put(home, 'sounds/goal.mp3', 'a DIFFERENT shout with the same name');
    await put(home, 'sounds/only-at-home.wav', 'stays');
    await put(home, 'briefs/mine.json', '{"id":"mine"}'); // the same file as in the data file
    for (const name of LOCAL) await put(home, name, `made at home: ${name}`);

    const summary = await upload(home, await download(office));
    expect(summary.replaces.sort()).toEqual(['data/clubs.json', 'data/sources.json', 'sounds/goal.mp3']);
    expect(summary.here).toMatchObject({ channels: 3, channelsWithClub: 1, sounds: 2 });

    const report = await putInPlace(travelling(home));
    expect(report).toMatchObject({ replaced: 3, same: 1 });
    expect(report.kept).toMatch(/^backups\/before-load-/);
    // The file's lists and sound are in place.
    expect((await readSources(home.data)).map((one) => one.id)).toEqual(['one', 'two']);
    expect((await has(home, 'sounds/goal.mp3')).toString()).toBe('a shout');
    // Everything it replaced is in the folder kept aside, as it was.
    const aside = (name) => readFile(path.join(home.data, report.kept, name), 'utf8');
    expect(JSON.parse(await aside('data/sources.json')).map((one) => one.id)).toEqual(['three', 'four', 'five']);
    expect(JSON.parse(await aside('data/clubs.json')).clubs.find((club) => club.id === 'barcelona').icon).toBe('');
    expect(await aside('sounds/goal.mp3')).toBe('a DIFFERENT shout with the same name');
    // Nothing the file did not hold was touched: the other sound, and everything that stays local.
    expect((await has(home, 'sounds/only-at-home.wav')).toString()).toBe('stays');
    for (const name of LOCAL) expect((await has(home, name)).toString(), name).toBe(`made at home: ${name}`);

    // A second load keeps its own folder.
    await setTimeout(5);
    await saveSources(home.data, [channel('six')]);
    await upload(home, await download(office));
    const second = await putInPlace(travelling(home));
    expect(second.kept).not.toBe(report.kept);
    expect(JSON.parse(await readFile(path.join(home.data, second.kept, 'data/sources.json'), 'utf8')).map((one) => one.id)).toEqual(['six']);
  });

  it('passes over videos, matches and anything else that stays local, even when a file holds them', async () => {
    const home = machine('home-old-file');
    const note = { name: 'manifest.json', content: Buffer.from(JSON.stringify({ tool: 'wlc-clipper', format: 1, made: '2026-11-20T10:00:00.000Z' })) };
    const made = (entries) => collect(tarStream(entries.map((entry) => ({ ...entry, size: entry.content.length }))));
    const file = await made([
      note, { name: 'sounds/ok.mp3', content: Buffer.from('ok') },
      { name: 'in/video.mp4', content: Buffer.from('a video') }, { name: 'data/matches/m/match.json', content: Buffer.from('{}') },
      { name: 'data/compilations/c/timeline.json', content: Buffer.from('{}') }, { name: 'src/cli.js', content: Buffer.from('bad') },
    ]);
    const summary = await upload(home, file);
    expect([summary.files, summary.passedOver]).toEqual([1, 4]);
    expect(await putInPlace(travelling(home))).toMatchObject({ added: 1 });
    expect((await has(home, 'sounds/ok.mp3')).toString()).toBe('ok');
    expect(await readdir(home.in).catch(() => [])).toEqual([]);
    expect(await readdir(path.join(home.data, 'matches')).catch(() => [])).toEqual([]);
  });

  it('changes nothing when the file cannot be trusted or read', async () => {
    const home = machine('home-careful');
    await saveSources(home.data, [channel('mine', ['Chelsea'])]);
    const before = await readFile(path.join(home.data, 'sources.json'), 'utf8');
    const good = await download(office);
    const note = { name: 'manifest.json', content: Buffer.from(JSON.stringify({ tool: 'wlc-clipper', format: 1, made: '2026-11-20T10:00:00.000Z' })) };
    const made = (entries) => collect(tarStream(entries.map((entry) => ({ ...entry, size: entry.content.length }))));

    // A channels list this tool cannot read, a clubs list it cannot read, and a list that is not JSON.
    await expect(upload(home, await made([note, { name: 'data/sources.json', content: Buffer.from('[{"id":"../x","name":"X","url":"nowhere"}]') }]))).rejects.toThrow(/sources list is not valid/);
    await expect(upload(home, await made([note, { name: 'data/clubs.json', content: Buffer.from('{"leagues":"all of them"}') }]))).rejects.toThrow(/list of leagues and clubs is not valid/);
    await expect(upload(home, await made([note, { name: 'data/sources.json', content: Buffer.from('not json') }]))).rejects.toThrow(/could not be read/);
    // Not made by this tool, cut short, the same name twice, and a name that leaves its folder.
    await expect(upload(home, await made([{ name: 'data/sources.json', content: Buffer.from('[]') }]))).rejects.toThrow(/not a data file made by this tool/);
    await expect(upload(home, good.subarray(0, good.length - 2000))).rejects.toThrow(/ends/);
    await expect(upload(home, await made([note, { name: 'sounds/a.mp3', content: Buffer.from('1') }, { name: 'sounds/a.mp3', content: Buffer.from('2') }]))).rejects.toThrow(/twice/);
    await expect(upload(home, await made([note, { name: '../../outside.json', content: Buffer.from('{}') }]))).rejects.toThrow(/cannot be used/);

    expect(await readFile(path.join(home.data, 'sources.json'), 'utf8')).toBe(before);
    expect((await readdir(home.data)).sort()).toEqual(['sources.json']); // nothing waiting, nothing set aside
    expect(await waiting(travelling(home))).toBeNull();
    await expect(putInPlace(travelling(home))).rejects.toThrow(/No data file is waiting/);

    // A file taken in can be thrown away again, and nothing has changed.
    await upload(home, good);
    await discardWaiting(travelling(home));
    expect(await waiting(travelling(home))).toBeNull();
    expect(await readFile(path.join(home.data, 'sources.json'), 'utf8')).toBe(before);
  });
});
