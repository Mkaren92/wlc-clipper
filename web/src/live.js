// Which channels are live on YouTube or Twitch, kept in one place so the side column and
// the Sources page show the same thing.
//
// The server holds the last answer. This asks for a new one when the
// dashboard is opened and then every few minutes while it is on screen. It
// does not ask while the tab is in the background.
import { reactive } from 'vue';
import { api } from './api.js';

// How old an answer may be before YouTube is asked again.
const FRESH = 5 * 60 * 1000;

export const live = reactive({
  /** By source id: { live, url, videoId, title, viewers, started }. `live` is null when a channel could not be checked. */
  channels: {},
  /** When YouTube was last asked, as an ISO time, or null. */
  checked: null,
  checking: false,
  error: '',
});

export const liveCount = () => Object.values(live.channels).filter((channel) => channel.live).length;

function take(answer) {
  live.channels = answer.channels ?? {};
  live.checked = answer.checked ?? null;
}

/** Ask YouTube now. */
export async function checkLive() {
  if (live.checking) return;
  live.checking = true;
  live.error = '';
  try {
    take(await api.checkLive());
  } catch (e) {
    live.error = e.message;
  }
  live.checking = false;
}

const stale = () => !live.checked || Date.now() - Date.parse(live.checked) > FRESH;
function checkIfStale() {
  if (!document.hidden && stale()) checkLive();
}

let timer = null;
/** Start keeping the answer fresh. Call once, when the dashboard starts. */
export async function watchLive() {
  try {
    take(await api.live());
  } catch {
    // The server may be restarting; the first check will say.
  }
  checkIfStale();
  timer = setInterval(checkIfStale, 60 * 1000);
  document.addEventListener('visibilitychange', checkIfStale);
}
export function stopWatchingLive() {
  clearInterval(timer);
  document.removeEventListener('visibilitychange', checkIfStale);
}
