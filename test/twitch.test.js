// Twitch beside YouTube (added on 2026-11-23): channel addresses, video links, fetching a
// past broadcast, live status, pictures and followers, and chat the owner imports as a
// TwitchDownloader file. A stand-in answers for Twitch and the downloader; nothing here
// reaches Twitch.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clipsFromChat } from '../src/chat/chatClips.js';
import { fetchedOrigin, importChatFile, importStreamChat, partsInFolder, readChat } from '../src/chat/chatStore.js';
import { parseChatFile } from '../src/chat/importChat.js';
import { checkTwitchStream, fetchVideo } from '../src/fetch.js';
import { videoLink, videoUrl, youtubeVideoUrl } from '../src/fetchLink.js';
import { checkLive } from '../src/live.js';
import { channelAddress, checkPictureUrl, fetchPicture, listSubscribers, syncSource } from '../src/pictures.js';
import { run } from '../src/run.js';
import { agreedSourceOf, channelKey, parseSources, siteOf } from '../src/sources.js';
import { twitchChannel } from '../src/twitch.js';

const sources = parseSources([
  { id: 'boeshi', name: 'Boeshi', url: 'https://www.twitch.tv/DaRealBoeshi', status: 'agreed' },
  { id: 'boeshi-yt', name: 'Boeshi YT', url: 'https://www.youtube.com/@darealboeshi', status: 'agreed' },
  { id: 'other', name: 'Other', url: 'https://www.twitch.tv/someoneelse', status: 'asked' },
]);
const vod = 'https://www.twitch.tv/videos/2938193982';

describe('Twitch addresses and links', () => {
  it('reads a Twitch channel from its address, and refuses Twitch pages that are not channels', () => {
    expect(channelKey('https://www.twitch.tv/DaRealBoeshi')).toEqual({ twitch: 'darealboeshi' });
    expect(channelKey('https://twitch.tv/darealboeshi/')).toEqual({ twitch: 'darealboeshi' });
    expect(siteOf('https://m.twitch.tv/darealboeshi')).toBe('twitch');
    expect(siteOf('https://www.youtube.com/@x')).toBe('youtube');
    for (const bad of ['http://www.twitch.tv/x', 'https://www.twitch.tv/videos', 'https://www.twitch.tv/directory', 'https://www.twitch.tv/a/b', 'https://www.twitch.tv/bad-name', 'https://user@www.twitch.tv/x', 'https://www.twitch.tv.evil.example/x']) {
      expect(channelKey(bad), bad).toBeNull();
    }
    // A YouTube address saved with something after it is still read as before.
    expect(channelKey('https://www.youtube.com/@northstandtv?si=abc')).toEqual({ handle: '@northstandtv' });
  });

  it('matches a Twitch video only to the agreed Twitch channel of that login, never to a YouTube one', () => {
    expect(agreedSourceOf(sources, { site: 'twitch', login: 'DaRealBoeshi' })?.id).toBe('boeshi');
    expect(agreedSourceOf(sources, { site: 'twitch', login: 'someoneelse' })).toBeNull(); // not agreed
    expect(agreedSourceOf(sources, { site: 'twitch', login: 'nobody' })).toBeNull();
    // The same name on the other site is a different channel.
    expect(agreedSourceOf(sources, { site: 'twitch', login: '', handle: '@darealboeshi' })).toBeNull();
    expect(agreedSourceOf(sources, { handle: '@darealboeshi', channelId: 'UCx' })?.id).toBe('boeshi-yt');
    expect(agreedSourceOf(sources, { login: 'darealboeshi' })).toBeNull(); // a video that does not say it is Twitch's
  });

  it('takes a link to one past broadcast, rebuilt from its number', () => {
    expect(videoLink(' https://www.twitch.tv/videos/2938193982?t=1h2m ')).toEqual({ site: 'twitch', id: '2938193982', url: vod, fileId: 'tw2938193982' });
    expect(videoUrl('https://m.twitch.tv/videos/2938193982/')).toBe(vod);
    expect(videoLink('https://youtu.be/dQw4w9WgXcQ')).toMatchObject({ site: 'youtube', fileId: 'dQw4w9WgXcQ' });
    for (const bad of ['https://www.twitch.tv/darealboeshi', 'https://www.twitch.tv/videos/abc', 'https://clips.twitch.tv/SomeClip', 'http://www.twitch.tv/videos/1', 'https://www.twitch.tv/videos/1/--exec']) {
      expect(() => videoLink(bad), bad).toThrow(/one Twitch video/);
    }
    // What only YouTube has refuses a Twitch link, and says what to do.
    expect(() => youtubeVideoUrl(vod)).toThrow(/TwitchDownloader/);
  });

  it('builds the channel address from the login in the list', () => {
    expect(channelAddress(sources[0])).toBe('https://www.twitch.tv/darealboeshi');
  });
});

