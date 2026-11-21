// What the server is working on, kept in one place so every screen shows the
// same thing and it survives moving between screens or reloading the page.
import { reactive } from 'vue';
import { api } from './api.js';

const STEP_NAMES = {
  transcribing: 'transcribing the speech',
  rendering: 'rendering',
  items: 'making the segments',
  looking: 'looking the video up',
  fetching: 'downloading the part',
  'fetching-slow': 'downloading the part the slow way',
  pictures: 'asking YouTube',
  tidying: 'preparing the video',
  joining: 'joining them',
  checking: 'checking the result',
  thinking: 'waiting for the AI service',
};

export const jobs = reactive({
  /** Every job the server remembers, oldest first. */
  list: [],
  /** Moments last suggested for each video, by file name. */
  suggestions: {},
  /** Suggestions already sent for cutting, by file name: a list of "start-end" keys. */
  cutMoments: {},
  /** Finished jobs the person has closed the notice for. */
  dismissed: [],
  now: Date.now(),
});

// Jobs this page watched while they ran. Only these get a "ready" notice, so
// a reload does not bring back notices for clips made hours ago.
const watched = new Set();
// Callers waiting for a particular job: id -> { resolve, reject }.
const waiting = new Map();
let timer = null;

export const isActive = (job) => job.status === 'queued' || job.status === 'running';

/**
 * Follow a job that was just started. The promise settles when it finishes,
 * but the job is shown in the side column whether or not anyone still waits.
 *
 * @returns {Promise<any>} the job's result
 */
export function track(job) {
  watched.add(job.id);
  if (!jobs.list.some((known) => known.id === job.id)) jobs.list.push(job);
  const done = new Promise((resolve, reject) => waiting.set(job.id, { resolve, reject }));
  refresh();
  return done;
}

/** Ask the server what it is doing. Keeps asking while anything is running. */
export async function refresh() {
  clearTimeout(timer);
  try {
    jobs.list = await api.jobs();
  } catch {
    // The server may be restarting; try again shortly.
    timer = setTimeout(refresh, 2000);
    return;
  }
  jobs.now = Date.now();

  for (const job of jobs.list) {
    if (isActive(job)) {
      watched.add(job.id);
      continue;
    }
    if (job.kind === 'suggest' && job.status === 'done') jobs.suggestions[job.label] = job.result.moments;
    const waiter = waiting.get(job.id);
    if (waiter) {
      waiting.delete(job.id);
      if (job.status === 'done') waiter.resolve(job.result);
      else waiter.reject(new Error(job.error));
    }
  }
  if (jobs.list.some(isActive)) timer = setTimeout(refresh, 800);
}

/** Jobs to show under "Activity" in the side column: everything running, and watched jobs that just finished. */
export function visibleJobs() {
  return jobs.list.filter((job) => isActive(job) || (watched.has(job.id) && !jobs.dismissed.includes(job.id)));
}

/** One line saying what a job is and how far along it is. */
export function describe(job) {
  const what = {
    cut: `Cutting ${job.label}`,
    part: `Saving part of ${job.label}`,
    compile: `Generating ${job.label}`,
    combine: `Combining ${job.label}`,
    fetch: `Fetching ${job.label}`,
    pictures: 'Updating the channels\' pictures and subscribers',
    channel: `Looking up ${job.label}`,
    render: `Rendering ${job.label} again`,
    suggest: `Finding moments in ${job.label}`,
  }[job.kind] ?? job.label;
  if (job.status === 'queued') return `${what}: waiting for the job before it`;
  if (job.status === 'running') {
    const seconds = Math.max(0, Math.round((jobs.now - (job.startedAt ?? job.createdAt)) / 1000));
    return `${what}: ${STEP_NAMES[job.step] ?? (job.kind === 'part' || job.kind === 'combine' ? 'encoding' : 'starting')}… ${seconds} s`;
  }
  if (job.status === 'stopped') return `${what}: stopped.`;
  if (job.status === 'failed') return `${what} failed. ${job.error}`;
  return {
    cut: `${job.result.clip} is ready.`,
    part: `${job.result.name} is saved.`,
    compile: `${job.label} is ready.`,
    combine: `${job.label} is combined. It is in Compilations, under “Add videos”.`,
    pictures: `${job.result?.fetched?.length ?? 0} ${job.result?.fetched?.length === 1 ? 'channel' : 'channels'} updated.${job.result?.failed?.length ? ` Not fetched: ${job.result.failed.map((one) => `${one.name} (${one.error})`).join('; ')}` : ''}`,
    channel: `${job.result?.source?.name} is in your channels.${job.result?.pictureError ? ` Its picture was not fetched: ${job.result.pictureError}` : ''}`,
    fetch: `${job.result?.name} is in your videos.${job.result?.early > 0.05 ? ` It starts ${job.result.early.toFixed(1)} s before the time you asked.` : ''}`,
    render: `${job.label} was rendered again.`,
    suggest: `Suggestions for ${job.label} are ready.`,
  }[job.kind];
}
