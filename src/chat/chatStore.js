// Where a video's chat is kept, and how it is brought in.
//
// One file per video in `in/`: data/chats/<video name>.json, holding the messages in
// the stream's own time, where they came from, and the offset the owner chose (how
// many seconds of the stream come before this video starts). Chats stay on this
// machine: the owner chose on 2026-11-21 that they do not travel in "My data".
//
// Fetching a chat replay follows the rules of `fetch`: a YouTube link to one video,
// rebuilt from its checked id; the channel read from YouTube's own data and only if
// it is agreed in the sources list; nothing that is live or not yet prepared. Only
// the chat is downloaded, never the video.
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { videoUrl } from '../fetchLink.js';
import { agreedSourceOf } from '../sources.js';
import { MAX_CHAT_MESSAGES, parseChatFile, parseYouTubeLiveChat } from './importChat.js';

/** @typedef {import('./importChat.js').ChatMessage} ChatMessage */
/**
 * @typedef {object} Chat
 * @property {{ kind: 'youtube', videoId: string } | { kind: 'file', name: string }} origin
 * @property {string} importedAt
 * @property {number} offset   seconds of the stream before this video starts
 * @property {ChatMessage[]} messages   in the stream's own time
 */

const chatSchema = z.object({
  version: z.literal(1),
  origin: z.union([
    z.object({ kind: z.literal('youtube'), videoId: z.string().regex(/^[\w-]{11}$/) }),
    z.object({ kind: z.literal('file'), name: z.string().max(200) }),
  ]),
  importedAt: z.string(),
  offset: z.number().finite(),
  messages: z.array(z.object({ t: z.number().finite(), author: z.string().max(64), text: z.string().max(400) })).max(MAX_CHAT_MESSAGES),
});

export const chatsDir = (dataDir) => path.join(dataDir, 'chats');
const chatFile = (dataDir, video) => path.join(chatsDir(dataDir), `${path.basename(video)}.json`);

/** @returns {Promise<Chat | null>} */
export async function readChat(dataDir, video) {
  let text;
  try {
    text = await readFile(chatFile(dataDir, video), 'utf8');
  } catch {
    return null;
  }
  const parsed = chatSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error('The saved chat for this video cannot be read. Import it again.');
  return parsed.data;
}

async function saveChat(dataDir, video, chat) {
  await mkdir(chatsDir(dataDir), { recursive: true });
  const file = chatFile(dataDir, video);
  const partial = `${file}.partial`;
  await writeFile(partial, JSON.stringify({ version: 1, ...chat }));
  await rename(partial, file);
  return chat;
}

export async function removeChat(dataDir, video) {
  await rm(chatFile(dataDir, video), { force: true });
}

/** Change only the offset of a saved chat. */
export async function setChatOffset(dataDir, video, offset) {
  if (!Number.isFinite(offset)) throw new Error('The offset must be a number of seconds.');
  const chat = await readChat(dataDir, video);
  if (!chat) throw new Error('This video has no chat yet.');
  return saveChat(dataDir, video, { ...chat, offset });
}

/**
 * What a video's file name says about where it came from, for a part fetched by
 * this tool: `<channel>_<video id>_<from>-<to>.mp4`. The offset is the part's start
 * in the stream (the file may begin a few seconds earlier, at a keyframe).
 *
 * @param {string} video
 * @returns {{ videoId: string, offset: number, end: number, link: string } | null}
 *   `end`: where the part ends in the stream
 */
export function fetchedOrigin(video) {
  const match = /_([\w-]{11})_((?:\d+h)?\d+m[\d.]+s)-((?:\d+h)?\d+m[\d.]+s)(?:_\d+)?\.mp4$/.exec(path.basename(video));
  if (!match) return null;
  const [, videoId, from, to] = match;
  const seconds = (stamp) => {
    const parts = /^(?:(\d+)h)?(\d+)m([\d.]+)s$/.exec(stamp);
    return Number(parts[1] ?? 0) * 3600 + Number(parts[2]) * 60 + Number(parts[3]);
  };
  return { videoId, offset: seconds(from), end: seconds(to), link: `https://www.youtube.com/watch?v=${videoId}` };
}

/**
 * The parts of a stream that are already in the videos folder, by their file names.
 * Parts fetched before the record of suggestions existed are found this way.
 *
 * @param {string} dir   the videos folder
 * @param {string} videoId
 * @returns {Promise<Array<{ start: number, end: number }>>}
 */
export async function partsInFolder(dir, videoId) {
  const names = await readdir(dir).catch(() => []);
  return names.map(fetchedOrigin).filter((origin) => origin?.videoId === videoId && origin.end > origin.offset).map((origin) => ({ start: origin.offset, end: origin.end }));
}

/**
 * Bring in a chat file the owner chose.
 *
 * @param {{ dataDir: string, video: string, name: string, text: string, offset?: number }} options
 * @returns {Promise<Chat>}
 */
export async function importChatFile({ dataDir, video, name, text, offset }) {
  const messages = parseChatFile(text, name);
  return saveChat(dataDir, video, {
    origin: { kind: 'file', name: path.basename(String(name)).slice(0, 200) },
    importedAt: new Date().toISOString(),
    offset: Number.isFinite(offset) ? offset : (fetchedOrigin(video)?.offset ?? 0),
    messages,
  });
}

/**
 * Fetch the chat replay of a finished stream from YouTube.
 *
 * @param {object} options
 * @param {string} options.dataDir
 * @param {string} options.video    the video in `in/` it belongs to
 * @param {string} options.url
 * @param {number} [options.offset]
 * @param {import('../sources.js').Source[]} options.sources
 * @param {import('../fetch.js').Downloader} options.downloader
 * @param {(step: string) => void} [options.onStep]
 * @returns {Promise<Chat>}
 */
