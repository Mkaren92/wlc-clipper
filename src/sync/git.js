// Running git on the copy of the owner's data that is kept for syncing.
//
// That copy lives inside the project's own folder, and the project is itself
// a git repository: the public one with the code. If the copy's `.git` were
// ever missing, a git command run there would act on the public repository
// instead. So every command first asks git where it thinks it is, and
// nothing is run unless the answer is the copy itself.
import { mkdir, realpath } from 'node:fs/promises';
import { run } from '../run.js';

// Never ask for anything: no password prompt, no question about an unknown key.
const QUIET = { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=15' };
// The same on every machine, whatever git is or is not set up with there.
const SETTINGS = [
  '-c', 'user.name=WLC Clipper', '-c', 'user.email=wlc-clipper@localhost', '-c', 'commit.gpgsign=false',
  '-c', 'core.autocrlf=false', '-c', 'core.quotepath=false', '-c', 'advice.detachedHead=false',
];

/** Start an empty copy in `dir`, on a branch named main. */
export async function startCopy(dir) {
  await mkdir(dir, { recursive: true });
  await run('git', ['init', '-q', '-b', 'main', dir], { env: QUIET, timeout: 20_000 });
}

/** Whether `dir` is a git copy of its own, and not merely a folder inside another one. */
export async function isOwnCopy(dir) {
  const top = await run('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { env: QUIET, timeout: 10_000 }).then((out) => out.stdout.trim(), () => '');
  return top !== '' && (await realpath(top).catch(() => '')) === (await realpath(dir).catch(() => 'x'));
}

/**
 * A function that runs git in `dir`, and only there.
 *
 * @param {string} dir
 * @returns {(args: string[], options?: { timeout?: number }) => Promise<string>} what git printed
 */
export function gitIn(dir) {
  return async (args, { timeout = 90_000 } = {}) => {
    if (!(await isOwnCopy(dir))) throw new Error('The copy of your data that is kept for syncing is missing or damaged. Disconnect and connect again.');
    return (await run('git', ['-C', dir, ...SETTINGS, ...args], { env: QUIET, timeout })).stdout;
  };
}

/** Ask a repository something without having a copy of it. Used to look at an address before connecting. */
export async function askRemote(args, { timeout = 30_000, env = {} } = {}) {
  return (await run('git', [...SETTINGS, ...args], { env: { ...QUIET, ...env }, timeout })).stdout;
}

/**
 * The owner and name in a GitHub address, or null when it is not one.
 * git@github.com:owner/name.git, https://github.com/owner/name and ssh://git@github.com/owner/name are all read.
 */
export function githubRepo(address) {
  const found = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?\/?$/.exec(String(address ?? '').trim());
  return found ? { owner: found[1], name: found[2] } : null;
}
