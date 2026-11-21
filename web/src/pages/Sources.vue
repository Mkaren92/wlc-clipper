<script setup>
// The channels whose videos may be brought in. A channel is added here only
// once it has agreed, so being in the list is what allows fetching from it
// (on the Download page).
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api.js';
import ClubPicker from '../components/ClubPicker.vue';
import Icon from '../components/Icon.vue';
import TrashButton from '../components/TrashButton.vue';
import { isActive, jobs, track } from '../jobs.js';
import { checkLive, live, liveCount } from '../live.js';

const sources = ref([]);
const pictures = ref({}); // source id -> a number that changes with the picture
const subscribers = ref({}); // source id -> { count, checked }: as YouTube gave it, and when
// Every club once, by name, for marking which clubs a streamer supports. A club that is in two
// leagues is two entries in the list of clubs; here it is one, with a logo if either has one.
const clubs = ref([]);
function takeClubs(library) {
  const byName = new Map();
  for (const club of library.clubs) {
    const known = byName.get(club.name);
    if (!known || (!known.icon && club.icon)) byName.set(club.name, { name: club.name, colour: club.colour, icon: club.icon });
  }
  clubs.value = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
// 18000 becomes "18K", 1250000 "1.3M". YouTube itself gives the number rounded.
const short = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat('en');
// Which channels are live: read from the shared store, which asks YouTube every few minutes.
const isLive = (source) => live.channels[source.id]?.live === true;
const streamLink = (source) => `https://www.youtube.com/watch?v=${live.channels[source.id].videoId}`;
const clockTime = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
function liveTip(source) {
  const stream = live.channels[source.id];
  // A stream that began today is given by its time; one that has run for days, by its day as well.
  const today = stream.started && Date.now() - Date.parse(stream.started) < 20 * 3600 * 1000;
  const since = stream.started ? `, since ${today ? clockTime(stream.started) : `${day(stream.started)}, ${clockTime(stream.started)}`}` : '';
  const watching = stream.viewers !== null && stream.viewers !== undefined ? `, ${short.format(stream.viewers)} watching` : '';
  return `Live${since}${watching}: ${stream.title}. Opens the stream on YouTube.`;
}
const unchecked = computed(() => sources.value.filter((source) => live.channels[source.id]?.live === null).length);

// The rows are shown with the most subscribers first. A channel with no count yet, such as one
// just added, goes to the end, and channels with the same count keep the order they were added in.
// Only the order on the page changes; the saved list keeps its own.
const ordered = computed(() => [...sources.value].sort((a, b) =>
  // Channels that are live right now come first, then the rest, each group by subscribers.
  Number(isLive(b)) - Number(isLive(a)) || (subscribers.value[b.id]?.count ?? -1) - (subscribers.value[a.id]?.count ?? -1)));
// The club a streamer supports is saved the moment it is chosen, for a channel that is already saved.
// Only that one thing is saved; anything else still being typed on the page stays as it is. Before,
// it waited for "Save the list", and a reload in between lost every choice made.
async function setClubs(source, chosen) {
  const before = source.clubs;
  source.clubs = chosen;
  if (!isSaved(source)) return; // a new row is saved whole, with "Save the list" or its sync button
  error.value = '';
  clubError.value = { ...clubError.value, [source.id]: '' };
  try {
    // The server changes this one channel in the list it holds; nothing else on disk is touched.
    const answer = await api.setSourceClubs(source.id, chosen);
    takeSaved(answer, source.id);
    note.value = `${source.name}: ${chosen.join(', ') || 'no club'}. Saved.`;
  } catch (e) {
    // Not saved: the row goes back to what is saved, so it never shows a choice that is not on disk.
    source.clubs = before;
    clubError.value = { ...clubError.value, [source.id]: `Not saved: ${e.message}` };
  }
}
const clubError = ref({}); // source id -> why its club could not be saved

/**
 * After one channel was changed on the server: what the page counts as saved follows, for that
 * channel only, so everything else still being typed stays "not saved".
 */
function takeSaved(answer, sourceId) {
  const fresh = answer.sources.find((known) => known.id === sourceId);
  const saved = JSON.parse(savedText.value).filter((known) => known.id !== sourceId || fresh).map((known) => (known.id === sourceId ? fresh : known));
  savedText.value = JSON.stringify(saved);
  pictures.value = answer.pictures ?? {};
  subscribers.value = answer.subscribers ?? {};
}

// Removing a channel. One that is saved is removed on the server at once, after a question, like every
// other delete in the dashboard; before, it only left the page and came back on a reload unless
// "Save the list" was pressed. A row that was never saved is simply taken off the page.
const confirming = ref('');
const isSaved = (source) => JSON.parse(savedText.value).some((known) => known.id === source.id);
function askRemove(source) {
  if (isSaved(source)) confirming.value = source.id;
  else sources.value = sources.value.filter((known) => known.id !== source.id);
}
async function remove(source) {
  error.value = '';
  note.value = '';
  try {
    // The server takes this one channel out of the list it holds; anything else still being typed stays as it is.
    takeSaved(await api.deleteSource(source.id), source.id);
    sources.value = sources.value.filter((known) => known.id !== source.id);
    note.value = `${source.name || 'The channel'} was removed.`;
  } catch (e) {
    error.value = e.message;
  }
  confirming.value = '';
}

// A link is made only from an address that is YouTube's: what is in the box is typed text.
const channelLink = (url) => (/^https:\/\/(www\.|m\.)?youtube\.com\/(@[\w.-]+|channel\/UC[\w-]+)\/?$/.test((url ?? '').trim()) ? url.trim() : null);
const day = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const installed = ref(true);
const loaded = ref(false);
const error = ref('');
const note = ref('');

// What the list looked like when it was last saved or read, to tell when it has changes.
const savedText = ref('[]');
const unsaved = computed(() => JSON.stringify(sources.value) !== savedText.value);

// Only what is saved counts: a channel typed in allows nothing until the list is saved.
const allowed = computed(() => JSON.parse(savedText.value).filter((source) => source.status === 'agreed'));

function show(answer) {
  pictures.value = answer.pictures ?? {};
  subscribers.value = answer.subscribers ?? {};
  sources.value = answer.sources;
  savedText.value = JSON.stringify(answer.sources);
  installed.value = answer.downloaderInstalled;
}
// A reload or a closed tab would throw away anything typed and not saved, so the browser is told
// to ask first. (Clubs and removals are saved at once and are never in that state.)
const warnBeforeLeaving = (event) => {
  if (!unsaved.value) return;
  event.preventDefault();
  event.returnValue = '';
};
onUnmounted(() => window.removeEventListener('beforeunload', warnBeforeLeaving));

onMounted(async () => {
  window.addEventListener('beforeunload', warnBeforeLeaving);
  try {
    show(await api.sources());
    takeClubs(await api.clubs());
  } catch (e) {
    error.value = e.message;
  }
  loaded.value = true;
});

function add() {
  sources.value.push({ id: `s${Date.now().toString(36)}`, name: '', url: '', status: 'agreed', note: '', clubs: [] });
  note.value = '';
}

async function save() {
  error.value = '';
  note.value = '';
  try {
    show(await api.saveSources(sources.value));
    note.value = 'Saved.';
  } catch (e) {
    error.value = e.message;
  }
}

// The channels' profile pictures, shown beside a streamer's name when they are credited.
const gettingPictures = computed(() => jobs.list.find((job) => job.kind === 'pictures' && isActive(job)));
const pictureError = ref('');
async function getPictures() {
  pictureError.value = '';
  try {
    const started = await api.fetchPictures();
    const result = await track(started);
    // What came is on this page already, so the side column need not announce it, unless some failed.
    if (result.failed.length === 0) jobs.dismissed.push(started.id);
    else pictureError.value = `Not fetched: ${result.failed.map((one) => `${one.name} (${one.error})`).join('; ')}`;
    show(await api.sources());
    note.value = `${result.fetched.length} ${result.fetched.length === 1 ? 'channel' : 'channels'} updated: picture and subscribers.`;
  } catch (e) {
    pictureError.value = e.message;
  }
}

// One channel, from its address alone: its name when the box is empty, and its picture.
// The server puts it in the saved list, so only this row is brought up to date here
// and anything else still being typed stays as it is.
const syncing = computed(() => jobs.list.find((job) => job.kind === 'channel' && isActive(job)));
const syncingId = ref('');
async function sync(source) {
  error.value = '';
  pictureError.value = '';
  note.value = '';
  syncingId.value = source.id;
  try {
    const started = await api.syncSource({ id: source.id, url: source.url, name: source.name, clubs: source.clubs });
    const result = await track(started);
    jobs.dismissed.push(started.id);
    Object.assign(source, result.source);
    const answer = await api.sources();
    pictures.value = answer.pictures ?? {};
    subscribers.value = answer.subscribers ?? {};
    savedText.value = JSON.stringify(answer.sources);
    if (result.pictureError) pictureError.value = `${result.source.name} is saved, but its picture was not fetched: ${result.pictureError}`;
    else note.value = `${result.source.name} is in your list, with its picture.`;
  } catch (e) {
    error.value = e.message;
  }
  syncingId.value = '';
}

</script>

<template>
  <div class="stack sources">
    <section class="panel">
      <div class="row middle head">
        <h2 class="fixed">Channels</h2>
        <span class="chip mark fixed">{{ sources.length }}</span>
        <span />
        <button class="fixed" :disabled="unsaved || Boolean(gettingPictures) || !installed || allowed.length === 0" :title="unsaved ? 'Save the list first' : ''" @click="getPictures">
          <span v-if="gettingPictures" class="spinner" aria-hidden="true" /><Icon v-else name="download" /> Update pictures and subscribers
        </button>
        <button class="fixed" @click="add"><Icon name="plus" /> Add a channel</button>
      </div>
      <p class="hint first">
        Add a channel only once it has agreed to let you use its videos. Paste its address and press the round arrows
        on its row: the name, picture and subscriber count come from YouTube and the channel is saved. Channels that
        are live are listed first, then the rest by subscribers. Hover over a number or a LIVE mark for the details.
        Under “Supports”, choose the club a streamer supports; it is saved as you choose.
      </p>
      <div class="row middle live-line" role="status">
        <span v-if="live.checking" class="fixed running"><span class="spinner" aria-hidden="true" /> Asking YouTube who is live…</span>
        <template v-else-if="live.checked">
          <span v-if="liveCount() > 0" class="chip bad fixed">{{ liveCount() }} live now</span>
          <span v-else class="chip fixed">Nobody is live</span>
          <span class="muted fixed">checked at {{ clockTime(live.checked) }}{{ unchecked > 0 ? `; ${unchecked} could not be checked` : '' }}</span>
        </template>
        <span v-else class="muted fixed">Not checked yet who is live.</span>
        <span />
        <button class="fixed small" :disabled="live.checking || !installed" @click="checkLive"><Icon name="sync" /> Check who is live</button>
      </div>
      <p v-if="live.error" class="notice">{{ live.error }}</p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="pictureError" class="error" role="alert">{{ pictureError }}</p>
      <p v-if="loaded && sources.length === 0" class="empty">No channels yet. Add the first one that has agreed.</p>

      <div v-for="(source, index) in ordered" :key="source.id" class="row source">
        <span class="face fixed" :class="{ none: !pictures[source.id] }">
          <img v-if="pictures[source.id]" :src="api.sourcePictureUrl(source.id, pictures[source.id])" :alt="`Picture of ${source.name}`" />
          <span v-else aria-hidden="true">{{ (source.name || '?').trim().charAt(0).toUpperCase() }}</span>
        </span>
        <div class="name">
          <label :for="`name-${source.id}`" :class="{ sr: index > 0 }">Name</label>
          <input :id="`name-${source.id}`" v-model="source.name" type="text" placeholder="Name, or leave empty and press sync" />
        </div>
        <div class="wide">
          <label :for="`url-${source.id}`" :class="{ sr: index > 0 }">Channel address</label>
          <input :id="`url-${source.id}`" v-model="source.url" type="text" placeholder="https://www.youtube.com/@name" />
        </div>
        <div class="fixed supports">
          <span class="label" :class="{ sr: index > 0 }">Supports</span>
          <ClubPicker :model-value="source.clubs" :clubs="clubs" :max="1" :label="source.name || 'this channel'" @update:model-value="setClubs(source, $event)" />
        </div>
        <div class="fixed air">
          <a v-if="isLive(source)" class="chip bad" :href="streamLink(source)" target="_blank" rel="noopener noreferrer" :title="liveTip(source)">LIVE</a>
        </div>
        <div class="fixed subs" :title="subscribers[source.id] ? `${whole.format(subscribers[source.id].count)} subscribers, checked ${day(subscribers[source.id].checked)}` : 'Not looked up yet. Press sync.'">
          <span class="label" :class="{ sr: index > 0 }">Subscribers</span>
          <span class="count numbers">{{ subscribers[source.id] ? short.format(subscribers[source.id].count) : '–' }}</span>
        </div>
        <a
          v-if="channelLink(source.url)" class="fixed go" :href="channelLink(source.url)" target="_blank" rel="noopener noreferrer"
          :aria-label="`Open ${source.name || 'this channel'} on YouTube in a new tab`" title="Open the channel on YouTube"
        ><Icon name="external" /></a>
        <span v-else class="fixed go off" title="Give the channel's address first" aria-hidden="true"><Icon name="external" /></span>
        <button
          class="fixed quiet icon-only sync" :disabled="!source.url.trim() || Boolean(syncing) || Boolean(gettingPictures) || !installed"
          :aria-label="`Get the name and picture of ${source.name || 'this channel'} from YouTube`" title="Get the name, picture and subscriber count from YouTube" @click="sync(source)"
        >
          <span v-if="syncing && syncingId === source.id" class="spinner" aria-hidden="true" /><Icon v-else name="sync" />
        </button>
        <TrashButton class="fixed" :label="`Remove ${source.name || 'this channel'} from the list`" @click="askRemove(source)" />
        <p v-if="clubError[source.id]" class="error club-error" role="alert">{{ clubError[source.id] }}</p>
        <div v-if="confirming === source.id" class="confirm" role="alertdialog">
          <span>Remove {{ source.name || 'this channel' }} from your channels? Its picture and subscriber count go with it, and you can no longer fetch from it. Videos you already fetched stay.</span>
          <button class="small danger" @click="remove(source)">Remove</button>
          <button class="small" @click="confirming = ''">Cancel</button>
        </div>
      </div>

      <div class="row middle actions">
        <button class="fixed primary" :disabled="!unsaved" @click="save">Save the list</button>
        <span v-if="unsaved" class="chip warn fixed">Changes not saved</span>
        <span v-else role="status" class="muted">{{ note }}</span>
      </div>
    </section>

  </div>
</template>

<style scoped>
.head { gap: 8px; }
.head h2, .panel > h2 { margin: 0; }
.panel > h2 { display: flex; align-items: center; gap: 8px; }
.first { margin: 6px 0 12px; }
/* One line per channel. Only the first row shows the labels; the rest keep them for screen readers. */
.source { margin-top: 6px; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
/* The channel's picture, or its first letter until one has been fetched. */
.face {
  display: grid; place-items: center; width: 36px; height: 36px; border-radius: 50%; overflow: hidden;
  background: var(--soft-strong); color: var(--text); font-weight: 700;
}
.face img { width: 100%; height: 100%; }
.sync { min-height: 32px; min-width: 32px; padding: 6px; color: var(--muted); }
/* The link to the channel, sized and coloured like the buttons beside it. */
.go { display: inline-grid; place-items: center; width: 32px; height: 36px; border-radius: var(--radius); color: var(--muted); }
a.go:hover { color: var(--accent); background: var(--soft); }
.go.off { opacity: 0.35; }
.sync:hover:not(:disabled) { color: var(--accent); }
.source .confirm, .source .club-error { flex: 1 1 100%; margin: 0 0 6px; }
/* The clubs a streamer supports: up to three small logos. */
.supports { width: 84px; }
.supports .label { display: block; margin-bottom: 4px; font-size: 13px; font-weight: 550; color: var(--muted); }
/* Who is live: the line above the list, and the mark on a row. A part can be downloaded only after a stream has ended. */
.live-line { margin: 0 0 10px; gap: 8px; }
.live-line .running { display: inline-flex; align-items: center; gap: 8px; }
.air { width: 44px; text-align: center; line-height: 36px; }
.air a { text-decoration: none; }
.air a:hover { outline: 2px solid var(--bad); }
/* The subscriber count: a label on the first row like the boxes have, and the number in line with them. */
.subs { width: 84px; text-align: right; }
.subs .label { display: block; margin-bottom: 4px; font-size: 13px; font-weight: 550; color: var(--muted); }
.subs .count { display: block; line-height: 36px; font-weight: 650; }
.name { flex: 1 1 180px; }
.wide { flex: 3 1 260px; }
.actions { margin-top: 14px; }
.error { margin-top: 10px; }
</style>
