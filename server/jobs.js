import { STOPPED, withStop } from '../src/run.js';

/**
 * Runs slow work (a cut, a re-render) in the background, one job at a time.
 * One at a time matters: two cuts starting together could pick the same
 * clip folder, and each render already uses every CPU core.
 *
 * A job can be stopped: one that is waiting never starts, and one that is
 * running has its program ended (see withStop in src/run.js).
 *
 * @typedef {object} Job
 * @property {string} id
 * @property {string} kind      'cut' or 'render'
 * @property {string} label     shown to the person waiting
 * @property {'queued' | 'running' | 'done' | 'failed' | 'stopped'} status
 * @property {string | null} step      the slow step in progress
 * @property {unknown} detail          more about the step, such as the state of each item
 * @property {string | null} error
 * @property {unknown} result
 * @property {number} createdAt
 * @property {number | null} startedAt
 * @property {number | null} finishedAt
 */

const KEEP_FINISHED = 50;

export function createJobs() {
  /** @type {Map<string, Job>} */
  const jobs = new Map();
  /** How to stop each job that has not finished: job id -> its controller. */
  const stoppers = new Map();
  let nextId = 1;
  let queue = Promise.resolve();

  /**
   * @param {string} kind
   * @param {string} label
   * @param {(onStep: (step: string, detail?: unknown) => void) => Promise<unknown>} work
   * @returns {Job}
   */
  function add(kind, label, work) {
    /** @type {Job} */
    const job = {
      id: String(nextId++), kind, label, status: 'queued', step: null, detail: null, error: null, result: null,
      createdAt: Date.now(), startedAt: null, finishedAt: null,
    };
    jobs.set(job.id, job);
    const stopper = new AbortController();
    stoppers.set(job.id, stopper);
    queue = queue.then(async () => {
      if (job.status === 'stopped') return; // stopped while it was waiting its turn
      job.status = 'running';
      job.startedAt = Date.now();
      try {
        job.result = await withStop(stopper.signal, () => work((step, detail = null) => {
          job.step = step;
          job.detail = detail;
        }));
        job.status = 'done';
      } catch (error) {
        // Whatever the work said when its program was ended, the reason is that it was stopped.
        job.status = stopper.signal.aborted ? 'stopped' : 'failed';
        job.error = stopper.signal.aborted ? STOPPED : error.message;
      }
      job.step = null;
      job.finishedAt = Date.now();
      stoppers.delete(job.id);
      forgetOldest();
    });
    return job;
  }

  /**
   * Stop a job that is waiting or running. A waiting one is finished at once;
   * a running one finishes as soon as its program has ended.
   *
   * @param {string} id
   * @returns {Job | null} the job, or null when there is no such job or it has already finished
   */
  function stop(id) {
    const job = jobs.get(id);
    const stopper = stoppers.get(id);
    if (!job || !stopper || job.finishedAt !== null) return null;
    stopper.abort();
    if (job.status === 'queued') {
      job.status = 'stopped';
      job.error = STOPPED;
      job.finishedAt = Date.now();
      stoppers.delete(id);
    }
    return job;
  }

  function forgetOldest() {
    const finished = [...jobs.values()].filter((job) => job.finishedAt !== null);
    for (const job of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) jobs.delete(job.id);
  }

  return {
    add,
    stop,
    get: (id) => jobs.get(id) ?? null,
    /** Every job still remembered, oldest first. */
    list: () => [...jobs.values()],
    /** Whether anything is waiting or running. */
    busy: () => [...jobs.values()].some((job) => job.finishedAt === null),
    /** Resolves when everything queued so far has finished. */
    idle: () => queue,
  };
}
