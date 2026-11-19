import { spawn } from 'node:child_process';

/**
 * Run a program and collect its output. Arguments are passed as an array, so
 * nothing goes through a shell and paths need no quoting.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string }} [options]
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
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

    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      const detail = stderr.trim().split('\n').slice(-8).join('\n');
      reject(new Error(`${command} exited with code ${code}.\n${detail}`));
    });
  });
}
