// The sources list and the fetch step (src/sources.js, src/fetch.js).
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareTranscript } from '../src/ai/suggest.js';
import { fetchVideo, filePrefix, ytDlp } from '../src/fetch.js';
import { checkLive } from '../src/live.js';
import { fetchPictures, listPictures, listSubscribers, pictureFile, removeOtherPictures, syncSource } from '../src/pictures.js';
import { readSources, removeSource, saveSources, setSourceClubs } from '../src/sources.js';
import { formatClock, parseTime } from '../src/time.js';
import { HttpError } from './http.js';

const time = z.union([z.number().nonnegative(), z.string().min(1)]).transform((value, ctx) => {
  if (typeof value === 'number') return value;
  try {
    return parseTime(value);
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: error.message });
    return z.NEVER;
  }
});
// A part (start and end), or the whole video.
// `transcribe`: make the whole transcript for "Suggest moments" straight after, as a job of its own.
const fetchRequest = z.strictObject({ url: z.string().min(1).max(300), start: time.optional(), end: time.optional(), whole: z.boolean().optional(), transcribe: z.boolean().optional() })
  .refine((ask) => ask.whole === true || (ask.start !== undefined && ask.end !== undefined), { message: 'Give the start and the end of the part, or ask for the whole video.' });

/**
 * @param {import('express').Express} app
 * @param {object} options
 * @param {string} options.dataDir
 * @param {string} options.inDir
 * @param {ReturnType<import('./jobs.js').createJobs>} options.jobs
 * @param {import('../src/fetch.js').Downloader} [options.downloader]   replaced in tests
 * @param {(address: string) => Promise<Buffer>} [options.pictureDownload]   replaced in tests
 * @param {string} [options.cacheDir]   where whole-video transcripts are kept (out/.cache)
 * @param {() => import('../src/transcribe/index.js').Transcriber} [options.transcriber]   the transcriber, asked for when needed
 */
