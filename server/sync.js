// Syncing the owner's data with a private GitHub repository (src/sync/).
//
// Once a machine is connected, the server keeps it in step by itself: it
// syncs when the dashboard starts, and then looks once a minute whether
// anything that travels changed here or on GitHub, and syncs if so. It is
// not a job: it uses no processor to speak of, and it steps aside while a
// video is being made.
import { createSync } from '../src/sync/sync.js';
import { HttpError } from './http.js';

/**
 * @param {import('express').Express} app
 * @param {object} options
 * @param {import('../src/transfer/contents.js').Folders} options.folders
 * @param {string} options.codeDir   the project's own folder
 * @param {ReturnType<import('./jobs.js').createJobs>} options.jobs
 * @param {number} [options.every]   how often to look for changes, in milliseconds; 0 for never (tests)
 * @param {boolean} [options.anyAddress]   for tests, which sync with a folder
 */
export function addSyncRoutes(app, { folders, codeDir, jobs, every = 60_000, anyAddress = false }) {
  const sync = createSync({ folders, codeDir, anyAddress });
  // What the page is told. `state` is "off" (not connected), "idle", "syncing", "offline" or "error".
  const status = { state: 'off', message: '', last: null, result: null };
  let running = null;
  let mark = null; // this machine's data as it was after the last sync

  // Looking at an address, connecting and disconnecting each rebuild or remove the copy kept for
  // syncing, so only one of them, or one round, may run at a time. (On 2026-11-23 a connect lost
  // that copy's .git folder halfway, which is what two of them overlapping does.)
  let doing = null;
  async function alone(work) {
    if (doing || running) throw new HttpError(409, 'Sync is busy with something else. Try again in a moment.');
    doing = work();
    try {
      return await doing;
    } finally {
      doing = null;
    }
  }

  /** One round, unless one is already going on. */
  function round() {
    if (doing) return Promise.resolve();
    running ??= (async () => {
      if (!(await sync.state()).connected) {
        Object.assign(status, { state: 'off', message: '' });
        return;
      }
      if (jobs.busy()) return; // not while a video is being made; the next look will find the change still there
      status.state = 'syncing';
      try {
        const result = await sync.sync();
        // As the round saw this machine, not as it is now: a change made while it ran is then still seen as new.
        mark = result.mark;
        if (result.state === 'offline') Object.assign(status, { state: 'offline', message: 'GitHub could not be reached. Your changes are kept and will be sent on the next try.' });
        else {
          const changed = result.sent || result.arrived.length > 0 || result.setAside.length > 0 || result.clashes.length > 0;
          Object.assign(status, { state: 'idle', message: '', last: new Date().toISOString(), result: changed || !status.result ? { ...result, at: new Date().toISOString() } : status.result });
        }
      } catch (error) {
        Object.assign(status, { state: 'error', message: error.message.split('\n')[0] });
      }
    })().finally(() => {
      running = null;
    });
    return running;
  }

  /** Look whether anything changed here or on GitHub, and sync if so. */
  async function look() {
    if (running || doing || jobs.busy() || !(await sync.state()).connected) return;
    const changedHere = (await sync.fingerprint()) !== mark;
    const changedThere = changedHere ? false : await sync.behind().catch(() => false);
    if (changedHere || changedThere || status.state === 'offline' || status.state === 'error') await round();
  }
  if (every > 0) {
    setTimeout(() => round().catch(() => {}), 3000).unref();
    setInterval(() => look().catch(() => {}), every).unref();
  }

  const answer = async () => ({ ...(await sync.state()), ...status, state: (await sync.state()).connected ? (status.state === 'off' ? 'idle' : status.state) : 'off' });
  const whileIdle = () => {
    if (jobs.busy()) throw new HttpError(409, 'A video is being made right now. Try again when it has finished.');
  };
  const friendly = (error) => {
    throw new HttpError(400, error.message.split('\n')[0]);
  };

  app.get('/api/sync', async (req, res) => res.json(await answer()));

  // Looks at an address before connecting: is GitHub's side empty, and what does each side hold?
  app.post('/api/sync/look', async (req, res) => {
    whileIdle();
    if ((await sync.state()).connected) throw new HttpError(409, 'This PC is already connected. Disconnect first to use another repository.');
    res.json(await alone(() => sync.look(req.body?.address).catch(friendly)));
  });

  // Connects this machine. When GitHub already holds data, `wins` says whose lists are kept.
  app.post('/api/sync/connect', async (req, res) => {
    whileIdle();
    const wins = req.body?.wins === 'github' || req.body?.wins === 'here' ? req.body.wins : undefined;
    const result = await alone(() => sync.connect(req.body?.address, wins).catch(friendly));
    mark = null;
    Object.assign(status, { state: 'idle', message: '', last: new Date().toISOString(), result: { ...result, clashes: [], state: 'synced', at: new Date().toISOString() } });
    res.json(await answer());
  });

  app.post('/api/sync/now', async (req, res) => {
    whileIdle();
    await round();
    res.json(await answer());
  });

  // Stops syncing on this machine. Its data stays, and so does GitHub's.
  app.delete('/api/sync', async (req, res) => {
    await alone(() => sync.disconnect());
    Object.assign(status, { state: 'off', message: '', last: null, result: null });
    res.json(await answer());
  });
}