describe('fetching a Twitch past broadcast', () => {
  let dir;
  const calls = [];
  const downloader = (video = {}) => ({
    isInstalled: async () => true,
    info: async () => ({ site: 'twitch', id: 'v2938193982', title: 'Streaming GTA 6', channel: 'darealboeshi', channelId: '', handle: '', login: 'darealboeshi', duration: 14592, live: 'was_live', chat: false, ...video }),
    download: async (job) => {
      calls.push(job);
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-t', '2', '-pix_fmt', 'yuv420p', path.join(job.dir, `${job.name}.mp4`)]);
    },
  });
  const ask = (options) => fetchVideo({ url: vod, start: 3600, end: 3660, sources, outDir: dir, downloader: downloader(), freeSpace: async () => 1e12, ...options });

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'clipper-twitch-'));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('fetches a part from an agreed Twitch channel, named with "tw" and the video number', async () => {
    const fetched = await ask({});
    expect(fetched).toMatchObject({ name: 'boeshi_tw2938193982_1h00m00s-1h01m00s.mp4', source: { id: 'boeshi' } });
    expect(calls.at(-1)).toMatchObject({ url: vod, start: 3600, end: 3660 });
    // The name says which stream and where, as for a YouTube part, so imported chat lines up.
    expect(fetchedOrigin(fetched.name)).toEqual({ videoId: 'tw2938193982', offset: 3600, end: 3660, link: vod });
    expect(await partsInFolder(dir, 'tw2938193982')).toEqual([{ start: 3600, end: 3660 }]);
  });

  it('refuses another channel, a broadcast still going, and a whole broadcast over 3 hours', async () => {
    await expect(ask({ downloader: downloader({ login: 'someoneelse', channel: 'someoneelse' }) })).rejects.toThrow(/not in your sources list/);
    await expect(ask({ downloader: downloader({ live: 'is_live' }) })).rejects.toThrow(/live right now.*Twitch shows it/);
    await expect(ask({ whole: true })).rejects.toThrow(/at most 3 hours/);
    const whole = await ask({ whole: true, downloader: downloader({ duration: 5400 }) });
    expect(whole.name).toBe('boeshi_tw2938193982_0m00s-1h30m00s.mp4');
  });

  it('hands ffmpeg only a stream on Twitch\'s video hosts', () => {
    expect(checkTwitchStream('https://d1m7jfoe9zdc1j.cloudfront.net/abc/1080p60/index-dvr.m3u8')).toBe('https://d1m7jfoe9zdc1j.cloudfront.net/abc/1080p60/index-dvr.m3u8');
    expect(checkTwitchStream('https://vod-secure.twitch.ttvnw.net/a.m3u8')).toBe('https://vod-secure.twitch.ttvnw.net/a.m3u8');
    for (const bad of ['http://d1.cloudfront.net/a.m3u8', 'https://example.com/a.m3u8', 'https://cloudfront.net.evil.example/a', 'https://user@d1.cloudfront.net/a', 'file:///etc/passwd', '', undefined]) {
      expect(() => checkTwitchStream(bad), String(bad)).toThrow(/stream/);
    }
  });
});

