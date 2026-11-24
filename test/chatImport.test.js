// Bringing a chat in (YouTube's chat replay as yt-dlp writes it, or a file), keeping
// it per video, and the optional AI check of chat candidates. No network: the
// downloader and the AI service are stand-ins.
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkChatMoments, tidyChecks } from '../src/ai/chatCheck.js';
import { fetchChatReplay, fetchedOrigin, importChatFile, onVideoClock, readChat, removeChat, setChatOffset } from '../src/chat/chatStore.js';
import { authorId, csvRows, parseChatFile, parseYouTubeLiveChat } from '../src/chat/importChat.js';
import { isSignedIn, youtubeRefusal, ytDlp } from '../src/fetch.js';
import { acceptEntry } from '../src/transfer/contents.js';
import { parseSources } from '../src/sources.js';

// Lines shaped like a real .live_chat.json (read from a real file on 2026-11-21), with made-up content.
const action = (renderer, body) => ({ addChatItemAction: { item: { [renderer]: body } } });
const row = (ms, ...actions) => JSON.stringify({ clickTrackingParams: 'x', replayChatItemAction: { actions, videoOffsetTimeMsec: String(ms) } });
const text = (shown, who, runs) => ({ message: { runs }, authorName: { simpleText: `Name ${who}` }, authorExternalChannelId: `UC${who}`, timestampText: { simpleText: shown }, timestampUsec: '1' });
const LIVE_CHAT = [
  row(0, action('liveChatViewerEngagementMessageRenderer', { message: { runs: [{ text: 'Live chat replay is on.' }] } })),
  // Sent before the stream began: offset 0, shown as a negative time. Must be skipped.
  row(0, action('liveChatTextMessageRenderer', text('-58:51', 'early', [{ text: 'waiting for the stream' }]))),
  row(40622, action('liveChatTextMessageRenderer', text('0:40', 'a', [{ text: 'GOOOOL ' }, { emoji: { emojiId: '⚽', shortcuts: [':soccer:'] } }]))),
  row(81599,
    action('liveChatTextMessageRenderer', text('1:21', 'b', [{ emoji: { emojiId: 'UC3OTEFvPWj5aaaa/abcdefgh', shortcuts: [':_P11Papi:', ':papi:'], isCustomEmoji: true } }, { text: '  what   a goal' }]))),
  row(87327, action('liveChatPaidMessageRenderer', { ...text('1:27', 'c', [{ text: 'take my money' }]), purchaseAmountText: { simpleText: '$5.00' } })),
  row(90000, { addBannerToLiveChatCommand: {} }, action('liveChatMembershipItemRenderer', { headerSubtext: { runs: [{ text: 'Welcome' }] } })),
  row(-500, action('liveChatTextMessageRenderer', text('0:00', 'd', [{ text: 'negative offset' }]))),
].join('\n');

describe('YouTube chat replay', () => {
  it('reads messages with their time, their text with emoji, and a one-way author id', () => {
    const messages = parseYouTubeLiveChat(LIVE_CHAT);
    expect(messages).toEqual([
      { t: 40.622, author: authorId('UCa'), text: 'GOOOOL ⚽' },
      { t: 81.599, author: authorId('UCb'), text: ':_P11Papi: what a goal' },
      { t: 87.327, author: authorId('UCc'), text: 'take my money' },
    ]);
    // No name and no channel id is kept.
    expect(JSON.stringify(messages)).not.toMatch(/Name |UCa|UCb/);
    expect(authorId('UCa')).toMatch(/^[0-9a-f]{12}$/);
  });

  it('refuses a file that is not a chat replay', () => {
    expect(() => parseYouTubeLiveChat('not json')).toThrow(/not in the expected format/);
    expect(() => parseYouTubeLiveChat('')).toThrow(/empty/);
  });
});

describe('chat files', () => {
  it('reads the tool\'s own JSON, a plain list, and a .live_chat.json given as a file', () => {
    expect(parseChatFile(JSON.stringify({ messages: [{ t: 2, author: 'x', text: 'hi' }, { t: 1, author: 'y', text: 'first' }] }), 'c.json').map((m) => m.text)).toEqual(['first', 'hi']);
    expect(parseChatFile(JSON.stringify([{ time: '1:05', user: 'x', message: 'lol' }]), 'c.json')[0]).toMatchObject({ t: 65, text: 'lol' });
    expect(parseChatFile(LIVE_CHAT, 'stream.live_chat.json')).toHaveLength(3);
  });

  it('reads CSV with quoted fields, times as seconds or clock, and skips negative times', () => {
    const csv = 'Time,Author,Message\n12.5,ann,"hello, world"\n1:02:03,bob,"she said ""goal"""\n-5,cat,before\n';
    expect(csvRows(csv)[1]).toEqual(['12.5', 'ann', 'hello, world']);
    const messages = parseChatFile(csv, 'chat.csv');
    expect(messages.map((m) => [m.t, m.text])).toEqual([[12.5, 'hello, world'], [3723, 'she said "goal"']]);
    expect(messages[0].author).toBe(authorId('ann'));
  });

  it('says what is wrong with a file it cannot read', () => {
    expect(() => parseChatFile('a,b\n1,2', 'x.csv')).toThrow(/time column/);
    expect(() => parseChatFile('{"nope": 1}', 'x.json')).toThrow(/list of messages/);
    expect(() => parseChatFile('time,text\nsoon,hi', 'x.csv')).toThrow(/no time I can read/);
  });
});

