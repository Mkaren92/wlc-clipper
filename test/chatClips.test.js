// Clips from a finished stream's chat: choosing where the chat exploded, and the whole
// request (look up, fetch the chat, choose, download the parts). The downloader is a
// stand-in; nothing reaches YouTube.
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clipsFromChat } from '../src/chat/chatClips.js';
import { commentMarks, commentMoments } from '../src/chat/comments.js';
import { expandWords, pickChatMoments } from '../src/chat/pick.js';
import { reactionStream, readMessage } from '../src/chat/reactions.js';
import { run } from '../src/run.js';
import { parseSources } from '../src/sources.js';

// One hour of chat: 30 people chatting steadily, and bursts at known times.
let seed = 11;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
function stream({ bursts, people = 60, size = 30 } = {}) {
  const messages = [];
  for (let t = 0; t < 3600; t += 2) messages.push({ t: t + rand(), author: `u${Math.floor(rand() * 30)}`, text: `chatting ${Math.floor(rand() * 9)}` });
  // Bursts are fixed, not random: n messages from n different people (up to `people`), over 4 s.
  for (const [at, text, n = size] of bursts) {
    for (let i = 0; i < n; i++) messages.push({ t: at + (i % 8) * 0.5, author: `b${i % people}`, text });
  }
  return messages.sort((a, b) => a.t - b.t);
}
// What chat writes: a goal, a laugh, a penalty shout, a bigger laugh, and surprise.
const BURSTS = [[600, 'GOOOOOOL'], [1200, 'lol that miss'], [1800, 'penalty!!', 25], [2400, 'lmao', 40], [3000, 'wow']];

describe('the owner\'s words', () => {
  it('bring a whole preset group when a word is in one, and stand alone otherwise', () => {
    const groups = expandWords('goal, Penalty, banana');
    expect(groups.map((group) => group.label)).toEqual(['Goal', 'Penalty', 'banana']);
    expect(groups[0].terms).toContain('gol');
    expect(groups[2].terms).toEqual(['banana']);
    expect(expandWords('')).toEqual([]);
    expect(expandWords('gol, golazo').map((group) => group.label)).toEqual(['Goal']);
  });
});

// What chat says, as the owner's 11-hour gaming stream showed: its loudest bursts were
// poll votes and giveaway commands, its best moment was "YOOOO", "WOAH", "lol", "W".
describe('what a chat message says', () => {
  it('reads chat\'s own words: W is a win, L a loss, and stretched or emoji laughter', () => {
    expect(readMessage('W').reactions).toEqual(['hype']);
    expect(readMessage('huge W').reactions).toEqual(['hype']);
    expect(readMessage('L').reactions).toEqual(['fail']);
    expect(readMessage('LMAOOOOOO').reactions).toEqual(['laughing']);
    expect(readMessage('💀💀💀').reactions).toEqual(['laughing']);
    // "no way" is shock first; it also holds a "no".
    expect(readMessage('NO WAY').reactions[0]).toBe('shock');
    expect(readMessage('clip it').reactions[0]).toBe('clip it');
    // An L inside a word is not a loss.
    expect(readMessage('lucia').kind).toBe('chatter');
  });

  it('leaves out commands, poll votes and plain answers, and keeps shouted ones', () => {
    expect(readMessage('!me').kind).toBe('noise');
    expect(readMessage('!enter giveaway').kind).toBe('noise');
    expect(readMessage('1').kind).toBe('noise');
    expect(readMessage('333').kind).toBe('noise');
    expect(readMessage('yes').kind).toBe('chatter');
    expect(readMessage('no').kind).toBe('chatter');
    expect(readMessage('YESSSSS').kind).toBe('reaction');
    expect(readMessage('NOOOOO').kind).toBe('reaction');
    expect(readMessage('yes!!').kind).toBe('reaction');
    // A sentence that happens to hold "what" is chatter.
    expect(readMessage('what do you think about the new update for the game today').kind).toBe('chatter');
  });

  it('counts a pasted sentence once, and thirty people laughing thirty times', () => {
    const pasted = Array.from({ length: 10 }, (_, i) => ({ t: 100 + i, author: `a${i}`, text: 'stop scamming kreek do the giveaway' }));
    const laughs = Array.from({ length: 30 }, (_, i) => ({ t: 200 + i / 10, author: `b${i}`, text: 'lol that miss' }));
    expect(reactionStream(pasted)).toHaveLength(0);
    expect(reactionStream(pasted, { wordMatch: (text) => text.includes('giveaway') })).toHaveLength(1);
    expect(reactionStream(laughs)).toHaveLength(30);
  });
});

