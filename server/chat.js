// Routes for a video's chat, used by "Suggested moments" on the cutting screen:
// read it, bring it in (from a file the owner chose, or YouTube's chat replay of
// an agreed channel's finished stream), change its offset, remove it, and the
// optional AI check of chat candidates. Detection itself runs in the page, from
// src/chat/spikes.js, so its settings change the result at once.
import path from 'node:path';
import express from 'express';
import { z } from 'zod';
import { checkChatMoments } from '../src/ai/chatCheck.js';
import { keptTranscript, LANG_PATTERN } from '../src/ai/suggest.js';
import { clipsFromChat } from '../src/chat/chatClips.js';
import { fetchChatReplay, fetchedOrigin, importChatFile, importStreamChat, onVideoClock, readChat, removeChat, setChatOffset } from '../src/chat/chatStore.js';
import { parseTermGroups } from '../src/chat/terms.js';
import { ytDlp } from '../src/fetch.js';
import { probe } from '../src/probe.js';
import { readSources } from '../src/sources.js';
import { HttpError } from './http.js';

const offset = z.number().finite().min(-86_400).max(86_400);
const fetchRequest = z.strictObject({ url: z.string().min(1).max(300), offset: offset.optional() });
const offsetRequest = z.strictObject({ offset });
// Clips from a finished stream's chat: the link, words (or none), how many, and the seconds either side.
const clipsRequest = z.strictObject({
  url: z.string().min(1).max(300),
  words: z.string().max(300).default(''),
  count: z.number().int().min(1).max(20).default(6),
  before: z.number().min(1).max(120).default(30),
  after: z.number().min(1).max(120).default(30),
  skipSuggested: z.boolean().default(false),
});
const checkRequest = z.strictObject({
  candidates: z.array(z.strictObject({ start: z.number().finite().min(0), end: z.number().finite().min(0), label: z.string().max(40).nullable(), needsReview: z.boolean().optional() })).max(20),
  terms: z.unknown().optional(),
  guidance: z.string().max(500).default(''),
  donations: z.boolean().default(false),
  lang: z.string().trim().regex(LANG_PATTERN).default('en'),
});

/**
 * @param {import('express').Express} app
 * @param {object} options
 * @param {string} options.dataDir
 * @param {string} options.outDir
 * @param {string} options.inDir    the videos folder, where clips from chat are saved
 * @param {ReturnType<import('./jobs.js').createJobs>} options.jobs
 * @param {(name: string) => Promise<string>} options.videoPath   a video's file from its name in `in/`
 * @param {import('../src/ai/client.js').Ai} options.ai
 * @param {import('../src/fetch.js').Downloader} [options.downloader]   replaced in tests
 */
