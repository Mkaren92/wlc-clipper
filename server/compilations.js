// Compilations: a timeline of videos and cards, rendered into one video
// (src/compilation/).
import { createWriteStream } from 'node:fs';
import { readFile, rename, rm, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { buildCompilation } from '../src/compilation/build.js';
import { compilationDir, deleteCompilation, listCompilations, newCompilationId, readTimeline, saveTimeline } from '../src/compilation/timeline.js';
import { probe } from '../src/probe.js';
import { creditLinks, readSources } from '../src/sources.js';
import { HttpError } from './http.js';

/**
 * @param {import('express').Express} app
 * @param {object} options
 * @param {string} options.dataDir
 * @param {string} options.inDir
 * @param {ReturnType<import('./jobs.js').createJobs>} options.jobs
 * @param {(library: string, name: string) => Promise<string>} options.resolveVideo
 *   turns a video's folder and name into a path, or throws a 404
 * @param {(name: string) => boolean} options.isVideoName
 */
export function addCompilationRoutes(app, { dataDir, inDir, jobs, resolveVideo, isVideoName }) {
  const asHttp = (error) => {
    throw new HttpError(/^No such/.test(error.message) ? 404 : 400, error.message);
  };
  const readText = (file) => readFile(file, 'utf8').catch(() => null);

  /** A timeline with what was last generated from it, if anything. */
  async function withResult(timeline) {
    const dir = compilationDir(dataDir, timeline.id);
    const final = await stat(path.join(dir, 'final.mp4')).catch(() => null);
    return {
      ...timeline,
      // The file keeps its address when generated again; the page adds this number to get the new one.
      final: final ? { version: Math.round(final.mtimeMs), size: final.size } : null,
      description: final ? await readText(path.join(dir, 'description.txt')) : null,
    };
  }

  // The page gets `final` and `description` with a timeline and sends the
  // whole thing back when saving; those two are not part of what is stored.
  const timelineFrom = ({ final: _final, description: _description, ...timeline } = {}) => timeline;

  app.get('/api/compilations', async (req, res) => {
    res.json(await Promise.all((await listCompilations(dataDir)).map(withResult)));
  });

  app.post('/api/compilations', async (req, res) => {
    const name = String(req.body?.name ?? '').trim() || 'Compilation';
    const id = await newCompilationId(dataDir, name);
    res.status(201).json(await withResult(await saveTimeline(dataDir, { ...timelineFrom(req.body), id, name }).catch(asHttp)));
  });

  app.get('/api/compilations/:id', async (req, res) => {
    res.json(await withResult(await readTimeline(dataDir, req.params.id).catch(asHttp)));
  });

  app.put('/api/compilations/:id', async (req, res) => {
    await readTimeline(dataDir, req.params.id).catch(asHttp);
    res.json(await withResult(await saveTimeline(dataDir, { ...timelineFrom(req.body), id: req.params.id }).catch(asHttp)));
  });

  app.delete('/api/compilations/:id', async (req, res) => {
    if (jobs.busy()) throw new HttpError(409, 'A video is being made right now. Try again when it has finished.');
    await deleteCompilation(dataDir, req.params.id).catch(asHttp);
    res.json({ ok: true });
  });

  // Renders the saved timeline. Each item's state is reported as it goes.
  app.post('/api/compilations/:id/generate', async (req, res) => {
    const timeline = await readTimeline(dataDir, req.params.id).catch(asHttp);
    const job = jobs.add('compile', timeline.name, async (onStep) => {
      const states = timeline.items.map(() => 'waiting');
      onStep('items', { items: states });
      const built = await buildCompilation({
        timeline, dataDir, resolveVideo,
        links: creditLinks(await readSources(dataDir)),
        onProgress: (progress) => {
          if (progress.joining) return onStep('joining', { items: [...states] });
          states[progress.index] = progress.status;
          onStep('items', { items: [...states] });
        },
      });
      return { compilation: timeline.id, seconds: built.seconds, items: built.items };
    });
    res.status(202).json(job);
  });

  app.get('/media/compilations/:id/final.mp4', async (req, res) => {
    const timeline = await readTimeline(dataDir, req.params.id).catch(asHttp);
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(compilationDir(dataDir, timeline.id), 'final.mp4'), { cacheControl: false }, (error) => {
      if (error && !res.headersSent) res.status(404).json({ error: 'This compilation has not been generated yet.' });
    });
  });

  // Length and size of a video in one of the folders, for the timeline's running total.
  app.get('/api/library/:library/:name', async (req, res) => {
    const file = await resolveVideo(req.params.library, req.params.name);
    const { path: _path, ...info } = await probe(file);
    res.json(info);
  });

  // A file chosen in the browser arrives as a copy, since a page cannot tell
  // the server where the original is. It is streamed straight into the videos
  // folder, however large, and takes that much disk space.
  app.put('/api/uploads/:name', async (req, res) => {
    const name = req.params.name;
    if (!isVideoName(name)) throw new HttpError(400, 'Only video files can be added: .mp4, .mov, .mkv, .webm, .m4v or .avi.');
    const size = Number(req.headers['content-length']);
    if (!Number.isFinite(size) || size <= 0) throw new HttpError(411, 'The upload must say how large it is.');
    const file = path.join(inDir, name);
    const existing = await stat(file).catch(() => null);
    // The same file again (same name, same size) is not copied a second time.
    if (existing?.size === size) {
      req.resume();
      return res.json({ name, copied: false });
    }
    if (existing) throw new HttpError(409, `A different video named ${name} is already in the videos folder. Rename one of them.`);
    const disk = await statfs(inDir).catch(() => null);
    if (disk && disk.bavail * disk.bsize < size + 200_000_000) {
      throw new HttpError(507, `There is not enough free disk space to copy ${name} (${(size / 1e9).toFixed(1)} GB).`);
    }
    const partial = path.join(inDir, `.${name}.uploading`);
    try {
      await pipeline(req, createWriteStream(partial));
      await rename(partial, file);
    } finally {
      await rm(partial, { force: true });
    }
    res.status(201).json({ name, copied: true });
  });
}