describe('keeping and fetching a chat', () => {
  let dir;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'clipper-chat-'));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  const sources = parseSources([{ id: 'p', name: 'Papillon', url: 'https://www.youtube.com/@papillon', status: 'agreed' }]);
  const downloader = (info = {}) => {
    const asked = [];
    return {
      asked,
      isInstalled: async () => true,
      info: async () => ({ id: 'pkStu8LFpq8', title: 'A stream', channel: 'Papillon', channelId: 'UCp', handle: '@papillon', duration: 5000, live: 'was_live', chat: true, ...info }),
      chat: async (job) => {
        asked.push(job);
        const file = path.join(job.dir, `${job.name}.live_chat.json`);
        await writeFile(file, LIVE_CHAT);
        return file;
      },
    };
  };

  it('reads where a fetched part came from out of its name', () => {
    expect(fetchedOrigin('papillon_pkStu8LFpq8_1h02m00s-1h05m00s.mp4')).toEqual({ videoId: 'pkStu8LFpq8', offset: 3720, end: 3900, link: 'https://www.youtube.com/watch?v=pkStu8LFpq8' });
    expect(fetchedOrigin('papillon_pkStu8LFpq8_0m40s-19m29s_2.mp4')?.offset).toBe(40);
    expect(fetchedOrigin('my-own-video.mp4')).toBeNull();
  });

  it('fetches only the chat of an agreed channel\'s finished stream, keeps it per video, with the offset from the name', async () => {
    const stand = downloader();
    const video = 'papillon_pkStu8LFpq8_0m30s-5m00s.mp4';
    const chat = await fetchChatReplay({ dataDir: dir, video, url: 'https://youtu.be/pkStu8LFpq8', sources, downloader: stand });
    expect(chat).toMatchObject({ origin: { kind: 'youtube', videoId: 'pkStu8LFpq8' }, offset: 30 });
    expect(stand.asked[0].url).toBe('https://www.youtube.com/watch?v=pkStu8LFpq8');
    expect(await readChat(dir, video)).toMatchObject({ offset: 30, messages: chat.messages });
    // On the video's clock: the message at 40.6 s of the stream is 10.6 s into this part; one past its end is left out.
    expect(onVideoClock(chat, 55).map((m) => m.t)).toEqual([10.622, 51.599]);
    // Nothing is left of the work folder.
    expect((await readdir(path.join(dir, 'chats'))).filter((name) => name.startsWith('.incoming'))).toEqual([]);
  });

  it('refuses a channel that is not agreed, a live or unprepared stream, and a video with no chat replay', async () => {
    const ask = (info) => fetchChatReplay({ dataDir: dir, video: 'v.mp4', url: 'https://youtu.be/pkStu8LFpq8', sources, downloader: downloader(info) });
    await expect(ask({ channel: 'Someone', channelId: 'UCz', handle: '@someone' })).rejects.toThrow(/not in your sources list/);
    await expect(ask({ live: 'is_live' })).rejects.toThrow(/live right now/);
    await expect(ask({ live: 'post_live' })).rejects.toThrow(/still preparing/);
    await expect(ask({ chat: false })).rejects.toThrow(/no chat replay/);
    await expect(fetchChatReplay({ dataDir: dir, video: 'v.mp4', url: 'https://example.com/x', sources, downloader: downloader() })).rejects.toThrow(/link to one YouTube video/);
    expect(await readChat(dir, 'v.mp4')).toBeNull();
  });

  it('refuses another video\'s chat for a part this tool downloaded, before asking YouTube anything', async () => {
    const stand = downloader();
    let looked = 0;
    stand.info = async () => {
      looked += 1;
      return {};
    };
    // Seen on 2026-11-21: a part of fhBB1rBnbzM with a link to O_fWb1rMw_0.
    await expect(fetchChatReplay({ dataDir: dir, video: 'papillon_fhBB1rBnbzM_0m00s-11m00s.mp4', url: 'https://www.youtube.com/watch?v=O_fWb1rMw_0', sources, downloader: stand }))
      .rejects.toThrow(`This video is a download of fhBB1rBnbzM, so only that video's chat lines up with it, and the link is for O_fWb1rMw_0. To use the chat of O_fWb1rMw_0, download that video on the Download page first, open it, and fetch its chat there.`);
    expect(looked).toBe(0);
  });

  it('signs the downloader in with the cookies file only when there is one, and keeps it private', async () => {
    // A stand-in for the downloader program: it writes down its arguments and answers like yt-dlp.
    const program = path.join(dir, 'fake-python.sh');
    const argsFile = path.join(dir, 'args.txt');
    await writeFile(program, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\necho '{"id":"x","title":"t","channel":"c","live_status":"was_live","subtitles":{"live_chat":[]}}'\n`, { mode: 0o755 });
    const cookies = path.join(dir, 'youtube-cookies.txt');
    const before = { python: process.env.CLIPPER_PYTHON, cookies: process.env.CLIPPER_YOUTUBE_COOKIES };
    process.env.CLIPPER_PYTHON = program;
    process.env.CLIPPER_YOUTUBE_COOKIES = cookies;
    try {
      await ytDlp().info('https://www.youtube.com/watch?v=pkStu8LFpq8');
      expect(await readFile(argsFile, 'utf8')).not.toContain('--cookies');
      expect(isSignedIn()).toBe(false);

      await writeFile(cookies, '# Netscape HTTP Cookie File\n', { mode: 0o644 });
      const info = await ytDlp().info('https://www.youtube.com/watch?v=pkStu8LFpq8');
      expect(info.chat).toBe(true);
      const args = (await readFile(argsFile, 'utf8')).trim().split('\n');
      expect(args.slice(args.indexOf('--cookies'), args.indexOf('--cookies') + 2)).toEqual(['--cookies', cookies]);
      // YouTube's JavaScript puzzle is solved by the Node this tool runs on (2026-11-24).
      expect(args.slice(args.indexOf('--js-runtimes'), args.indexOf('--js-runtimes') + 2)).toEqual(['--js-runtimes', `node:${process.execPath}`]);
      // The link still comes last, after "--".
      expect(args.slice(-2)).toEqual(['--', 'https://www.youtube.com/watch?v=pkStu8LFpq8']);
      expect((await stat(cookies)).mode & 0o777).toBe(0o600);
      expect(isSignedIn()).toBe(true);
      // The questions asked about every channel again and again go out without the sign-in,
      // so the account makes a few requests a day, not hundreds an hour.
      await ytDlp().live('https://www.youtube.com/@papillon');
      expect(await readFile(argsFile, 'utf8')).not.toContain('--cookies');
      await ytDlp().channel('https://www.youtube.com/@papillon');
      expect(await readFile(argsFile, 'utf8')).not.toContain('--cookies');
      // Chat and comments do use it.
      await ytDlp().comments('https://www.youtube.com/watch?v=pkStu8LFpq8');
      expect(await readFile(argsFile, 'utf8')).toContain('--cookies');
      expect(youtubeRefusal(new Error("Sign in to confirm you're not a bot")).message).toMatch(/even with your YouTube sign-in/);
    } finally {
      if (before.python === undefined) delete process.env.CLIPPER_PYTHON;
      else process.env.CLIPPER_PYTHON = before.python;
      if (before.cookies === undefined) delete process.env.CLIPPER_YOUTUBE_COOKIES;
      else process.env.CLIPPER_YOUTUBE_COOKIES = before.cookies;
    }
  });

  it('never puts the YouTube sign-in in the "My data" file', () => {
    expect(acceptEntry('data/youtube-cookies.txt')).toBe(false);
    expect(acceptEntry('data/sources.json')).toBe(true);
  });

  it('says plainly when YouTube refuses the downloader', () => {
    const botCheck = new Error("python exited with code 1.\nERROR: [youtube] fhBB1rBnbzM: Sign in to confirm you’re not a bot. Use --cookies-from-browser");
    expect(youtubeRefusal(botCheck).message).toMatch(/asking to confirm this is not a bot.*The link itself is fine/);
    expect(youtubeRefusal(new Error('ERROR: HTTP Error 429: Too Many Requests')).message).toMatch(/too many requests/);
    expect(youtubeRefusal(new Error('ERROR: Video unavailable'))).toBeNull();
  });

  it('imports a file, changes only the offset, and removes the chat', async () => {
    await importChatFile({ dataDir: dir, video: 'mine.mp4', name: 'chat.csv', text: 'time,text\n10,hello\n20,again' });
    expect((await setChatOffset(dir, 'mine.mp4', 5)).messages).toHaveLength(2);
    expect(onVideoClock(await readChat(dir, 'mine.mp4')).map((m) => m.t)).toEqual([5, 15]);
    await removeChat(dir, 'mine.mp4');
    expect(await readChat(dir, 'mine.mp4')).toBeNull();
    await writeFile(path.join(dir, 'chats', 'broken.mp4.json'), '{"version": 1}');
    await expect(readChat(dir, 'broken.mp4')).rejects.toThrow(/cannot be read/);
    expect(JSON.parse(await readFile(path.join(dir, 'chats', 'papillon_pkStu8LFpq8_0m30s-5m00s.mp4.json'), 'utf8')).version).toBe(1);
  });
});

describe('AI check of chat candidates', () => {
  const messages = [
    { t: 100, author: 'a', text: 'NO GOAL offside' },
    { t: 101, author: 'b', text: 'goal?? no way' },
    { t: 300, author: 'c', text: 'GOOOOL' },
  ];
  const candidates = [{ start: 95, end: 110, label: 'Goal' }, { start: 295, end: 310, label: 'Goal' }, { start: 500, end: 520, label: null }];
  const terms = [{ label: 'Goal', terms: ['goal', 'gol'] }, { label: 'Offside', terms: ['offside'] }];
  const ai = (answer, asked = []) => ({
    service: 'Fake', model: 'fake-1', isConfigured: () => true,
    ask: async (request) => {
      asked.push(request);
      if (answer instanceof Error) throw answer;
      return { data: answer, usage: { input: 1, output: 1 } };
    },
  });

  it('asks once for all candidates, with message text only and the labels, and keeps disagreements for review', async () => {
    const asked = [];
    const words = [{ text: 'Offside!', start: 99, end: 99.5 }, { text: 'Disallowed.', start: 100, end: 100.6 }];
    const answer = { moments: [
      { number: 1, label: 'offside', confidence: 0.9, description: 'The goal is ruled out for offside' },
      { number: 2, label: 'Goal', confidence: 0.4, description: 'Maybe a goal' },
      { number: 7, label: 'Goal', confidence: 1, description: 'not a candidate' },
    ] };
    const { results, error } = await checkChatMoments({ candidates, messages: messages.map((m) => ({ ...m, author: 'secret-author' })), words, terms, guidance: 'goals only', ai: ai(answer, asked) });
    expect(error).toBeNull();
    expect(asked).toHaveLength(1);
    expect(asked[0].user).toContain('[100.0] NO GOAL offside');
    expect(asked[0].user).toContain('Streamer said: Offside! Disallowed.');
    expect(asked[0].user).not.toContain('secret-author');
    expect(asked[0].system).toContain('"Goal", "Offside"');
    expect(asked[0].system).toContain('goals only');
    // Disagrees with the keyword label: both kept, marked for review.
    expect(results[0]).toEqual({ ai: { label: 'Offside', confidence: 0.9, description: 'The goal is ruled out for offside' }, needsReview: true });
    // Under 0.5: no label.
    expect(results[1]).toMatchObject({ ai: { label: null, confidence: 0.4 }, needsReview: false });
    // Skipped by the model: unchanged.
    expect(results[2]).toEqual({ ai: null, needsReview: false });
  });

  it('uses the general labels when no terms are given, with "donation or raid" only when asked', async () => {
    const asked = [];
    await checkChatMoments({ candidates, messages, ai: ai({ moments: [] }, asked) });
    expect(asked[0].system).toContain('"funny", "hype", "fail", "drama", "other"');
    expect(asked[0].system).not.toContain('donation');
    await checkChatMoments({ candidates, messages, donations: true, ai: ai({ moments: [] }, asked) });
    expect(asked[1].system).toContain('"donation or raid"');
  });

  it('keeps the keyword results, in its own words, when the model call throws', async () => {
    const { results, error } = await checkChatMoments({ candidates, messages, terms, ai: ai(new Error('sk-secret-key-in-a-message')) });
    expect(results.map((r) => r.ai)).toEqual([null, null, null]);
    expect(error).toBe('Fake could not check the chat moments. The keyword labels are kept.');
    expect(error).not.toContain('sk-');
  });

  it('survives an answer that is wrong in every field', () => {
    expect(tidyChecks('nonsense', candidates, ['Goal'])).toHaveLength(3);
    expect(tidyChecks([{ number: 1, label: 5, confidence: 'high', description: '{\\b1}x' }], candidates, ['Goal'])[0])
      .toEqual({ ai: { label: null, confidence: 0, description: 'b1x' }, needsReview: false });
  });
});
