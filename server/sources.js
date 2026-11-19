// The sources list and the fetch step (src/sources.js, src/fetch.js).
import { z } from 'zod';
import { fetchVideo, filePrefix, ytDlp } from '../src/fetch.js';
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
 */
export function addSourceRoutes(app, { dataDir, inDir, jobs, downloader = ytDlp() }) {
  // `prefixes` is what a file fetched from each source is named after, by source id.
  const answer = async (sources) => ({
    sources,
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
    res.json(await answer(sources));
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