describe('moments viewers pointed to in the comments', () => {
  it('reads the times in comments, once per moment, within the video', () => {
    const marks = commentMarks([
      { text: '10:00:01 bro started panic', likes: 3 },
      { text: '9:59:42 THE ONE SHOWER SCENE', likes: 0 },
      { text: 'They getting freaky 3:11:51', likes: 0 },
      { text: 'score was 2:1 and 3:75 is not a time, nor 12:00:00:00', likes: 0 },
      { text: '1:00 1:05 1:10 a chapter list', likes: 1 },
      { text: '23:59:59 past the end', likes: 0 },
    ], 11 * 3600);
    expect(marks.map((mark) => mark.t)).toEqual([60, 11511, 35982, 36001]);
  });

  it('gives a chapter list one comment of weight in all, not one per time', () => {
    const chapters = { text: '0:00 Intro 12:30 Game 1 25:00 Game 2 40:10 Game 3 55:00 Outro', likes: 400 };
    const moments = commentMoments(commentMarks([chapters, { ...chapters }, { text: '30:00 that save', likes: 0 }, { text: '30:10 the save!!', likes: 0 }], 3600));
    const listed = moments.filter((moment) => moment.at !== 1800);
    const save = moments.find((moment) => moment.at === 1800);
    // Two copies of the list still do not make "two viewers pointed here".
    expect(listed.every((moment) => moment.pointers < 2)).toBe(true);
    // Two viewers who wrote the save down separately outweigh any one time of a 400-like list.
    expect(save.pointers).toBe(2);
    expect(listed.every((moment) => moment.weight < save.weight)).toBe(true);
  });

  it('gathers marks close together into one moment that spans them', () => {
    const moments = commentMoments(commentMarks([{ text: '9:59:42 shower', likes: 0 }, { text: '9:59:58', likes: 0 }, { text: '10:00:01 panic', likes: 3 }, { text: '3:45:40', likes: 2 }], 42000));
    expect(moments).toHaveLength(2);
    expect(moments[1]).toMatchObject({ at: 35982, until: 36001, marks: 3, likes: 3 });
    expect(moments[1].texts[0]).toBe('10:00:01 panic');
  });

  it('puts a moment two viewers pointed to ahead of a small chat burst, and spans its clip over their times', () => {
    const messages = stream({ bursts: [[1200, 'lol', 8], [2400, 'lmao', 40]] });
    const comments = [{ text: '30:00 the jump scare', likes: 5 }, { text: '30:10 lmao this part', likes: 1 }];
    const moments = pickChatMoments(messages, { duration: 3600, comments, count: 2 });
    expect(moments.map((moment) => moment.sources)).toEqual([['comments'], ['chat']]);
    expect(moments[0]).toMatchObject({ start: 1780, end: 1830 });
    expect(moments[0].comments.texts[0]).toBe('30:00 the jump scare');
  });
});

describe('choosing the moments', () => {
  const messages = stream({ bursts: BURSTS });

  it('puts explosions with the words first, then fills up with the biggest others, in time order', () => {
    const moments = pickChatMoments(messages, { duration: 3600, groups: expandWords('goal, penalty'), count: 4 });
    expect(moments).toHaveLength(4);
    expect(moments.filter((moment) => moment.matched).map((moment) => moment.label)).toEqual(['Goal', 'Penalty']);
    // In the order they happen.
    expect(moments.map((moment) => moment.start)).toEqual([...moments.map((moment) => moment.start)].sort((a, b) => a - b));
    // The goal: the chat exploded at 600 s, the moment is taken 5 s earlier, and the clip is 20 s either side.
    const goal = moments.find((moment) => moment.label === 'Goal');
    expect(goal).toMatchObject({ at: 595, start: 575, end: 615 });
  });

  it('without words, takes the biggest explosions', () => {
    const moments = pickChatMoments(messages, { duration: 3600, count: 2 });
    expect(moments).toHaveLength(2);
    expect(moments.every((moment) => !moment.matched)).toBe(true);
    // The 40-message burst is the biggest.
    expect(moments.some((moment) => moment.at === 2395)).toBe(true);
  });

  it('finds explosions in a quiet chat too, by asking less of it', () => {
    const quiet = stream({ bursts: [[900, 'goal', 4], [2000, 'what', 4]], people: 4 }).filter((message) => message.author.startsWith('b') || rand() < 0.05);
    const moments = pickChatMoments(quiet, { duration: 3600, groups: expandWords('goal'), count: 2 });
    expect(moments.length).toBeGreaterThanOrEqual(1);
    expect(moments.find((moment) => moment.matched)?.at).toBeCloseTo(895, 0);
  });

  // Seen on a real watchalong: one "who scored for Belgium??" in a small burst was taken as a goal.
  it('does not count a burst as matching when only one of its messages has the words', () => {
    const once = stream({ bursts: [[900, 'lol', 20], [903, 'goal', 1], [1500, 'goal', 6], [1503, 'yesss', 14]] });
    const moments = pickChatMoments(once, { duration: 3600, groups: expandWords('goal'), count: 2 });
    expect(moments.find((moment) => moment.at === 895)).toMatchObject({ matched: false, label: null });
    expect(moments.find((moment) => moment.at === 1495)).toMatchObject({ matched: true, label: 'Goal' });
  });

  it('never gives two clips that share a second', () => {
    const close = stream({ bursts: [[600, 'lol'], [618, 'lmao']] });
    const moments = pickChatMoments(close, { duration: 3600, count: 6 });
    for (let i = 1; i < moments.length; i++) expect(moments[i].start).toBeGreaterThanOrEqual(moments[i - 1].end);
  });

  it('honours the seconds before and after, and the video\'s ends', () => {
    const early = stream({ bursts: [[130, 'lmao'], [3592, 'lmao']] });
    const moments = pickChatMoments(early, { duration: 3600, count: 6, before: 20, after: 10 });
    expect(moments[0]).toMatchObject({ at: 125, start: 105, end: 135 });
    expect(moments.at(-1).end).toBeLessThanOrEqual(3600);
  });
});

