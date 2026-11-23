import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';

// Stopping work that is under way.
//
// A job (a cut, a fetch, a compilation) is a chain of programs run one after
// another from deep inside the engine. To stop one, the dashboard does its
// work inside `withStop(signal, work)`. Every `run` started from that work,
// however deep, then finds the signal here and ends its program when the
// signal fires, so no function in between has to pass anything along.
const stopSignal = new AsyncLocalStorage();

/** What a program's run fails with when its job was stopped. */
export const STOPPED = 'Stopped before it finished.';
// A program that has not gone this long after being asked is ended outright.
const GRACE = 4000;

/**
 * Do `work` so that it can be stopped: when `signal` fires, the program it is
 * running is ended and no further one is started.
 *
 * @template T
 * @param {AbortSignal} signal
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
export function withStop(signal, work) {
  return stopSignal.run(signal, work);
}

/** Whether the work this is called from has been told to stop. */
export function isStopped() {
  return stopSignal.getStore()?.aborted === true;
}

/**
 * Run a program and collect its output. Arguments are passed as an array, so
 * nothing goes through a shell and paths need no quoting.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, input?: string, timeout?: number, env?: Record<string, string> }} [options]
 *   `input` is written to the program's standard input. `timeout` is in
 *   milliseconds; the program is stopped when it runs longer. `env` adds
 *   to the settings the program is started with.
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const signal = stopSignal.getStore();
    if (signal?.aborted) return reject(new Error(STOPPED));

    const child = spawn(command, args, {
      cwd: options.cwd,
      timeout: options.timeout,
      env: options.env ? { ...process.env, ...options.env } : undefined,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    // Read as text, so a letter of several bytes that falls across two pieces is not broken in two.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));

    // Asked to stop: the program is interrupted, as with Ctrl+C, which lets it
    // end the programs it started itself (the downloader runs ffmpeg) and
    // close its files. One that does not go is ended outright.
    let outright = null;
    const stop = () => {
      child.kill('SIGINT');
      outright = setTimeout(() => child.kill('SIGKILL'), GRACE);
    };
    signal?.addEventListener('abort', stop, { once: true });
    const settled = () => {
      signal?.removeEventListener('abort', stop);
      clearTimeout(outright);
    };

    child.on('error', (error) => {
      settled();
      reject(
        error.code === 'ENOENT'
          ? new Error(`${command} was not found on the PATH. Install it and try again.`)
          : error,
      );
    });

    // Once stopped, the answer is given as soon as the program itself has gone.
    // Waiting for its output to close could wait on a program it started and left behind.
    child.on('exit', () => {
      if (!signal?.aborted) return;
      settled();
      reject(new Error(STOPPED));
    });

    child.on('close', (code, killedBy) => {
      settled();
      // Stopped counts as stopped even when the program ended cleanly: the
      // downloader, interrupted while recording, closes its file and reports
      // success, and the work must not carry on with what it left.
      if (signal?.aborted) return reject(new Error(STOPPED));
      if (code === 0) return resolve({ stdout, stderr });
      if (killedBy) return reject(new Error(`${command} was stopped after running too long.`));
      const detail = stderr.trim().split('\n').slice(-8).join('\n');
      reject(new Error(`${command} exited with code ${code}.\n${detail}`));
    });
  });
}
