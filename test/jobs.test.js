// Stopping work that is under way: the program a job is running is ended,
// nothing further is started, and the next job goes ahead.
import { describe, expect, it } from 'vitest';
import { createJobs } from '../server/jobs.js';
import { isStopped, run, STOPPED, withStop } from '../src/run.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Whether a program started with this marker in its arguments is still running. */
async function running(marker) {
  const { stdout } = await run('ps', ['-eo', 'args']);
  return stdout.split('\n').some((line) => line.includes(marker) && !line.includes('ps -eo'));
}

describe('a program that can be stopped', () => {
  it('runs as before when nothing asks it to stop', async () => {
    const stopper = new AbortController();
    expect((await withStop(stopper.signal, () => run('printf', ['done']))).stdout).toBe('done');
    expect((await run('printf', ['plain'])).stdout).toBe('plain'); // outside any job, too
    expect(isStopped()).toBe(false);
  });

  it('is ended when its job is stopped, however deep in the work it was started', async () => {
    const stopper = new AbortController();
    // The program is started two calls down, with nothing passed along, as the engine does.
    const deep = async () => run('sleep', ['31.4159']);
    const work = withStop(stopper.signal, async () => deep());
    await wait(150);
    expect(await running('sleep 31.4159')).toBe(true);
    const began = Date.now();
    stopper.abort();
    await expect(work).rejects.toThrow(STOPPED);
    expect(Date.now() - began).toBeLessThan(1500);
    expect(await running('sleep 31.4159')).toBe(false);
  });

  it('starts nothing more once stopped, and says so to the work', async () => {
    const stopper = new AbortController();
    stopper.abort();
    await withStop(stopper.signal, async () => {
      expect(isStopped()).toBe(true);
      await expect(run('printf', ['never'])).rejects.toThrow(STOPPED);
    });
  });

  it('counts as stopped even when the interrupted program ends cleanly', async () => {
    const stopper = new AbortController();
    // Like the downloader: interrupted, it closes up and reports success.
    const work = withStop(stopper.signal, () => run('sh', ['-c', 'sleep 29.2929 & pid=$!; trap "kill $pid; exit 0" INT; wait']));
    await wait(200);
    const began = Date.now();
    stopper.abort();
    await expect(work).rejects.toThrow(STOPPED);
    expect(Date.now() - began).toBeLessThan(1500);
  });

  it('ends a program outright when it does not go by itself', async () => {
    const stopper = new AbortController();
    // A program that ignores being interrupted.
    const work = withStop(stopper.signal, () => run('sh', ['-c', 'trap "" INT; exec sleep 27.1828']));
    await wait(200);
    const began = Date.now();
    stopper.abort();
    await expect(work).rejects.toThrow(STOPPED);
    expect(Date.now() - began).toBeGreaterThan(3000); // it was given its chance first
    expect(await running('sleep 27.1828')).toBe(false);
  }, 15_000);
});

describe('stopping a job', () => {
  it('stops the running job, and the one waiting behind it then runs', async () => {
    const jobs = createJobs();
    const first = jobs.add('cut', 'first', () => run('sleep', ['33.3333']));
    const second = jobs.add('cut', 'second', async () => 'made');
    await wait(150);
    expect([first.status, second.status]).toEqual(['running', 'queued']);

    expect(jobs.stop(first.id)).toMatchObject({ id: first.id });
    await jobs.idle();
    expect(first).toMatchObject({ status: 'stopped', error: STOPPED, result: null, step: null });
    expect(first.finishedAt).not.toBeNull();
    expect(second).toMatchObject({ status: 'done', result: 'made' });
    expect(await running('sleep 33.3333')).toBe(false);
    expect(jobs.busy()).toBe(false);
  });

  it('reports "stopped" whatever the work said when its program was ended', async () => {
    const jobs = createJobs();
    // The engine often puts its own words on a failure; a stop must still read as a stop.
    const job = jobs.add('fetch', 'a part', () => run('sleep', ['34.4444']).catch(() => {
      throw new Error('The download failed. Try again.');
    }));
    await wait(150);
    jobs.stop(job.id);
    await jobs.idle();
    expect(job).toMatchObject({ status: 'stopped', error: STOPPED });
  });

  it('never starts a job that was stopped while waiting', async () => {
    const jobs = createJobs();
    let started = false;
    const first = jobs.add('cut', 'first', () => wait(200));
    const second = jobs.add('cut', 'second', async () => {
      started = true;
    });
    expect(jobs.stop(second.id)).toMatchObject({ status: 'stopped', error: STOPPED });
    expect(jobs.busy()).toBe(true); // the first is still going
    await jobs.idle();
    expect(started).toBe(false);
    expect([first.status, second.status, second.startedAt]).toEqual(['done', 'stopped', null]);
  });

  it('has nothing to stop once a job has finished, or for a job it does not know', async () => {
    const jobs = createJobs();
    const done = jobs.add('cut', 'done', async () => 1);
    const failed = jobs.add('cut', 'failed', async () => {
      throw new Error('broken');
    });
    await jobs.idle();
    expect([jobs.stop(done.id), jobs.stop(failed.id), jobs.stop('999')]).toEqual([null, null, null]);
    expect([done.status, failed.status, failed.error]).toEqual(['done', 'failed', 'broken']);
  });
});
