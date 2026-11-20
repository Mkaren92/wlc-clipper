// "My data": one file to download with everything the owner has made or
// added, and loading such a file on another machine (src/transfer/).
import { statfs } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { countHere, dataFile, discardWaiting, putInPlace, takeIn, waiting } from '../src/transfer/transfer.js';
import { HttpError } from './http.js';

/**
 * @param {import('express').Express} app
 * @param {object} options
 * @param {import('../src/transfer/contents.js').Folders} options.folders   where each kind of data lives
 * @param {ReturnType<import('./jobs.js').createJobs>} options.jobs
 */
export function addTransferRoutes(app, { folders, jobs }) {
  // Files must not change under a download, nor be replaced under a job that reads them.
  const whileIdle = () => {
    if (jobs.busy()) throw new HttpError(409, 'A video is being made right now. Try again when it has finished.');
  };
  // A file taken in before the dashboard was restarted is not left lying on the disk.
  discardWaiting(folders).catch(() => {});

  // What a download would hold, what is here, and what is waiting to be loaded.
  app.get('/api/transfer', async (req, res) => {
    const file = await dataFile(folders);
    const disk = await statfs(folders.data).catch(() => null);
    res.json({
      file: { files: file.files, bytes: file.bytes },
      free: disk ? disk.bavail * disk.bsize : null,
      here: await countHere(folders),
      waiting: await waiting(folders),
    });
  });

  // The data file itself, sent straight from disk. Nothing is copied to make it.
  app.get('/api/transfer/download', async (req, res) => {
    whileIdle();
    const file = await dataFile(folders);
    res.set({
      'Content-Type': 'application/x-tar',
      'Content-Length': String(file.bytes),
      'Content-Disposition': `attachment; filename="${file.name}"`,
      'Cache-Control': 'no-store',
    });
    await pipeline(Readable.from(file.stream()), res);
  });

  // Step 1 of a load: the file is taken in and checked. Nothing here is changed by it.
  app.put('/api/transfer/upload', async (req, res) => {
    whileIdle();
    const bytes = Number(req.headers['content-length']);
    if (!Number.isFinite(bytes) || bytes <= 0) throw new HttpError(411, 'The upload must say how large it is.');
    const summary = await takeIn(folders, req, bytes).catch((error) => {
      req.resume();
      throw new HttpError(400, error.message);
    });
    res.status(201).json(summary);
  });

  // Step 2: what was taken in is put in place. Everything it replaces is kept aside.
  app.post('/api/transfer/apply', async (req, res) => {
    whileIdle();
    res.json(await putInPlace(folders).catch((error) => {
      throw new HttpError(400, error.message);
    }));
  });

  app.delete('/api/transfer/waiting', async (req, res) => {
    await discardWaiting(folders);
    res.json({ ok: true });
  });
}
