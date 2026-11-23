// How syncing with GitHub stands, kept in one place so the side column and
// the My data page show the same thing. The server does the syncing; this
// only asks it, once a minute, how things are.
import { reactive } from 'vue';
import { api } from './api.js';

export const sync = reactive({
  connected: false,
  remote: '',
  /** "off", "idle", "syncing", "offline" or "error". */
  state: 'off',
  message: '',
  last: null,
  /** What the last round that changed anything did: { sent, arrived, setAside, clashes, at }. */
  result: null,
});

export function takeSync(answer) {
  Object.assign(sync, { connected: false, remote: '', message: '', last: null, result: null }, answer);
}

export async function refreshSync() {
  try {
    takeSync(await api.sync());
  } catch {
    // The server may be restarting; the next look will say.
  }
}

/** Whether there is something the owner should look at: syncing is failing, or two PCs changed the same thing. */
export const syncNeedsALook = () => sync.connected && (sync.state === 'error' || (sync.result?.clashes?.length ?? 0) > 0);

let timer = null;
export function watchSync() {
  refreshSync();
  timer = setInterval(() => {
    if (!document.hidden) refreshSync();
  }, 60 * 1000);
}
export function stopWatchingSync() {
  clearInterval(timer);
}
