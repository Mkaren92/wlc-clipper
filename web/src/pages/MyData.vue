<script setup>
// The owner's data as one file: download it here, load it on another machine.
//
// A load has two steps, and the page shows the first one's result before the
// second can be pressed: what the file holds beside what is here, and what
// would be replaced. Nothing is changed until "Load it" is pressed, and what
// a load replaces is kept aside on the server, never deleted.
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';
import Icon from '../components/Icon.vue';

const state = ref(null); // { file, free, here, waiting }
const error = ref('');
const reading = ref(''); // the name of the file being taken in
const loading = ref(false);
const report = ref(null); // what the last load did
const chooser = ref(null);

// What is counted, in the owner's words, in the order it is shown.
const KINDS = [
  ['channels', 'Channels'], ['channelsWithClub', '… with a club'], ['channelPictures', '… with a picture'],
  ['leagues', 'Leagues'], ['clubs', 'Clubs'], ['clubsWithLogo', '… with a logo'], ['sounds', 'Sounds'], ['overlays', 'Overlays'], ['briefs', 'Briefs'],
];

const megabytes = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : bytes >= 1e6 ? `${Math.round(bytes / 1e6)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`);
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'an unknown time');
const waiting = computed(() => state.value?.waiting ?? null);

/** What a load would replace, said as things and not as file names. */
const replaced = computed(() => {
  const said = new Set();
  for (const name of waiting.value?.replaces ?? []) {
    const [folder, second] = name.split('/');
    if (name === 'data/sources.json') said.add('Your channels list, with the club each streamer supports');
    else if (name === 'data/clubs.json') said.add('Your leagues and clubs, with their logos');
    else if (name === 'data/source-subscribers.json') said.add('The subscriber counts');
    else if (second === 'source-pictures') said.add('Channel pictures');
    else if (folder === 'sounds') said.add(`The sound ${second}`);
    else if (folder === 'overlays') said.add(`The overlay ${second}`);
    else if (folder === 'briefs') said.add(`The brief ${second}`);
  }
  return [...said];
});
// The file is older than something here: a sign it may be the wrong way round.
const fewer = computed(() => waiting.value !== null && KINDS.some(([key]) => ['channels', 'channelsWithClub', 'clubsWithLogo'].includes(key) && waiting.value.holds[key] < waiting.value.here[key]));

async function refresh() {
  try {
    state.value = await api.transfer();
  } catch (e) {
    error.value = e.message;
  }
}
onMounted(refresh);

// Step 1: the file is sent to the server, which checks it and says what is in it.
async function chosen(file) {
  if (!file) return;
  error.value = '';
  report.value = null;
  reading.value = file.name;
  try {
    await api.takeInData(file);
  } catch (e) {
    error.value = e.message;
  }
  reading.value = '';
  if (chooser.value) chooser.value.value = '';
  await refresh();
}

// Step 2: put it in place.
async function load() {
  error.value = '';
  loading.value = true;
  try {
    report.value = await api.loadData();
  } catch (e) {
    error.value = e.message;
  }
  loading.value = false;
  await refresh();
}

async function cancel() {
  error.value = '';
  try {
    await api.discardData();
  } catch (e) {
    error.value = e.message;
  }
  await refresh();
}
</script>