export async function fetchChatReplay({ dataDir, video, url, offset, sources, downloader, onStep = () => {} }) {
  const link = videoUrl(url);
  const asked = new URL(link).searchParams.get('v');
  const fromName = fetchedOrigin(video);
  if (fromName && fromName.videoId !== asked) {
    throw new Error(`This video is a download of ${fromName.videoId}, so only that video's chat lines up with it, and the link is for ${asked}. To use the chat of ${asked}, download that video on the Download page first, open it, and fetch its chat there.`);
  }
  if (!(await downloader.isInstalled())) throw new Error('The downloader is not installed. Run "npm run setup" to install it.');
  onStep('looking');
  const info = await downloader.info(link);
  // The channel is read from the video itself, as for a video download.
  if (!agreedSourceOf(sources, info)) {
    throw new Error(`This video is from "${info.channel}", which is not in your sources list. Chat is fetched only from channels you added there.`);
  }
  if (info.live === 'is_live') throw new Error('This stream is live right now. Its chat replay can be fetched once it has ended.');
  if (info.live === 'is_upcoming') throw new Error('This stream has not started yet, so it has no chat.');
  if (info.live === 'post_live') throw new Error('This stream has only just ended and YouTube is still preparing it; its chat replay is not there yet. Try again later.');
  if (info.chat === false) throw new Error('This video has no chat replay on YouTube. It may not have been a live stream, or its chat was turned off.');

  const videoId = asked;
  onStep('chat');
  const messages = await streamChat({ dataDir, videoId, url: link, downloader });
  return saveChat(dataDir, video, {
    origin: { kind: 'youtube', videoId },
    importedAt: new Date().toISOString(),
    offset: Number.isFinite(offset) ? offset : (fetchedOrigin(video)?.videoId === videoId ? fetchedOrigin(video).offset : 0),
    messages,
  });
}

/**
 * A stream's whole chat, on the stream's own clock, kept under its YouTube id
 * (data/chats/youtube-<id>.json) so it is fetched once: the chat of a finished
 * stream does not change. Clips from chat and a part's own chat both use it.
 *
 * @param {{ dataDir: string, videoId: string, url: string, downloader: import('../fetch.js').Downloader }} options
 * @returns {Promise<ChatMessage[]>}
 */
export async function streamChat({ dataDir, videoId, url, downloader }) {
  const name = `youtube-${videoId}`;
  const kept = await readChat(dataDir, name).catch(() => null);
  if (kept) return kept.messages;
  await mkdir(chatsDir(dataDir), { recursive: true });
  const work = await mkdtemp(path.join(chatsDir(dataDir), '.incoming-'));
  try {
    const file = await downloader.chat({ url, dir: work, name: 'chat' });
    const messages = parseYouTubeLiveChat(await readFile(file, 'utf8'));
    await saveChat(dataDir, name, { origin: { kind: 'youtube', videoId }, importedAt: new Date().toISOString(), offset: 0, messages });
    return messages;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// The parts of a stream already given to the owner as clips from chat, so that asking
// again can skip them (asked for on 2026-11-22: "if I don't like either of those and
// ask again it gives me the same 20"). data/chats/suggested/<YouTube id>.json; it
// stays on this machine with the chats.
const suggestedFile = (dataDir, videoId) => path.join(chatsDir(dataDir), 'suggested', `${videoId}.json`);
const suggestedSchema = z.object({ parts: z.array(z.object({ start: z.number().finite().min(0), end: z.number().finite().min(0) })) });

/**
 * The parts of a stream already suggested, in the stream's seconds. A file that
 * cannot be read counts as none: it only ever narrows what is offered.
 *
 * @returns {Promise<Array<{ start: number, end: number }>>}
 */
export async function readSuggested(dataDir, videoId) {
  if (!/^[\w-]{11}$/.test(videoId)) return [];
  try {
    const parsed = suggestedSchema.safeParse(JSON.parse(await readFile(suggestedFile(dataDir, videoId), 'utf8')));
    return parsed.success ? parsed.data.parts : [];
  } catch {
    return [];
  }
}

/**
 * Add parts to a stream's record of what was suggested, each once.
 *
 * @param {string} dataDir
 * @param {string} videoId
 * @param {Array<{ start: number, end: number }>} parts
 */
export async function addSuggested(dataDir, videoId, parts) {
  if (!/^[\w-]{11}$/.test(videoId) || parts.length === 0) return;
  const all = await readSuggested(dataDir, videoId);
  for (const part of parts) {
    if (!all.some((one) => one.start === part.start && one.end === part.end)) all.push({ start: part.start, end: part.end });
  }
  all.sort((a, b) => a.start - b.start);
  const file = suggestedFile(dataDir, videoId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.partial`, `${JSON.stringify({ parts: all }, null, 2)}\n`);
  await rename(`${file}.partial`, file);
}

/**
 * A chat's messages on the video's own clock: shifted by the offset, and only
 * those that fall inside the video.
 *
 * @param {Chat} chat
 * @param {number} [duration]
 * @returns {ChatMessage[]}
 */
export function onVideoClock(chat, duration = Infinity) {
  const shifted = [];
  for (const message of chat.messages) {
    const t = message.t - chat.offset;
    if (t >= 0 && t <= duration) shifted.push({ ...message, t: Math.round(t * 1000) / 1000 });
  }
  return shifted;
}
