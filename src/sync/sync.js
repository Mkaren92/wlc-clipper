// Keeping the owner's data the same on every machine, through a private
// GitHub repository.
//
// What is synced is exactly what src/transfer/contents.js says travels:
// the channels with their clubs, pictures and subscriber counts, the leagues
// and clubs with their logos, sounds, briefs and overlays. Videos and what is
// made from them stay on the machine.
//
// How:
//   data/.sync/repo   a copy of the GitHub repository (a "mirror" of the data)
//   1. what is on this machine is written into the mirror and committed, so
//      every state this machine had is in the history before anything else
//   2. what is on GitHub is fetched
//   3. if both changed, they are put together file by file against the last
//      state both agreed on; a list changed on both is merged record by
//      record (merge.js), never as text
//   4. the result is pushed, and written back to this machine's own files
//
// The mirror remembers the last state that was fully written to this
// machine's files (APPLIED). Every round starts again from there, so:
//   - a round that was cut off halfway is simply done again, and what had not
//     arrived yet is never mistaken for something removed here
//   - only what changed since then is written to this machine, and only if
//     nothing here changed while the round ran; otherwise the round is done
//     again with that change in it
//
// Rules it keeps:
//   - nothing is pushed by force, and nothing on this machine is erased: a
//     file that went on the other machine is moved to data/backups/sync/
//   - the lists are written through the same functions as everywhere else,
//     after the tool's own checks have passed
//   - no internet means nothing changes: the work is kept for the next try
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseLibrary, replaceLibrary } from '../cards/clubs.js';
import { replaceSubscribers } from '../pictures.js';
import { parseSources, saveSources } from '../sources.js';
import { acceptEntry, LISTS, listTransfer, placeOf } from '../transfer/contents.js';
import { askRemote, gitIn, githubRepo, isOwnCopy, startCopy } from './git.js';
import { joinLogos, LOGO_DIR, splitLogos } from './logos.js';
import { mergeLibrary, mergeSources, mergeSubscribers } from './merge.js';

const pretty = (value) => `${JSON.stringify(value, null, 2)}\n`;
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const exists = (file) => stat(file).then(() => true, () => false);
const isLogo = (name) => name.startsWith(`${LOGO_DIR}/`) && /^[0-9a-f]{32}\.png$/.test(name.slice(LOGO_DIR.length + 1));
// How many folders of files set aside by a sync are kept.
const KEEP_ASIDE = 20;
// The last state of the mirror that was fully written to this machine's files.
const APPLIED = 'refs/clipper/applied';

/**
 * @param {object} options
 * @param {import('../transfer/contents.js').Folders} options.folders
 * @param {string} options.codeDir          the project's own folder, whose repository must never be the target
 * @param {boolean} [options.anyAddress]    accept an address that is not GitHub's; for tests, which sync with a folder
 * @param {() => Promise<void>} [options.pause]   for tests: called in the middle of a round, after sending and before writing here
 */