describe('what Twitch says about a channel', () => {
  const reply = (body, status = 200) => async (address, options) => {
    reply.last = { address, options };
    return { ok: status === 200, json: async () => body };
  };
  const user = { login: 'darealboeshi', displayName: 'DaRealBoeshi', profileImageURL: 'https://static-cdn.jtvnw.net/jtv_user_picture/a-300x300.png', followers: { totalCount: 5769 }, stream: null };

  it('asks one question about one login, sent as a variable, and reads the answer', async () => {
    const request = reply({ data: { user } });
    expect(await twitchChannel('DaRealBoeshi', { request })).toEqual({ login: 'darealboeshi', name: 'DaRealBoeshi', pictureUrl: user.profileImageURL, followers: 5769, stream: null });
    expect(reply.last.address).toBe('https://gql.twitch.tv/gql');
    const body = JSON.parse(reply.last.options.body);
    expect(body.variables).toEqual({ login: 'darealboeshi' });
    expect(body.query).not.toContain('darealboeshi');
    expect(reply.last.options.redirect).toBe('error');
    const live = await twitchChannel('darealboeshi', { request: reply({ data: { user: { ...user, stream: { id: '1', title: 'GTA', viewersCount: 120, createdAt: '2026-11-23T18:00:00Z' } } } }) });
    expect(live.stream).toEqual({ id: '1', title: 'GTA', viewers: 120, started: Date.parse('2026-11-23T18:00:00Z') / 1000 });
  });

  it('refuses a bad login before asking, and says plainly when Twitch has no such channel or fails', async () => {
    const request = reply({ data: { user } });
    reply.last = null;
    await expect(twitchChannel('bad name', { request })).rejects.toThrow(/not a Twitch channel name/);
    expect(reply.last).toBeNull();
    await expect(twitchChannel('nobody', { request: reply({ data: { user: null } }) })).rejects.toThrow(/no channel at that address/);
    await expect(twitchChannel('x', { request: reply({}, 500) })).rejects.toThrow(/did not answer/);
    await expect(twitchChannel('x', { request: async () => { throw new Error('offline'); } })).rejects.toThrow(/could not be reached/);
  });
});

