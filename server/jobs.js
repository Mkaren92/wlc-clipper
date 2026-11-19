/**
 * Runs slow work (a cut, a re-render) in the background, one job at a time.
 * One at a time matters: two cuts starting together could pick the same
 * clip folder, and each render already uses every CPU core.
 *
 * @typedef {object} Job
 * @property {string} id
 * @property {string} kind      'cut' or 'render'
 * @property {string} label     shown to the person waiting
 * @property {'queued' | 'running' | 'done' | 'failed'} status
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
    queue = queue.then(async () => {
      job.status = 'running';
      job.startedAt = Date.now();
      try {
        job.result = await work((step, detail = null) => {
          job.step = step;
          job.detail = detail;
        });
        job.status = 'done';
      } catch (error) {
        job.error = error.message;
        job.status = 'failed';
      }
      job.step = null;
      job.finishedAt = Date.now();
      forgetOldest();
    });
    return job;
  }

  function forgetOldest() {
    const finished = [...jobs.values()].filter((job) => job.finishedAt !== null);
    for (const job of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) jobs.delete(job.id);
  }

  return {
    add,
    get: (id) => jobs.get(id) ?? null,
    /** Every job still remembered, oldest first. */
    list: () => [...jobs.values()],
    /** Whether anything is waiting or running. */
    busy: () => [...jobs.values()].some((job) => job.finishedAt === null),
    /** Resolves when everything queued so far has finished. */
    idle: () => queue,
  };
}
