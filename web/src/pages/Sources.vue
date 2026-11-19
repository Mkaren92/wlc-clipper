<script setup>
// The channels whose videos may be brought in, where each one stands, and
// the form that fetches part of a video from a channel that has agreed.
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';
import Icon from '../components/Icon.vue';
import TrashButton from '../components/TrashButton.vue';
import { describe, isActive, jobs, track } from '../jobs.js';

const STATUS_NAMES = { asked: 'Asked, waiting', agreed: 'Agreed', declined: 'Declined' };
const STATUS_CHIPS = { asked: 'warn', agreed: 'good', declined: 'bad' };

const sources = ref([]);
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

// Only what is saved counts: a row switched to "Agreed" allows nothing until the list is saved.
const agreed = computed(() => JSON.parse(savedText.value).filter((source) => source.status === 'agreed'));
const fetching = computed(() => jobs.list.find((job) => job.kind === 'fetch' && isActive(job)));
const counts = computed(() => Object.keys(STATUS_NAMES).map((status) => [status, sources.value.filter((source) => source.status === status).length]));

function show(answer) {
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
  sources.value.push({ id: `s${Date.now().toString(36)}`, name: '', url: '', status: 'asked', note: '' });
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
        <span v-for="[status, count] in counts" :key="status" class="chip fixed" :class="STATUS_CHIPS[status]">{{ count }} {{ STATUS_NAMES[status].toLowerCase() }}</span>
        <span />
        <button class="fixed" @click="add"><Icon name="plus" /> Add a channel</button>
      </div>
      <p class="hint first">
        Only a channel marked “Agreed” can be fetched from. A compilation's description lists each agreed channel's
        address next to its credit, when the credit is spelled like the name here.
      </p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="loaded && sources.length === 0" class="empty">No channels yet. Add one, then note here when you asked and what they answered.</p>

      <div v-for="(source, index) in sources" :key="source.id" class="source" :class="source.status">
        <div class="row">
          <div class="name"><label :for="`name-${source.id}`">Name</label><input :id="`name-${source.id}`" v-model="source.name" type="text" /></div>
          <div class="wide"><label :for="`url-${source.id}`">Channel address</label><input :id="`url-${source.id}`" v-model="source.url" type="text" placeholder="https://www.youtube.com/@name" /></div>
          <div class="narrow">
            <label :for="`status-${source.id}`">Status</label>
            <select :id="`status-${source.id}`" v-model="source.status">
              <option v-for="(text, id) in STATUS_NAMES" :key="id" :value="id">{{ text }}</option>
            </select>
          </div>
          <TrashButton class="fixed" :label="`Remove ${source.name || 'this channel'} from the list`" @click="sources.splice(index, 1)" />
        </div>
        <div class="note">
          <label :for="`note-${source.id}`">Note: where and when they answered</label>
          <input :id="`note-${source.id}`" v-model="source.note" type="text" />
        </div>
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
        Brings a part of a YouTube video into your videos, from a channel marked “Agreed” above<span v-if="agreed.length > 0">
          ({{ agreed.map((source) => source.name).join(', ') }})</span>.
        Give the part you want, up to 20 minutes; the whole video is not downloaded. The picture is kept exactly as
        YouTube sends it, so the part starts up to a few seconds before the time you give. Set the exact start when
        you cut.
      </p>
      <p v-if="!installed" class="notice">The downloader is not installed yet. Run <code>npm run setup</code> in the project folder, then restart the dashboard.</p>
      <p v-else-if="loaded && agreed.length === 0" class="notice">Mark at least one channel as “Agreed” and save the list first.</p>
      <div class="row">
        <div class="wide"><label for="link">Link to the video</label><input id="link" v-model="link" type="text" placeholder="https://www.youtube.com/watch?v=..." /></div>
        <div class="narrow"><label for="fetch-start">From</label><input id="fetch-start" v-model="start" type="text" placeholder="1:02:00" class="numbers" /></div>
        <div class="narrow"><label for="fetch-end">To</label><input id="fetch-end" v-model="end" type="text" placeholder="1:04:30" class="numbers" /></div>
        <button class="fixed primary" :disabled="!link || !start || !end || Boolean(fetching) || !installed || agreed.length === 0" @click="fetchPart">
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
.source {
  padding: 12px 12px 12px 16px; margin-top: 10px; border: 1px solid var(--line); border-radius: var(--radius);
  box-shadow: inset 4px 0 0 var(--warn);
}
.source.agreed { box-shadow: inset 4px 0 0 var(--good); }
.source.declined { box-shadow: inset 4px 0 0 var(--bad); }
.source .note { margin-top: 10px; }
.name { flex: 1 1 180px; }
.wide { flex: 3 1 260px; }
.narrow { flex: 0 1 170px; }
.actions { margin-top: 14px; }
.error { margin-top: 10px; }
.running { display: flex; align-items: center; gap: 8px; margin: 12px 0 0; }
</style>