export function addChatRoutes(app, { dataDir, outDir, inDir, jobs, videoPath, ai, downloader = ytDlp() }) {
  const cacheDir = path.join(outDir, '.cache');

  /** What the page needs: the messages on the video's clock, and where they came from. */
  async function describe(name, file) {
    const chat = await readChat(dataDir, name).catch((error) => {
      throw new HttpError(400, error.message);
    });
    const duration = (await probe(file)).duration;
    return {
      chat: chat && { origin: chat.origin, importedAt: chat.importedAt, offset: chat.offset, total: chat.messages.length, messages: onVideoClock(chat, duration) },
      duration,
      // For a part this tool fetched, its name says which video and where it starts.
      suggested: fetchedOrigin(name),
    };
  }

  app.get('/api/chat/:video', async (req, res) => {
    const file = await videoPath(req.params.video);
    res.json({ ...(await describe(req.params.video, file)), downloaderInstalled: await downloader.isInstalled() });
  });

  // The transcript of the whole video, only if it was already made. Never transcribes.
  app.get('/api/transcript/:video', async (req, res) => {
    const file = await videoPath(req.params.video);
    const lang = z.string().trim().regex(LANG_PATTERN).catch('en').parse(req.query.lang ?? 'en');
    res.json({ words: await keptTranscript({ source: file, lang, cacheDir }) });
  });

  app.post('/api/chat/:video/fetch', async (req, res) => {
    const parsed = fetchRequest.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error));
    const name = req.params.video;
    await videoPath(name);
    const sources = await readSources(dataDir);
    const job = jobs.add('chat', name, async (onStep) => {
      const chat = await fetchChatReplay({ dataDir, video: name, url: parsed.data.url, offset: parsed.data.offset, sources, downloader, onStep });
      return { messages: chat.messages.length, offset: chat.offset };
    });
    res.status(202).json(job);
  });

  // A chat file the owner chose, sent as it is: it may be larger than the JSON limit of other requests.
  // TwitchDownloader's JSON keeps about a kilobyte a message, so a busy 4-hour stream can pass 64 MB.
  app.put('/api/chat/:video/import', express.text({ type: () => true, limit: '200mb' }), async (req, res) => {
    const file = await videoPath(req.params.video);
    const name = z.string().min(1).max(200).catch('chat').parse(req.query.name);
    const at = req.query.offset === undefined ? undefined : offset.safeParse(Number(req.query.offset)).data;
    await importChatFile({ dataDir, video: req.params.video, name, text: String(req.body ?? ''), offset: at }).catch((error) => {
      throw new HttpError(400, error.message);
    });
    res.json(await describe(req.params.video, file));
  });

  // Paste a finished stream's link: its chat is read, and only the parts where it exploded are downloaded.
  // A Twitch stream's chat, saved by the owner with TwitchDownloader, for clips from that stream's chat.
  // The stream is named by its link in the address; the file is the body, as with a video's chat.
  app.put('/api/stream-chat', express.text({ type: () => true, limit: '200mb' }), async (req, res) => {
    const url = z.string().min(1).max(300).safeParse(req.query.url);
    if (!url.success) throw new HttpError(400, 'Give the stream\'s link.');
    const name = z.string().min(1).max(200).catch('chat').parse(req.query.name);
    res.json(await importStreamChat({ dataDir, url: url.data, name, text: String(req.body ?? '') }).catch((error) => {
      throw new HttpError(400, error.message);
    }));
  });

  app.post('/api/chat-clips', async (req, res) => {
    const parsed = clipsRequest.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error));
    const sources = await readSources(dataDir);
    const job = jobs.add('chat-clips', `${parsed.data.count} clips from a stream's chat`, (onStep) =>
      clipsFromChat({ ...parsed.data, sources, outDir: inDir, dataDir, downloader, onStep }));
    res.status(202).json(job);
  });

  app.put('/api/chat/:video/offset', async (req, res) => {
    const parsed = offsetRequest.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error));
    const file = await videoPath(req.params.video);
    await setChatOffset(dataDir, req.params.video, parsed.data.offset).catch((error) => {
      throw new HttpError(400, error.message);
    });
    res.json(await describe(req.params.video, file));
  });

  app.delete('/api/chat/:video', async (req, res) => {
    await videoPath(req.params.video);
    await removeChat(dataDir, req.params.video);
    res.json({ ok: true });
  });

  // The optional AI check. Sends only message text and, if kept, the transcript lines of each window.
  app.post('/api/chat/:video/check', async (req, res) => {
    const parsed = checkRequest.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error));
    let terms;
    try {
      terms = parseTermGroups(parsed.data.terms);
    } catch (error) {
      throw new HttpError(400, error.message);
    }
    const name = req.params.video;
    const file = await videoPath(name);
    const chat = await readChat(dataDir, name);
    if (!chat) throw new HttpError(400, 'This video has no chat yet.');
    if (!ai.isConfigured()) throw new HttpError(400, ai.help);
    const job = jobs.add('chat-check', name, async (onStep) => {
      const messages = onVideoClock(chat, (await probe(file)).duration);
      const words = await keptTranscript({ source: file, lang: parsed.data.lang, cacheDir });
      return checkChatMoments({ ...parsed.data, terms, messages, words, ai, onStep });
    });
    res.status(202).json(job);
  });
}