describe('a Twitch channel\'s picture, followers and live status', () => {
  let dir;
  let picture;
  const twitch = (answer = {}) => ({
    channel: async (url) => ({ site: 'twitch', name: 'DaRealBoeshi', channelId: '', handle: '', login: 'darealboeshi', pictureUrl: 'https://static-cdn.jtvnw.net/jtv_user_picture/a-300x300.png', subscribers: 5769, asked: url, ...answer }),
  });
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'clipper-twitch-pic-'));
    const file = path.join(dir, 'a.png');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=300x300', '-frames:v', '1', file]);
    picture = await (await import('node:fs/promises')).readFile(file);
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('takes the picture from Twitch\'s picture host, and keeps the follower count', async () => {
    expect(checkPictureUrl('https://static-cdn.jtvnw.net/jtv_user_picture/a.png')).toBe('https://static-cdn.jtvnw.net/jtv_user_picture/a.png');
    await fetchPicture({ source: sources[0], dataDir: dir, downloader: twitch(), download: async () => picture });
    expect(await readdir(path.join(dir, 'source-pictures'))).toEqual(['boeshi.png']);
    expect((await listSubscribers(dir, sources)).boeshi.count).toBe(5769);
    // A Twitch channel of another login is refused, as on YouTube.
    await expect(fetchPicture({ source: sources[0], dataDir: dir, downloader: twitch({ login: 'someoneelse', name: 'Someone' }), download: async () => picture })).rejects.toThrow(/leads to another channel/);
    await expect(fetchPicture({ source: sources[0], dataDir: dir, downloader: twitch({ pictureUrl: '' }), download: async () => picture })).rejects.toThrow(/Twitch gave no picture/);
  });

  it('adds a Twitch channel from its address with the sync button', async () => {
    const data = path.join(dir, 'sync');
    const added = await syncSource({ source: { id: 'tw', url: 'https://www.twitch.tv/DaRealBoeshi', name: '' }, dataDir: data, downloader: twitch(), download: async () => picture });
    expect(added).toMatchObject({ source: { id: 'tw', name: 'DaRealBoeshi', url: 'https://www.twitch.tv/DaRealBoeshi', status: 'agreed' }, named: true, picture: true });
    // Its YouTube channel of the same name is another row, not "already in your list".
    await expect(syncSource({ source: { id: 'yt', url: 'https://www.youtube.com/@darealboeshi', name: 'Boeshi YT' }, dataDir: data, downloader: { channel: async () => ({ name: 'Boeshi', channelId: 'UCb', handle: '@darealboeshi', pictureUrl: '' }) }, download: async () => picture })).resolves.toMatchObject({ source: { id: 'yt' } });
    await expect(syncSource({ source: { id: 'x', url: 'https://www.twitch.tv/darealboeshi' }, dataDir: data, downloader: twitch(), download: async () => picture })).rejects.toThrow(/already in your list/);
  });

  it('marks a live Twitch channel with a link to its channel, built from the list', async () => {
    const asked = [];
    const downloader = { live: async (url) => {
      asked.push(url);
      if (url.includes('twitch')) return { site: 'twitch', live: true, login: 'darealboeshi', title: ' GTA\n6 ', viewers: 120, started: 1795420664 };
      return { live: false };
    } };
    const found = await checkLive({ sources, downloader });
    expect(asked.sort()).toEqual(['https://www.twitch.tv/darealboeshi', 'https://www.youtube.com/@darealboeshi']);
    expect(found.boeshi).toEqual({ live: true, url: 'https://www.twitch.tv/darealboeshi', title: 'GTA 6', viewers: 120, started: new Date(1795420664000).toISOString() });
    expect(found['boeshi-yt']).toEqual({ live: false });
    // A stream of another login is not this channel's.
    const other = await checkLive({ sources: [sources[0]], downloader: { live: async () => ({ site: 'twitch', live: true, login: 'someoneelse', title: 'x' }) } });
    expect(other.boeshi).toEqual({ live: false });
  });
});

describe('Twitch chat, imported from a TwitchDownloader file', () => {
  let dir;
  // The shape TwitchDownloader writes: a "comments" list, each with the time into the broadcast, the commenter and the words.
  const comment = (t, who, body) => ({ _id: `c${t}`, content_offset_seconds: t, commenter: { _id: who, name: `name-${who}`, display_name: `Name ${who}` }, message: { body, fragments: [{ text: body }] } });
  const file = (comments) => JSON.stringify({ FileInfo: { Version: { Major: 1 } }, streamer: { name: 'darealboeshi', id: 643590557 }, video: { id: '2938193982' }, comments });

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'clipper-twitch-chat-'));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('reads the messages, in order, keeping only a one-way id for who wrote them', () => {
    const messages = parseChatFile(file([comment(30.5, '7', 'LUL'), comment(12, '8', 'hi\nchat'), comment(-3, '9', 'before'), comment(40, '7', '')]), 'chat.json');
    expect(messages.map((message) => [message.t, message.text])).toEqual([[12, 'hi chat'], [30.5, 'LUL']]);
    expect(messages[0].author).not.toContain('viewer');
    expect(messages[0].author).not.toBe(messages[1].author);
    expect(() => parseChatFile(file([]), 'chat.json')).toThrow(/no messages/);
    expect(() => parseChatFile(file([{ message: { body: 'x' } }]), 'chat.json')).toThrow(/no time/);
  });

  it('lines a Twitch part\'s chat up from the part\'s name, as for a YouTube part', async () => {
    const chat = await importChatFile({ dataDir: dir, video: 'boeshi_tw2938193982_1h00m00s-1h01m00s.mp4', name: 'chat.json', text: file([comment(3610, '1', 'W')]) });
    expect(chat.offset).toBe(3600);
  });

  it('keeps a stream\'s chat for clips from it, refuses a YouTube link, and reads it back', async () => {
    expect(await importStreamChat({ dataDir: dir, url: vod, name: 'chat.json', text: file([comment(5, '1', 'W')]) })).toEqual({ streamId: 'tw2938193982', messages: 1 });
    expect((await readChat(dir, 'twitch-2938193982')).messages).toHaveLength(1);
    await expect(importStreamChat({ dataDir: dir, url: 'https://youtu.be/dQw4w9WgXcQ', name: 'c.json', text: file([comment(5, '1', 'W')]) })).rejects.toThrow(/only a Twitch stream/);
  });
});

