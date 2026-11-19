<script setup>
// The channels whose videos may be brought in, where each one stands, and
// the form that fetches part of a video from a channel that has agreed.
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';
import TrashButton from '../components/TrashButton.vue';
import { describe, isActive, jobs, track } from '../jobs.js';

const STATUS_NAMES = { asked: 'Asked, waiting', agreed: 'Agreed', declined: 'Declined' };

const sources = ref([]);
const installed = ref(true);
const error = ref('');
const note = ref('');
const link = ref('');
const start = ref('');
const end = ref('');
const fetchError = ref('');

const agreed = computed(() => sources.value.filter((source) => source.status === 'agreed'));
const fetching = computed(() => jobs.list.find((job) => job.kind === 'fetch' && isActive(job)));

function show(answer) {
  sources.value = answer.sources;
  installed.value = answer.downloaderInstalled;
}
onMounted(async () => {
  try {
    show(await api.sources());
  } catch (e) {
    error.value = e.message;
  }
});

function add() {
  sources.value.push({ id: `s${Date.now().toString(36)}`, name: '', url: '', status: 'asked', note: '' });
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
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <section class="panel">
      <h2>Sources</h2>
      <p class="muted">
        The channels you take reaction clips from, and whether each has agreed. Only a channel marked “Agreed” can be
        fetched from. A compilation's description lists each agreed channel's link next to its credit, when the credit
        is spelled like the name here.
      </p>
      <p v-if="sources.length === 0" class="muted">No sources yet.</p>
      <div v-for="(source, index) in sources" :key="source.id" class="row source">
        <div><label :for="`name-${source.id}`">Name</label><input :id="`name-${source.id}`" v-model="source.name" type="text" /></div>
        <div class="wide"><label :for="`url-${source.id}`">Channel address</label><input :id="`url-${source.id}`" v-model="source.url" type="text" placeholder="https://www.youtube.com/@name" /></div>
        <div class="narrow">
          <label :for="`status-${source.id}`">Status</label>
          <select :id="`status-${source.id}`" v-model="source.status">
            <option v-for="(text, id) in STATUS_NAMES" :key="id" :value="id">{{ text }}</option>
          </select>
        </div>
        <div class="wide"><label :for="`note-${source.id}`">Note: where and when they answered</label><input :id="`note-${source.id}`" v-model="source.note" type="text" /></div>
        <TrashButton class="fixed" :label="`Remove ${source.name || 'this source'} from the list`" @click="sources.splice(index, 1)" />
      </div>
      <div class="row actions">
        <button class="fixed" @click="add">Add a source</button>
        <button class="fixed primary" @click="save">Save the list</button>
        <span role="status" class="muted">{{ note }}</span>
      </div>
    </section>

    <section class="panel">
      <h2>Fetch part of a video</h2>
      <p class="muted">
        Brings a part of a YouTube video into your videos, from a channel marked “Agreed” above
        <span v-if="agreed.length > 0">({{ agreed.map((source) => source.name).join(', ') }})</span>.
        Give the part you want, up to 20 minutes; the whole video is not downloaded. The picture is kept exactly as
        YouTube sends it, so the part starts up to a few seconds before the time you give. Set the exact start when
        you cut.
      </p>
      <p v-if="!installed" class="notice">The downloader is not installed yet. Run <code>npm run setup</code> in the project folder, then restart the dashboard.</p>
      <div class="row">
        <div class="wide"><label for="link">Link to the video</label><input id="link" v-model="link" type="text" placeholder="https://www.youtube.com/watch?v=..." /></div>
        <div class="narrow"><label for="fetch-start">From</label><input id="fetch-start" v-model="start" type="text" placeholder="1:02:00" /></div>
        <div class="narrow"><label for="fetch-end">To</label><input id="fetch-end" v-model="end" type="text" placeholder="1:04:30" /></div>
        <button class="fixed primary" :disabled="!link || !start || !end || Boolean(fetching) || !installed || agreed.length === 0" @click="fetchPart">Fetch</button>
      </div>
      <p v-if="agreed.length === 0" class="muted hint">Mark at least one source as “Agreed” and save the list first.</p>
      <p v-if="fetching" role="status">{{ describe(fetching) }}</p>
      <p v-if="fetchError" class="error" role="alert">{{ fetchError }}</p>
    </section>
  </div>
</template>

<style scoped>
.sources { max-width: 1200px; }
.source { padding: 10px 0; border-top: 1px solid var(--line); align-items: end; }
.wide { flex: 3 1 240px; }
.narrow { flex: 0 1 160px; }
.actions { margin-top: 12px; align-items: center; }
.hint { margin: 8px 0 0; font-size: 13px; }
</style>