describe('the whole request', () => {
  let dir;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'clipper-chatclips-'));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  const sources = parseSources([{ id: 'p', name: 'Papillon', url: 'https://www.youtube.com/@papillon', status: 'agreed' }]);
  // The chat as yt-dlp writes it, from the made-up stream.
  const chatLines = stream({ bursts: BURSTS }).map((message) => JSON.stringify({ replayChatItemAction: { videoOffsetTimeMsec: String(Math.round(message.t * 1000)), actions: [{ addChatItemAction: { item: { liveChatTextMessageRenderer: { message: { runs: [{ text: message.text }] }, authorExternalChannelId: message.author, timestampText: { simpleText: '1:00' } } } } }] } })).join('\n');
  const downloader = (info = {}, { failOn = null } = {}) => {
    const done = { info: 0, chat: 0, download: [] };
    return {
      done,
      isInstalled: async () => true,
      info: async () => {
        done.info += 1;
        return { id: 'pkStu8LFpq8', title: 'A watchalong', channel: 'Papillon', channelId: 'UCp', handle: '@papillon', duration: 3600, live: 'was_live', chat: true, ...info };
      },
      chat: async (job) => {
        done.chat += 1;
        const file = path.join(job.dir, `${job.name}.live_chat.json`);
        await writeFile(file, chatLines);
        return file;
      },
      download: async (job) => {
        done.download.push([job.start, job.end]);
        if (failOn !== null && done.download.length === failOn) throw new Error('The download failed. Try again.');
        await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10', '-t', '1', '-pix_fmt', 'yuv420p', path.join(job.dir, `${job.name}.mp4`)]);
      },
    };
  };

  it('looks the stream up once, fetches its chat, and downloads only the chosen parts', async () => {
    const stand = downloader();
    const steps = [];
    const outDir = path.join(dir, 'in');
    const result = await clipsFromChat({ url: 'https://youtu.be/pkStu8LFpq8', words: 'goal, penalty', count: 3, sources, outDir, dataDir: path.join(dir, 'data'), downloader: stand, onStep: (step, detail) => steps.push(detail ? `${step} ${detail.done + 1}/${detail.total}` : step) });
    expect(result).toMatchObject({ videoId: 'pkStu8LFpq8', channel: 'Papillon', words: ['Goal', 'Penalty'], asked: 3, matched: 2 });
    expect(result.clips).toHaveLength(3);
    expect(result.clips.map((clip) => clip.name)).toEqual(expect.arrayContaining(['papillon_pkStu8LFpq8_9m35s-10m15s.mp4']));
    expect(await readdir(outDir)).toHaveLength(3);
    // Only the parts: three 40-second ranges, and one lookup for all of them.
    expect(stand.done.download.every(([start, end]) => end - start === 40)).toBe(true);
    expect(stand.done.info).toBe(1);
    expect(steps).toEqual(['looking', 'chat', 'comments', 'finding', 'fetching 1/3', 'fetching 2/3', 'fetching 3/3']);
  }, 60_000);

  it('uses the chat it kept, and a part that fails does not cost the others', async () => {
    const stand = downloader({}, { failOn: 2 });
    const result = await clipsFromChat({ url: 'https://youtu.be/pkStu8LFpq8', count: 3, sources, outDir: path.join(dir, 'in2'), dataDir: path.join(dir, 'data'), downloader: stand });
    expect(stand.done.chat).toBe(0);
    expect(result.clips.filter((clip) => clip.error)).toHaveLength(1);
    expect(result.clips.filter((clip) => clip.name)).toHaveLength(2);
  }, 60_000);

  it('refuses a video without a chat replay, a channel that is not agreed, a live stream, and bad numbers', async () => {
    const ask = (info, more = {}) => clipsFromChat({ url: 'https://youtu.be/pkStu8LFpq8', sources, outDir: path.join(dir, 'in3'), dataDir: path.join(dir, 'data3'), downloader: downloader(info), ...more });
    await expect(ask({ chat: false, live: 'not_live' })).rejects.toThrow(/no chat replay.*uploaded video/);
    await expect(ask({ channel: 'Someone', channelId: 'UCz', handle: '@someone' })).rejects.toThrow(/not in your sources list/);
    await expect(ask({ live: 'is_live' })).rejects.toThrow(/live right now/);
    await expect(ask({}, { count: 0 })).rejects.toThrow(/1 to 20 clips/);
    await expect(ask({}, { before: 500 })).rejects.toThrow(/between 1 and 120/);
    await expect(ask({}, { url: 'https://example.com/x' })).rejects.toThrow(/link to one YouTube video/);
  });
});
