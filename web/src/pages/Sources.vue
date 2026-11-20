<script setup>
// The channels whose videos may be brought in, and the form that fetches
// part of a video from one of them. A channel is added here only once it
// has agreed, so being in the list is what allows fetching from it.
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';
import Icon from '../components/Icon.vue';
import TrashButton from '../components/TrashButton.vue';
import { describe, isActive, jobs, track } from '../jobs.js';

const sources = ref([]);
const pictures = ref({}); // source id -> a number that changes with the picture
const installed = ref(true);
const loaded = ref(false);
const error = ref('');
const note = ref('');
const link = ref('');
const start = ref('');
const end = ref('');
const fetchError = ref('');

// What the list looked like when it was last saved or read, to tell when it has changes.
const savedText = ref('[]');
const unsaved = computed(() => JSON.stringify(sources.value) !== savedText.value);

// Only what is saved counts: a channel typed in allows nothing until the list is saved.
const allowed = computed(() => JSON.parse(savedText.value).filter((source) => source.status === 'agreed'));
const fetching = computed(() => jobs.list.find((job) => job.kind === 'fetch' && isActive(job)));

function show(answer) {
  pictures.value = answer.pictures ?? {};
  sources.value = answer.sources;
  savedText.value = JSON.stringify(answer.sources);
  installed.value = answer.downloaderInstalled;
}
onMounted(async () => {
  try {
    show(await api.sources());
  } catch (e) {
    error.value = e.message;
  }
  loaded.value = true;
});

function add() {
  sources.value.push({ id: `s${Date.now().toString(36)}`, name: '', url: '', status: 'agreed', note: '' });
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
    note.value = `${result.fetched.length} ${result.fetched.length === 1 ? 'picture' : 'pictures'} fetched.`;
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
    const started = await api.syncSource({ id: source.id, url: source.url, name: source.name });
    const result = await track(started);
    jobs.dismissed.push(started.id);
    Object.assign(source, result.source);
    const answer = await api.sources();
    pictures.value = answer.pictures ?? {};
    savedText.value = JSON.stringify(answer.sources);
    if (result.pictureError) pictureError.value = `${result.source.name} is saved, but its picture was not fetched: ${result.pictureError}`;
    else note.value = `${result.source.name} is in your list, with its picture.`;
  } catch (e) {
    error.value = e.message;
  }
  syncingId.value = '';
}

async function fetchPart() {
  fetchError.value = '';
  try {
    await track(await api.fetchVideo({ url: link.value, start: start.value, end: end.value }));
    link.value = '';
  } catch (e) {
    fetchError.value = e.message;
  }
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
          <span v-if="gettingPictures" class="spinner" aria-hidden="true" /><Icon v-else name="download" /> Get the channels' pictures
        </button>
        <button class="fixed" @click="add"><Icon name="plus" /> Add a channel</button>
      </div>
      <p class="hint first">
        Add a channel only once it has agreed to let you use its videos. Paste its address and press the round arrows
        on its row: the name and picture come from YouTube and the channel is saved. A name you type yourself is kept.
        The picture is shown beside the name wherever that channel is credited in a compilation.
      </p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="pictureError" class="error" role="alert">{{ pictureError }}</p>
      <p v-if="loaded && sources.length === 0" class="empty">No channels yet. Add the first one that has agreed.</p>

      <div v-for="(source, index) in sources" :key="source.id" class="row source">
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
        <button
          class="fixed quiet icon-only sync" :disabled="!source.url.trim() || Boolean(syncing) || Boolean(gettingPictures) || !installed"
          :aria-label="`Get the name and picture of ${source.name || 'this channel'} from YouTube`" title="Get the name and picture from YouTube" @click="sync(source)"
        >
          <span v-if="syncing && syncingId === source.id" class="spinner" aria-hidden="true" /><Icon v-else name="sync" />
        </button>
        <TrashButton class="fixed" :label="`Remove ${source.name || 'this channel'} from the list`" @click="sources.splice(index, 1)" />
      </div>

      <div class="row middle actions">
        <button class="fixed primary" :disabled="!unsaved" @click="save">Save the list</button>
        <span v-if="unsaved" class="chip warn fixed">Changes not saved</span>
        <span v-else role="status" class="muted">{{ note }}</span>
      </div>
    </section>

    <section class="panel">
      <h2><Icon name="download" /> Fetch part of a video</h2>
      <p class="hint first">
        Brings a part of a YouTube video into your videos, from a channel in the list above. Give the part you want,
        up to 20 minutes; the whole video is not downloaded. The picture is kept exactly as YouTube sends it, so the
        part starts up to a few seconds before the time you give. Set the exact start when you cut.
      </p>
      <p v-if="!installed" class="notice">The downloader is not installed yet. Run <code>npm run setup</code> in the project folder, then restart the dashboard.</p>
      <p v-else-if="loaded && allowed.length === 0" class="notice">Add at least one channel and save the list first.</p>
      <div class="row">
        <div class="wide"><label for="link">Link to the video</label><input id="link" v-model="link" type="text" placeholder="https://www.youtube.com/watch?v=..." /></div>
        <div class="narrow"><label for="fetch-start">From</label><input id="fetch-start" v-model="start" type="text" placeholder="1:02:00" class="numbers" /></div>
        <div class="narrow"><label for="fetch-end">To</label><input id="fetch-end" v-model="end" type="text" placeholder="1:04:30" class="numbers" /></div>
        <button class="fixed primary" :disabled="!link || !start || !end || Boolean(fetching) || !installed || allowed.length === 0" @click="fetchPart">
          <Icon name="download" /> Fetch
        </button>
      </div>
      <p v-if="fetching" class="running" role="status"><span class="spinner" aria-hidden="true" /> {{ describe(fetching) }}</p>
      <p v-if="fetchError" class="error" role="alert">{{ fetchError }}</p>
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
.sync:hover:not(:disabled) { color: var(--accent); }
.name { flex: 1 1 180px; }
.wide { flex: 3 1 260px; }
.narrow { flex: 0 1 170px; }
.actions { margin-top: 14px; }
.error { margin-top: 10px; }
.running { display: flex; align-items: center; gap: 8px; margin: 12px 0 0; }
</style>