export function addSourceRoutes(app, { dataDir, inDir, jobs, downloader = ytDlp(), pictureDownload, cacheDir, transcriber }) {
  // `prefixes` is what a file fetched from each source is named after, by source id.
  // A mark that changes whenever the saved list does. A page sends it back with a whole-list save,
  // so a page that read the list before a sync (or another tab) changed it cannot write the old list back.
  const versionNow = async () => createHash('sha256').update(await readFile(path.join(dataDir, 'sources.json'), 'utf8').catch(() => '')).digest('hex').slice(0, 16);
  const answer = async (sources) => ({
    sources,
    version: await versionNow(),
    // Which channels have a picture, by source id, with a number that changes when the picture does.
    pictures: await listPictures(dataDir, sources),
    // How many subscribers each channel had when it was last looked up, by source id.
    subscribers: await listSubscribers(dataDir, sources),
    prefixes: Object.fromEntries(sources.map((source) => [source.id, filePrefix(source.name)])),
    downloaderInstalled: await downloader.isInstalled(),
  });

  app.get('/api/sources', async (req, res) => {
    res.json(await answer(await readSources(dataDir)));
  });

  app.put('/api/sources', async (req, res) => {
    const based = req.get('X-List-Version');
    if (based && based !== (await versionNow())) {
      throw new HttpError(409, 'The channels list changed since this page read it (a sync from your other PC, or another tab). Reload the page, then make your change again.');
    }
    const sources = await saveSources(dataDir, req.body).catch((error) => {
      throw new HttpError(400, error.message);
    });
    // A channel taken out of the list takes its picture with it.
    await removeOtherPictures(dataDir, sources);
    res.json(await answer(sources));
  });

  // One channel's clubs, saved the moment they are chosen. Only that channel is changed on disk.
  app.put('/api/sources/:id/clubs', async (req, res) => {
    const sources = await setSourceClubs(dataDir, req.params.id, req.body?.clubs).catch((error) => {
      throw new HttpError(/^No such/.test(error.message) ? 404 : 400, error.message);
    });
    res.json(await answer(sources));
  });

  // Takes one channel out of the saved list, with its picture and subscriber count.
  app.delete('/api/sources/:id', async (req, res) => {
    const sources = await removeSource(dataDir, req.params.id).catch((error) => {
      throw new HttpError(/^No such/.test(error.message) ? 404 : 400, error.message);
    });
    await removeOtherPictures(dataDir, sources);
    res.json(await answer(sources));
  });

  // Which channels are live. The last answer is remembered here, in memory, with
  // when it was given; it is not a job, so it never waits behind a cut.
  let lastLive = { checked: null, channels: {} };
  let checking = null;
  /** The last answer, for the channels that are in the list now. */
  const liveNow = async () => {
    const ids = new Set((await readSources(dataDir)).map((source) => source.id));
    return { checked: lastLive.checked, channels: Object.fromEntries(Object.entries(lastLive.channels).filter(([id]) => ids.has(id))) };
  };

  app.get('/api/sources/live', async (req, res) => res.json(await liveNow()));

  // Asks YouTube about every channel in the saved list. Nothing in the request says which.
  app.post('/api/sources/live', async (req, res) => {
    if (!(await downloader.isInstalled())) throw new HttpError(400, 'The downloader is not installed. Run "npm run setup" to install it.');
    // Two pages asking at once share one round of questions.
    checking ??= (async () => {
      const channels = await checkLive({ sources: await readSources(dataDir), downloader });
      lastLive = { checked: new Date().toISOString(), channels };
    })().finally(() => {
      checking = null;
    });
    await checking;
    res.json(await liveNow());
  });

  // Fetches the profile picture of every channel in the saved list, as a job.
  // Nothing in the request says which channels: the list is the saved one.
  app.post('/api/sources/pictures', async (req, res) => {
    const sources = await readSources(dataDir);
    const job = jobs.add('pictures', 'the channels\' pictures', (onStep) => fetchPictures({ sources, dataDir, downloader, download: pictureDownload, onStep }));
    res.status(202).json(job);
  });

  // Fills one channel in from its address: its name when none was typed, and its
  // picture, and puts it in the saved list. Only the row's id, address and name are taken.
  app.post('/api/sources/sync', async (req, res) => {
    const source = {
      id: String(req.body?.id ?? ''), url: String(req.body?.url ?? ''), name: String(req.body?.name ?? ''),
      // Checked with the rest of the list when it is saved.
      clubs: Array.isArray(req.body?.clubs) ? req.body.clubs : undefined,
    };
    if (source.url.length > 200 || source.name.length > 80 || source.id.length > 80) throw new HttpError(400, 'That is not a channel this tool can look up.');
    const job = jobs.add('channel', source.name.trim() || source.url.trim() || 'a channel', () => syncSource({ source, dataDir, downloader, download: pictureDownload }));
    res.status(202).json(job);
  });

  app.get('/media/source-pictures/:id', async (req, res) => {
    const sources = await readSources(dataDir);
    if (!sources.some((source) => source.id === req.params.id)) throw new HttpError(404, 'No such channel.');
    res.set('Cache-Control', 'no-store');
    res.sendFile(pictureFile(dataDir, req.params.id), { cacheControl: false }, (error) => {
      if (error && !res.headersSent) res.status(404).json({ error: 'This channel has no picture yet.' });
    });
  });

  // Brings a time range of a video into the videos folder. The engine
  // refuses any video whose channel is not marked as agreed.
  app.post('/api/fetch', async (req, res) => {
    const parsed = fetchRequest.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error));
    const { url, start, end, whole = false, transcribe = false } = parsed.data;
    const sources = await readSources(dataDir);
    const job = jobs.add('fetch', whole ? 'the whole of a video' : `${formatClock(start)}–${formatClock(end)} of a video`, async (onStep) => {
      const fetched = await fetchVideo({ url, start, end, whole, sources, outDir: inDir, downloader, onStep });
      // The transcript is a job of its own, after this one, so it shows in Activity and can be stopped
      // without losing the download. "Suggest moments" then finds it made.
      const transcript = transcribe && cacheDir && transcriber
        ? jobs.add('transcript', fetched.name, (step) => prepareTranscript({ source: fetched.file, cacheDir, transcriber: transcriber(), onStep: step })).id
        : null;
      return { name: fetched.name, seconds: fetched.seconds, early: fetched.early, source: fetched.source.name, title: fetched.title, slow: fetched.slow, transcript };
    });
    res.status(202).json(job);
  });
}
