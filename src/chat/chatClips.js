// Clips from a finished stream's chat: the whole request the Download page makes.
//
// 1. Look the stream up, by the rules of `fetch`: one YouTube video, from an agreed
//    channel, finished, with a chat replay.
// 2. Fetch only its chat (or use the one kept from before).
// 3. Read the top comments, for the moments viewers point to.
// 4. Choose the moments: chat's reactions and the comments (pick.js).
// 5. Download only those parts of the video, through the ordinary fetch.
import { fetchVideo, ytDlp } from '../fetch.js';
import { videoUrl } from '../fetchLink.js';
import { isStopped } from '../run.js';
import { agreedSourceOf } from '../sources.js';
import { streamChat } from './chatStore.js';
import { CLIP_DEFAULTS, expandWords, pickChatMoments } from './pick.js';

/**
 * @param {object} options
 * @param {string} options.url
 * @param {string} [options.words]    words separated by commas, or nothing
 * @param {number} [options.count]
 * @param {number} [options.before]
 * @param {number} [options.after]
 * @param {import('../sources.js').Source[]} options.sources
 * @param {string} options.outDir    the videos folder
 * @param {string} options.dataDir
 * @param {import('../fetch.js').Downloader} [options.downloader]
 * @param {(step: string, detail?: unknown) => void} [options.onStep]
 */
export async function clipsFromChat({ url, words = '', count = CLIP_DEFAULTS.count, before = CLIP_DEFAULTS.before, after = CLIP_DEFAULTS.after, sources, outDir, dataDir, downloader = ytDlp(), onStep = () => {} }) {
  if (!Number.isInteger(count) || count < 1 || count > CLIP_DEFAULTS.maxCount) throw new Error(`Ask for 1 to ${CLIP_DEFAULTS.maxCount} clips.`);
  for (const seconds of [before, after]) {
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 120) throw new Error('The seconds before and after must each be between 1 and 120.');
  }
  const link = videoUrl(url);
  const groups = expandWords(words);
  if (!(await downloader.isInstalled())) throw new Error('The downloader is not installed. Run "npm run setup" to install it.');

  onStep('looking');
  const info = await downloader.info(link);
  const source = agreedSourceOf(sources, info);
  if (!source) {
    throw new Error(`This video is from "${info.channel}", which is not in your sources list. Only a channel you added there can be fetched from.`);
  }
  if (info.live === 'is_live') throw new Error('This stream is live right now. Its chat replay is there once it has ended.');
  if (info.live === 'is_upcoming') throw new Error('This stream has not started yet.');
  if (info.live === 'post_live') throw new Error('This stream has only just ended and YouTube is still preparing it. Try again later.');
  if (!info.chat) {
    throw new Error('This video has no chat replay, so there is nothing to read explosions from. Only a finished live stream keeps its chat; an uploaded video (an edited reaction, say) has comments but no chat.');
  }
  if (!(info.duration > 0)) throw new Error('YouTube did not say how long this stream is.');

  onStep('chat');
  const videoId = new URL(link).searchParams.get('v');
  const messages = await streamChat({ dataDir, videoId, url: link, downloader });

  // Viewers' own pointers to moments. Without them the clips come from the chat alone.
  onStep('comments');
  const comments = downloader.comments
    ? await downloader.comments(link).catch((error) => {
      if (isStopped()) throw error;
      return [];
    })
    : [];

  onStep('finding');
  const moments = pickChatMoments(messages, { duration: info.duration, groups, comments, count, before, after });
  if (moments.length === 0) throw new Error(`The chat never clearly exploded: ${messages.length} messages, spread evenly. Try another stream.`);

  // Each part is an ordinary fetch, with the stream looked up once for all of them.
  const once = { ...downloader, info: async () => info };
  const clips = [];
  for (const [index, moment] of moments.entries()) {
    onStep('fetching', { done: index, total: moments.length });
    try {
      const fetched = await fetchVideo({ url: link, start: moment.start, end: moment.end, sources, outDir, downloader: once });
      clips.push({ ...moment, name: fetched.name, seconds: fetched.seconds, early: fetched.early, slow: fetched.slow });
    } catch (error) {
      // One part that fails does not cost the others; a stop ends them all.
      if (isStopped()) throw error;
      clips.push({ ...moment, error: error.message });
    }
  }
  return {
    videoId, title: info.title, channel: source.name, messages: messages.length, comments: comments.length,
    words: groups.map((group) => group.label), asked: count,
    matched: clips.filter((clip) => clip.matched).length, clips,
  };
}