<template>
  <div class="stack">
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <section class="panel">
      <h2><Icon name="download" /> Download my data</h2>
      <p class="hint first">
        One file to take to another computer, or to keep as a backup. It holds what you chose to carry:
      </p>
      <ul class="holds">
        <li><strong>Your channels</strong>, with the club each streamer supports, their pictures and subscriber counts</li>
        <li><strong>Your leagues and clubs</strong>, with all their logos</li>
        <li><strong>Your sounds</strong>, among them the video behind the intro card</li>
        <li><strong>Your overlay images</strong>, the logos in the <code>overlays</code> folder</li>
        <li><strong>Your briefs</strong></li>
      </ul>
      <p v-if="state"><a class="button" :href="api.dataFileUrl()" download><Icon name="download" /> Download my data · {{ megabytes(state.file.bytes) }}</a></p>
      <p class="hint">
        Staying on this computer: videos, parts, clips, combinations, compilations, and matches with their cards.
        Never in the file: your AI key (copy the file <code>.env</code> by hand if you use one).
      </p>
    </section>

    <section class="panel">
      <h2><Icon name="box" /> Load my data</h2>
      <p class="hint first">
        Choose a file made with “Download my data”. You are shown what is in it before anything changes. A load never
        deletes: what it replaces here is moved into a dated folder under <code>data/backups</code> and stays there.
      </p>

      <template v-if="!waiting">
        <label for="data-file">Data file</label>
        <input id="data-file" ref="chooser" type="file" accept=".tar,application/x-tar" :disabled="Boolean(reading)" @change="chosen($event.target.files[0])" />
        <p v-if="reading" class="running" role="status"><span class="spinner" aria-hidden="true" /> Reading {{ reading }}…</p>
      </template>

      <div v-else class="waiting">
        <p class="what"><strong>Data file</strong>, made {{ when(waiting.made) }} · {{ megabytes(waiting.bytes) }} · {{ waiting.files }} files</p>
        <table>
          <thead><tr><th scope="col" /><th scope="col">In the file</th><th scope="col">Here now</th></tr></thead>
          <tbody>
            <tr v-for="[key, text] in KINDS" :key="key" :class="{ sub: text.startsWith('…') }">
              <th scope="row">{{ text }}</th>
              <td class="numbers">{{ waiting.holds[key] }}</td>
              <td class="numbers">{{ waiting.here[key] }}</td>
            </tr>
          </tbody>
        </table>

        <p v-if="fewer" class="notice">
          The file has fewer of some things than this computer has now. If this computer is the newer one, press
          Cancel: loading would put the older lists in place of yours.
        </p>
        <div v-if="replaced.length > 0" class="confirm" role="note">
          <span><strong>Loading will replace {{ replaced.length }} {{ replaced.length === 1 ? 'thing' : 'things' }} here.</strong> Each is kept in <code>data/backups</code>, not deleted:</span>
          <ul><li v-for="thing in replaced.slice(0, 14)" :key="thing">{{ thing }}</li><li v-if="replaced.length > 14">and {{ replaced.length - 14 }} more</li></ul>
        </div>
        <p v-else class="hint">Nothing here would be replaced: everything in the file is new to this computer, or the same as what is here.</p>
        <p v-if="waiting.passedOver > 0" class="hint">{{ waiting.passedOver }} {{ waiting.passedOver === 1 ? 'file' : 'files' }} in it that this tool does not keep will be passed over.</p>

        <div class="row middle actions">
          <button class="fixed primary" :disabled="loading" @click="load"><span v-if="loading" class="spinner" aria-hidden="true" /> Load it</button>
          <button class="fixed" :disabled="loading" @click="cancel">Cancel</button>
        </div>
      </div>

      <div v-if="report" class="done" role="status">
        <p><Icon name="check" /> <strong>Loaded.</strong> {{ report.added }} new, {{ report.replaced }} replaced, {{ report.same }} already the same.</p>
        <p v-if="report.kept" class="hint">What was replaced is kept in <code>data/{{ report.kept }}</code>.</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.panel > h2 { display: flex; align-items: center; gap: 8px; margin: 0; }
.first { margin: 6px 0 12px; }
.holds { margin: 0 0 12px; padding-left: 20px; }
.holds li { margin: 2px 0; }
a.button {
  display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 6px 14px; border-radius: var(--radius);
  background: var(--accent); color: var(--accent-text); font-weight: 650; text-decoration: none;
}
a.button:hover { background: var(--accent-hover); }
.running { display: flex; align-items: center; gap: 8px; margin: 10px 0 0; }
.what { margin: 0 0 10px; }
table { border-collapse: collapse; margin-bottom: 12px; }
th, td { padding: 3px 14px 3px 0; text-align: left; font-weight: 400; }
thead th { font-size: 13px; font-weight: 550; color: var(--muted); border-bottom: 1px solid var(--line); }
tbody th { color: var(--text); }
td { text-align: right; font-weight: 650; }
tr.sub th { color: var(--muted); padding-left: 14px; }
tr.sub td { font-weight: 400; }
.confirm ul { flex: 1 1 100%; margin: 4px 0 0; padding-left: 20px; }
.actions { margin-top: 14px; gap: 8px; }
.done { margin-top: 14px; padding: 10px 12px; border: 1px solid var(--good); background: var(--good-bg); border-radius: var(--radius); }
.done p { margin: 0; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.done .hint { margin-top: 4px; }
</style>