describe('clips from a Twitch stream\'s chat', () => {
  let dir;
  const comment = (t, who, body) => ({ content_offset_seconds: t, commenter: { _id: who }, message: { body } });
  // An hour of steady chat, with a laugh and a hype at known times.
  const comments = [];
  for (let t = 0; t < 3600; t += 3) comments.push(comment(t + 0.5, `u${t % 25}`, `chatting ${t % 7}`));
  for (const [at, text] of [[900, 'LUL LUL'], [2100, 'W W W']]) {
    for (let i = 0; i < 30; i++) comments.push(comment(at + (i % 8) * 0.5, `b${i}`, text));
  }
  const text = JSON.stringify({ comments });
  const downloader = () => {
    const done = { info: 0, chat: 0, comments: 0, download: [] };
    return {
      done,
      isInstalled: async () => true,
      info: async () => {
        done.info += 1;
        return { site: 'twitch', id: 'v2938193982', title: 'Streaming GTA 6', channel: 'darealboeshi', channelId: '', handle: '', login: 'darealboeshi', duration: 3600, live: 'was_live', chat: false };
      },
      chat: async () => {
        done.chat += 1;
        throw new Error('not for Twitch');
      },
      comments: async () => {
        done.comments += 1;
        return [];
      },
      download: async (job) => {
        done.download.push([job.start, job.end]);
        await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10', '-t', '1', '-pix_fmt', 'yuv420p', path.join(job.dir, `${job.name}.mp4`)]);
      },
    };
  };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'clipper-twitch-clips-'));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('says to import the chat first, before asking anything of Twitch', async () => {
    const stand = downloader();
    await expect(clipsFromChat({ url: vod, sources, outDir: path.join(dir, 'in0'), dataDir: path.join(dir, 'data0'), downloader: stand })).rejects.toThrow(/TwitchDownloader/);
    expect(stand.done.info).toBe(0);
  });

  it('chooses from the imported chat alone, reads no comments, and records the parts under "tw" and the number', async () => {
    const dataDir = path.join(dir, 'data');
    const outDir = path.join(dir, 'in');
    await importStreamChat({ dataDir, url: vod, name: 'chat.json', text });
    const stand = downloader();
    const result = await clipsFromChat({ url: vod, count: 2, sources, outDir, dataDir, downloader: stand });
    expect(result).toMatchObject({ videoId: 'tw2938193982', channel: 'Boeshi', comments: 0 });
    expect(result.clips.filter((clip) => clip.name)).toHaveLength(2);
    expect(stand.done).toMatchObject({ info: 1, chat: 0, comments: 0 });
    expect((await readdir(outDir)).every((name) => name.startsWith('boeshi_tw2938193982_'))).toBe(true);
    // Asking again with "skip" finds the two parts given and has nothing new left.
    await expect(clipsFromChat({ url: vod, count: 2, skipSuggested: true, sources, outDir, dataDir, downloader: downloader() })).rejects.toThrow(/No new moments/);
  }, 60_000);
});
