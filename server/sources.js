// The sources list and the fetch step (src/sources.js, src/fetch.js).
import { z } from 'zod';
import { fetchVideo, filePrefix, ytDlp } from '../src/fetch.js';
import { fetchPictures, listPictures, pictureFile, removeOtherPictures, syncSource } from '../src/pictures.js';
import { readSources, saveSources } from '../src/sources.js';
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
const fetchRequest = z.strictObject({ url: z.string().min(1).max(300), start: time, end: time });

/**
 * @param {import('express').Express} app
 * @param {object} options
 * @param {string} options.dataDir
 * @param {string} options.inDir
 * @param {ReturnType<import('./jobs.js').createJobs>} options.jobs
 * @param {import('../src/fetch.js').Downloader} [options.downloader]   replaced in tests
 * @param {(address: string) => Promise<Buffer>} [options.pictureDownload]   replaced in tests
 */
export function addSourceRoutes(app, { dataDir, inDir, jobs, downloader = ytDlp(), pictureDownload }) {
  // `prefixes` is what a file fetched from each source is named after, by source id.
  const answer = async (sources) => ({
    sources,
    // Which channels have a picture, by source id, with a number that changes when the picture does.
    pictures: await listPictures(dataDir, sources),
    prefixes: Object.fromEntries(sources.map((source) => [source.id, filePrefix(source.name)])),
    downloaderInstalled: await downloader.isInstalled(),
  });

  app.get('/api/sources', async (req, res) => {
    res.json(await answer(await readSources(dataDir)));
  });

  app.put('/api/sources', async (req, res) => {
    const sources = await saveSources(dataDir, req.body).catch((error) => {
      throw new HttpError(400, error.message);
    });
    // A channel taken out of the list takes its picture with it.
    await removeOtherPictures(dataDir, sources);
    res.json(await answer(sources));
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
    const source = { id: String(req.body?.id ?? ''), url: String(req.body?.url ?? ''), name: String(req.body?.name ?? '') };
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
    const { url, start, end } = parsed.data;
    const sources = await readSources(dataDir);
    const job = jobs.add('fetch', `${formatClock(start)}–${formatClock(end)} of a video`, async (onStep) => {
      const fetched = await fetchVideo({ url, start, end, sources, outDir: inDir, downloader, onStep });
      return { name: fetched.name, seconds: fetched.seconds, early: fetched.early, source: fetched.source.name, title: fetched.title };
    });
    res.status(202).json(job);
  });
}