export function createSync({ folders, codeDir, anyAddress = false, pause = async () => {} }) {
  const dir = path.join(folders.data, '.sync');
  const mirror = path.join(dir, 'repo');
  const configFile = path.join(dir, 'config.json');
  const git = gitIn(mirror);
  const inMirror = (name) => path.join(mirror, ...name.split('/'));

  const config = () => readFile(configFile, 'utf8').then(JSON.parse, () => null);
  const rev = async (name) => (await git(['rev-parse', '--verify', '-q', name]).catch(() => '')).trim();

  // --- This machine's data, in the shape it has in the mirror --------------------

  /** Every file the mirror should hold: a name, and either the file to copy or the bytes themselves. */
  async function wanted() {
    const files = new Map();
    for (const entry of await listTransfer(folders)) {
      if (entry.name !== LISTS.clubs) {
        files.set(entry.name, { file: entry.file });
        continue;
      }
      const { text, logos } = splitLogos(await readFile(entry.file, 'utf8'));
      files.set(entry.name, { bytes: Buffer.from(text) });
      for (const [name, bytes] of logos) files.set(`${LOGO_DIR}/${name}`, { bytes });
    }
    return files;
  }

  /** The names of every file in the mirror's working folder. */
  async function inside(folder = '') {
    const names = [];
    for (const entry of await readdir(path.join(mirror, folder), { withFileTypes: true }).catch(() => [])) {
      if (entry.name === '.git') continue;
      if (entry.isDirectory()) names.push(...(await inside(`${folder}${entry.name}/`)));
      else if (entry.isFile()) names.push(`${folder}${entry.name}`);
    }
    return names;
  }

  async function sameBytes(file, source) {
    const now = await readFile(file).catch(() => null);
    if (now === null) return false;
    return now.equals(source.bytes ?? (await readFile(source.file)));
  }

  /**
   * Write this machine's data into the mirror.
   *
   * @param {'exact' | 'over' | 'missing'} how
   *   exact: the mirror ends up holding just what this machine has (a file removed here is removed there)
   *   over: this machine's files are laid over the mirror's; what only the mirror has stays
   *   missing: only files the mirror does not have are added, and never a list
   */
  async function writeMirror(how) {
    const files = await wanted();
    const lists = Object.values(LISTS);
    for (const [name, source] of files) {
      const target = inMirror(name);
      const there = await exists(target);
      if (how === 'missing' && (there || lists.includes(name) || isLogo(name))) continue;
      if (there && (await sameBytes(target, source))) continue;
      await mkdir(path.dirname(target), { recursive: true });
      if (source.bytes) await writeFile(target, source.bytes);
      else await copyFile(source.file, target);
    }
    if (how !== 'exact') return;
    for (const name of await inside()) if (!files.has(name)) await rm(inMirror(name), { force: true });
  }

  async function commit(message) {
    await git(['add', '-A']);
    if ((await git(['status', '--porcelain'])).trim() === '') return false;
    await git(['commit', '-q', '-m', message]);
    return true;
  }

  // --- The mirror's data, written back to this machine -----------------------------

  /** Read a list from the mirror, or null when the mirror has none. */
  const mirrorText = (name) => readFile(inMirror(name), 'utf8').catch(() => null);
  const logoFile = (name) => readFile(inMirror(`${LOGO_DIR}/${name}`)).catch(() => null);

  /**
   * Make this machine's files match the mirror. The lists are checked with
   * the tool's own parsers first, and a list that fails stops everything
   * before any file is touched.
   *
   * @param {{ keepExtra?: boolean, since?: string }} [options]
   *   keepExtra: keep files this machine has and the mirror does not (connecting)
   *   since: write only what differs between that commit and the mirror now; nothing differs, nothing is touched
   * @returns {Promise<{ arrived: string[], setAside: string[] }>}
   */
  async function writeBack({ keepExtra = false, since = null } = {}) {
    let changed = null; // null: everything
    if (since) {
      const [was, now] = [await filesAt(since), await filesAt('HEAD')];
      changed = new Set([...was.keys(), ...now.keys()].filter((name) => was.get(name) !== now.get(name)));
      if (changed.size === 0) return { arrived: [], setAside: [] };
    }
    const touch = (name) => changed === null || changed.has(name);
    const sourcesText = touch(LISTS.sources) ? await mirrorText(LISTS.sources) : null;
    const clubsText = touch(LISTS.clubs) ? await mirrorText(LISTS.clubs) : null;
    const countsText = touch(LISTS.subscribers) ? await mirrorText(LISTS.subscribers) : null;
    const sources = sourcesText === null ? null : parseSources(JSON.parse(sourcesText));
    const library = clubsText === null ? null : parseLibrary(JSON.parse(await joinLogos(clubsText, logoFile)));
    const counts = countsText === null ? null : JSON.parse(countsText);

    const arrived = [];
    const setAside = [];
    const aside = path.join(folders.data, 'backups', 'sync', stamp());
    const moveAside = async (name) => {
      await mkdir(path.dirname(path.join(aside, name)), { recursive: true });
      await rename(placeOf(folders, name), path.join(aside, name));
      setAside.push(name);
    };

    // Files first, the lists last, so a list never names a picture that has not arrived.
    const names = (await inside()).filter((name) => acceptEntry(name) && !Object.values(LISTS).includes(name) && folders[name.split('/')[0]]);
    for (const name of names) {
      if (!touch(name)) continue;
      const here = placeOf(folders, name);
      if (await sameBytes(here, { file: inMirror(name) })) continue;
      if (await exists(here)) await moveAside(name);
      await mkdir(path.dirname(here), { recursive: true });
      await copyFile(inMirror(name), here);
      arrived.push(name);
    }
    if (changed) {
      // A file that left the mirror since then was removed on the other machine.
      for (const name of changed) {
        if (names.includes(name) || Object.values(LISTS).includes(name) || !acceptEntry(name) || !folders[name.split('/')[0]]) continue;
        if (await exists(placeOf(folders, name))) await moveAside(name);
      }
    } else if (!keepExtra) {
      for (const entry of await listTransfer(folders)) {
        if (!Object.values(LISTS).includes(entry.name) && !names.includes(entry.name)) await moveAside(entry.name);
      }
    }

    const list = async (name, fresh, text, write) => {
      if (fresh === null || (await readFile(placeOf(folders, name), 'utf8').catch(() => null)) === text) return;
      await write(fresh);
      arrived.push(name);
    };
    await list(LISTS.clubs, library, library && pretty(library), (fresh) => replaceLibrary(folders.data, fresh));
    await list(LISTS.subscribers, counts, counts && pretty(counts), (fresh) => replaceSubscribers(folders.data, fresh));
    await list(LISTS.sources, sources, sources && pretty(sources), (fresh) => saveSources(folders.data, fresh));

    // Only the newest few folders of files set aside are kept.
    const kept = (await readdir(path.join(folders.data, 'backups', 'sync')).catch(() => [])).sort();
    for (const old of kept.slice(0, Math.max(0, kept.length - KEEP_ASIDE))) await rm(path.join(folders.data, 'backups', 'sync', old), { recursive: true, force: true });
    return { arrived, setAside };
  }

  // --- Both machines changed: putting the two together ------------------------------

  async function filesAt(revision) {
    const files = new Map();
    for (const line of (await git(['ls-tree', '-r', '-z', '--full-tree', revision])).split('\0')) {
      const found = /^\d+ blob ([0-9a-f]+)\t(.+)$/s.exec(line);
      if (found) files.set(found[2], found[1]);
    }
    return files;
  }
  const textAt = async (revision, name) => (revision ? git(['show', `${revision}:${name}`]).catch(() => null) : null);
  const jsonAt = async (revision, name) => {
    const text = await textAt(revision, name);
    return text === null ? null : JSON.parse(text);
  };

  /**
   * This machine (`here`) and GitHub (`there`) both changed since `base`.
   * Each file is decided by itself, and the result becomes one commit that
   * has both as its parents.
   *
   * @returns {Promise<string[]>} what was changed on both, in words
   */
  async function putTogether(base, here, there) {
    await git(['merge', '-q', '-s', 'ours', '--no-commit', '--allow-unrelated-histories', there]);
    const [was, mine, theirs] = [base ? await filesAt(base) : new Map(), await filesAt(here), await filesAt(there)];
    const clashes = [];
    const takeTheirs = async (name) => {
      if (theirs.has(name)) await git(['checkout', there, '--', name]);
      else await git(['rm', '-q', '-f', '--', name]);
    };
    const merged = async (name, text) => {
      await mkdir(path.dirname(inMirror(name)), { recursive: true });
      await writeFile(inMirror(name), text);
    };

    for (const name of new Set([...mine.keys(), ...theirs.keys()])) {
      const [b, l, r] = [was.get(name), mine.get(name), theirs.get(name)];
      if (l === r || r === b) continue; // the same on both, or only this machine changed it
      if (l === b) {
        await takeTheirs(name); // only GitHub changed it
        continue;
      }
      // Changed on both, differently.
      try {
        if (name === LISTS.sources) {
          const result = mergeSources(await jsonAt(base, name), (await jsonAt(here, name)) ?? [], (await jsonAt(there, name)) ?? []);
          parseSources(result.merged);
          await merged(name, pretty(result.merged));
          clashes.push(...result.clashes);
        } else if (name === LISTS.clubs) {
          const empty = { leagues: [], clubs: [] };
          const result = mergeLibrary(await jsonAt(base, name), (await jsonAt(here, name)) ?? empty, (await jsonAt(there, name)) ?? empty);
          // Checked as a list, with the logos' names taken out: they are files here, not pictures.
          parseLibrary({ ...result.merged, clubs: result.merged.clubs.map((club) => ({ ...club, icon: '' })) });
          await merged(name, pretty(result.merged));
          clashes.push(...result.clashes);
        } else if (name === LISTS.subscribers) {
          await merged(name, pretty(mergeSubscribers(await jsonAt(here, name), await jsonAt(there, name))));
        } else if (r === undefined) {
          clashes.push(`${name} (removed on the other PC, changed here: kept)`);
        } else {
          await takeTheirs(name);
          clashes.push(`${name} (the other PC's version was kept)`);
        }
      } catch {
        // Not a list this tool can read. Nothing is sent and nothing here is changed.
        await git(['reset', '-q', '--hard', here]).catch(() => {});
        throw new Error(`${name} in the data repository is not a list this tool can read. Nothing was changed here. Put it right on GitHub, or disconnect and connect again choosing this computer's lists.`);
      }
    }
    // Every logo the clubs list names must still be there, whichever side's file removal won.
    for (const found of ((await mirrorText(LISTS.clubs)) ?? '').matchAll(/"file:([0-9a-f]{32}\.png)"/g)) {
      const name = `${LOGO_DIR}/${found[1]}`;
      if (await exists(inMirror(name))) continue;
      const from = mine.has(name) ? here : theirs.has(name) ? there : null;
      if (from) await git(['checkout', from, '--', name]);
    }
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'Changes from two PCs, put together']);
    return clashes;
  }

  // --- Looking at an address, connecting, syncing -------------------------------------

  /** Refuse an address that must not be used, before anything is sent to it. */
  async function checkAddress(address) {
    const remote = String(address ?? '').trim();
    const repo = githubRepo(remote);
    if (!repo && !anyAddress) throw new Error('Give the repository\'s address as GitHub shows it, such as git@github.com:you/wlc-clipper-data.git');
    // The public repository with the code must never receive the data.
    const code = await askRemote(['-C', codeDir, 'remote', 'get-url', 'origin']).then((out) => githubRepo(out.trim()), () => null);
    if (repo && code && repo.owner.toLowerCase() === code.owner.toLowerCase() && repo.name.toLowerCase() === code.name.toLowerCase()) {
      throw new Error('That is the repository with the tool\'s code, which is public. Your data needs a private repository of its own.');
    }
    if (repo) {
      // A repository that answers a stranger is public. Asked without any sign-in at all, and without
      // this machine's own git settings, which could send the question another way.
      const asked = await askRemote(['-c', 'credential.helper=', 'ls-remote', `https://github.com/${repo.owner}/${repo.name}.git`], { timeout: 20_000, env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_ASKPASS: 'true' } })
        .then(() => 'open', (error) => (/Authentication failed|Repository not found|could not read Username|terminal prompts disabled/i.test(error.message) ? 'closed' : 'unknown'));
      if (asked === 'open') throw new Error('That repository is public: anyone could read your data. Make it private on GitHub (Settings, at the bottom), then try again.');
      // No answer is not "private".
      if (asked === 'unknown') throw new Error('GitHub could not be asked whether that repository is private (no internet?). Nothing was sent. Try again.');
      // Whichever way the address was written (the page's own address works too), GitHub is reached with this PC's SSH key.
      return `git@github.com:${repo.owner}/${repo.name}.git`;
    }
    return remote;
  }

  /** What a set of mirror files amounts to, in the owner's words. */
  function countMirror(names, sources, library) {
    return {
      channels: sources?.length ?? 0,
      channelsWithClub: sources?.filter((source) => (source.clubs ?? []).length > 0).length ?? 0,
      channelPictures: names.filter((name) => name.startsWith('data/source-pictures/')).length,
      leagues: library?.leagues?.length ?? 0,
      clubs: library?.clubs?.length ?? 0,
      clubsWithLogo: library?.clubs?.filter((club) => club.icon).length ?? 0,
      sounds: names.filter((name) => name.startsWith('sounds/')).length,
      overlays: names.filter((name) => name.startsWith('overlays/')).length,
      briefs: names.filter((name) => name.startsWith('briefs/')).length,
    };
  }

  /** Start the mirror afresh, pointed at `remote`, and fetch what is there. Answers whether GitHub has anything. */
  async function startMirror(remote) {
    await rm(mirror, { recursive: true, force: true });
    await startCopy(mirror);
    await git(['remote', 'add', 'origin', remote]);
    const heads = await git(['ls-remote', 'origin', 'refs/heads/main'], { timeout: 60_000 }).catch(() => {
      throw new Error('GitHub could not be reached at that address, or this PC is not allowed in. Check the address, and that this PC has an SSH key added to your GitHub account.');
    });
    if (heads.trim() === '') return false;
    await git(['fetch', '-q', 'origin', 'main'], { timeout: 300_000 });
    return true;
  }

  return {
    /** Whether this machine is connected, and to what. */
    async state() {
      const saved = await config();
      return saved && (await isOwnCopy(mirror)) ? { connected: true, remote: saved.remote, since: saved.connected } : { connected: false };
    },

    /** A short text that changes whenever anything that travels changes on this machine. Cheap to work out. */
    async fingerprint() {
      const entries = await listTransfer(folders);
      return createHash('sha256').update(JSON.stringify(entries.map((entry) => [entry.name, entry.size, Math.round(entry.mtimeMs)]))).digest('hex');
    },

    /** Whether GitHub has something this machine has not fetched. One small question over the network. */
    async behind() {
      const there = (await git(['ls-remote', 'origin', 'refs/heads/main'], { timeout: 30_000 })).split('\t')[0].trim();
      return there !== '' && there !== (await rev('origin/main'));
    },

    /**
     * Look at an address before connecting: is GitHub's side empty, and what does each side hold?
     * Nothing is sent and nothing on this machine is changed.
     */
    async look(address) {
      const remote = await checkAddress(address);
      const has = await startMirror(remote);
      let there = null;
      if (has) {
        const names = [...(await filesAt('origin/main')).keys()];
        there = countMirror(names, await jsonAt('origin/main', LISTS.sources), await jsonAt('origin/main', LISTS.clubs));
      }
      const mine = await wanted();
      const text = async (name) => (mine.has(name) ? (mine.get(name).bytes ?? (await readFile(mine.get(name).file))).toString('utf8') : null);
      const read = async (name) => JSON.parse((await text(name)) ?? 'null');
      const here = countMirror([...mine.keys()], await read(LISTS.sources), await read(LISTS.clubs));
      await rm(mirror, { recursive: true, force: true });
      return { remote, empty: !has, there, here };
    },

    /**
     * Connect this machine.
     *
     * When GitHub's side is empty, this machine's data is sent. When it is
     * not, `wins` must say which side's lists are kept: "github" (this
     * machine takes GitHub's) or "here" (GitHub takes this machine's). Either
     * way files only one side has are kept, and nothing is deleted.
     *
     * @param {string} address
     * @param {'github' | 'here' | undefined} wins
     */
    async connect(address, wins) {
      const remote = await checkAddress(address);
      const has = await startMirror(remote);
      let result = { arrived: [], setAside: [] };
      if (!has) {
        await writeMirror('exact');
        await git(['add', '-A']);
        await git(['commit', '-q', '--allow-empty', '-m', 'First copy of the data']);
        await git(['push', '-q', '-u', 'origin', 'main'], { timeout: 300_000 });
      } else {
        if (wins !== 'github' && wins !== 'here') throw new Error('GitHub already holds data. Say which side to keep.');
        await git(['checkout', '-q', '-B', 'main', 'origin/main']);
        // This machine's lists as they stand are kept aside for good, whichever side wins.
        const aside = path.join(folders.data, 'backups', `before-connect-${stamp()}`);
        for (const name of Object.values(LISTS)) {
          if (!(await exists(placeOf(folders, name)))) continue;
          await mkdir(path.dirname(path.join(aside, name)), { recursive: true });
          await copyFile(placeOf(folders, name), path.join(aside, name));
        }
        await writeMirror(wins === 'here' ? 'over' : 'missing');
        if (await commit(wins === 'here' ? 'A PC connected, and its lists were kept' : 'A PC connected')) await git(['push', '-q', 'origin', 'HEAD:main'], { timeout: 300_000 });
        result = await writeBack({ keepExtra: true });
      }
      await git(['update-ref', APPLIED, 'HEAD']);
      await mkdir(dir, { recursive: true });
      await writeFile(configFile, pretty({ remote, connected: new Date().toISOString() }));
      return { ...result, sent: !has || wins === 'here' };
    },

    /** Stop syncing on this machine. Its data stays as it is; GitHub's stays as it is. */
    async disconnect() {
      await rm(dir, { recursive: true, force: true });
    },

    /**
     * One round of syncing.
     *
     * @returns {Promise<{ state: 'synced' | 'offline', sent: boolean, arrived: string[], setAside: string[], clashes: string[], mark: string | null }>}
     *   `mark` is this machine's fingerprint as the round saw it, or null when the round should be run again soon
     */
    async sync() {
      if (!(await config())) throw new Error('This PC is not connected to a data repository yet.');
      const clashes = [];
      let sent = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        const mark = await this.fingerprint();
        // Start from the last state that was fully written here, whatever an earlier round left behind.
        const applied = await rev(APPLIED);
        if (!applied) throw new Error('The copy of your data that is kept for syncing is missing or damaged. Disconnect and connect again.');
        await git(['reset', '-q', '--hard']);
        await git(['checkout', '-q', '-f', '-B', 'main', applied]);
        await writeMirror('exact');
        await commit('Changes from a PC');
        const snapshot = await rev('HEAD');
        try {
          await git(['fetch', '-q', 'origin', 'main'], { timeout: 300_000 });
        } catch {
          // No internet: nothing changes. This machine's changes are still in its own files, and go out next time.
          return { state: 'offline', sent: false, arrived: [], setAside: [], clashes: [], mark: null };
        }
        for (let round = 0; ; round++) {
          const [here, there] = [await rev('HEAD'), await rev('origin/main')];
          if (here === there) break;
          const base = (await git(['merge-base', here, there]).catch(() => '')).trim();
          if (base === here) await git(['merge', '-q', '--ff-only', 'origin/main']);
          else if (base !== there) clashes.push(...(await putTogether(base, here, there)));
          if ((await rev('HEAD')) === (await rev('origin/main'))) break;
          try {
            await git(['push', '-q', 'origin', 'HEAD:main'], { timeout: 300_000 });
            sent = true;
            break;
          } catch {
            // The other machine pushed in between. Fetch and go round again; never push by force.
            if (round === 3) throw new Error('This computer\'s changes could not be sent to GitHub. They are kept here and will be tried again. If this stays, check that this computer may write to the repository.');
            await git(['fetch', '-q', 'origin', 'main'], { timeout: 300_000 }).catch(() => {});
          }
        }
        await pause();
        // Something was marked or added here while the round ran: do the round again with it in,
        // and write nothing over it.
        if ((await this.fingerprint()) !== mark) continue;
        const back = await writeBack({ since: snapshot });
        await git(['update-ref', APPLIED, 'HEAD']);
        return { state: 'synced', sent, ...back, clashes, mark };
      }
      // This machine kept changing. Nothing was written over it; the next round takes it from here.
      return { state: 'synced', sent, arrived: [], setAside: [], clashes, mark: null };
    },
  };
}
