import { spawn } from 'node:child_process';

/**
 * Run a program and collect its output. Arguments are passed as an array, so
 * nothing goes through a shell and paths need no quoting.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, input?: string, timeout?: number }} [options]
 *   `input` is written to the program's standard input. `timeout` is in
 *   milliseconds; the program is stopped when it runs longer.
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      timeout: options.timeout,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));

    child.on('error', (error) => {
      reject(
        error.code === 'ENOENT'
          ? new Error(`${command} was not found on the PATH. Install it and try again.`)
          : error,
      );
    });

    child.on('close', (code, signal) => {
      if (code === 0) return resolve({ stdout, stderr });
      if (signal) return reject(new Error(`${command} was stopped after running too long.`));
      const detail = stderr.trim().split('\n').slice(-8).join('\n');
      reject(new Error(`${command} exited with code ${code}.\n${detail}`));
    });
  });
}
