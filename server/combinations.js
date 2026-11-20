// Combinations: two videos shown side by side, made into one video
// (src/combine/). The finished video is offered to compilations as one more
// folder of videos, "combined".
import { buildCombination } from '../src/combine/build.js';
import { combinedFile, combinedResult, deleteCombination, listCombinations, newCombinationId, readCombination, saveCombination } from '../src/combine/combination.js';
import { HttpError } from './http.js';

/**
 * @param {import('express').Express} app
 * @param {object} options
 * @param {string} options.dataDir
 * @param {ReturnType<import('./jobs.js').createJobs>} options.jobs
 * @param {(library: string, name: string) => Promise<string>} options.resolveVideo
 *   turns a video's folder and name into a path, or throws a 404
 */
export function addCombinationRoutes(app, { dataDir, jobs, resolveVideo }) {
  const asHttp = (error) => {
    throw new HttpError(/^No such/.test(error.message) ? 404 : 400, error.message);
  };
  /** A combination with what was last made from it, if anything. */
  const withResult = async (combination) => ({ ...combination, result: await combinedResult(dataDir, combination) });
  // The page gets `result` with a combination and sends the whole thing back when saving; it is not stored.
  const settingsFrom = ({ result: _result, ...combination } = {}) => combination;

  app.get('/api/combinations', async (req, res) => {
    res.json(await Promise.all((await listCombinations(dataDir)).map(withResult)));
  });

  app.post('/api/combinations', async (req, res) => {
    const name = String(req.body?.name ?? '').trim() || 'Combination';
    const id = await newCombinationId(dataDir, name);
    res.status(201).json(await withResult(await saveCombination(dataDir, { ...settingsFrom(req.body), id, name }).catch(asHttp)));
  });

  app.get('/api/combinations/:id', async (req, res) => {
    res.json(await withResult(await readCombination(dataDir, req.params.id).catch(asHttp)));
  });

  app.put('/api/combinations/:id', async (req, res) => {
    await readCombination(dataDir, req.params.id).catch(asHttp);
    res.json(await withResult(await saveCombination(dataDir, { ...settingsFrom(req.body), id: req.params.id }).catch(asHttp)));
  });

  app.delete('/api/combinations/:id', async (req, res) => {
    if (jobs.busy()) throw new HttpError(409, 'A video is being made right now. Try again when it has finished.');
    await deleteCombination(dataDir, req.params.id).catch(asHttp);
    res.json({ ok: true });
  });

  // Makes the video from the saved settings.
  app.post('/api/combinations/:id/generate', async (req, res) => {
    const combination = await readCombination(dataDir, req.params.id).catch(asHttp);
    const job = jobs.add('combine', combination.name, async () => {
      const built = await buildCombination({ combination, dataDir, resolveVideo });
      return { combination: combination.id, seconds: built.seconds, split: built.split };
    });
    res.status(202).json(job);
  });

  // The video keeps its address when made again; the page adds a version number, and it is sent uncached.
  app.get('/media/combinations/:id/combined.mp4', async (req, res) => {
    const combination = await readCombination(dataDir, req.params.id).catch(asHttp);
    res.set('Cache-Control', 'no-store');
    res.sendFile(combinedFile(dataDir, combination.id), { cacheControl: false }, (error) => {
      if (error && !res.headersSent) res.status(404).json({ error: 'This combination has not been generated yet.' });
    });
  });
}
