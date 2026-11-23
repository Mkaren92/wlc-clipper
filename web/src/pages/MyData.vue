<script setup>
// The owner's data as one file: download it here, load it on another machine.
//
// A load has two steps, and the page shows the first one's result before the
// second can be pressed: what the file holds beside what is here, and what
// would be replaced. Nothing is changed until "Load it" is pressed, and what
// a load replaces is kept aside on the server, never deleted.
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api.js';
import Icon from '../components/Icon.vue';
import { refreshSync, sync, takeSync } from '../sync.js';

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

// --- Sync with GitHub ---------------------------------------------------------------

const address = ref('');
const looked = ref(null); // what "Check this address" found: { remote, empty, there, here }
const syncBusy = ref('');
const syncError = ref('');
const leaving = ref(false);
const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '');
/** A file's name from the repository, in the owner's words. */
function thing(name) {
  if (name === 'data/sources.json') return 'your channels list';
  if (name === 'data/clubs.json') return 'your leagues and clubs';
  if (name === 'data/source-subscribers.json') return 'the subscriber counts';
  if (name.startsWith('data/source-pictures/')) return 'a channel picture';
  return name.split('/').slice(1).join('/');
}
const short = (names) => {
  const said = [...new Set(names.map(thing))];
  return said.length > 6 ? `${said.slice(0, 6).join(', ')} and ${said.length - 6} more` : said.join(', ');
};

async function syncDo(label, work) {
  syncError.value = '';
  syncBusy.value = label;
  try {
    await work();
  } catch (e) {
    syncError.value = e.message;
  }
  syncBusy.value = '';
}
const check = () => syncDo('Asking GitHub…', async () => {
  looked.value = null;
  looked.value = await api.syncLook(address.value);
});
const connect = (wins) => syncDo('Connecting…', async () => {
  takeSync(await api.syncConnect(looked.value.remote, wins));
  looked.value = null;
  address.value = '';
  await refresh();
});
const syncNow = () => syncDo('Syncing…', async () => {
  takeSync(await api.syncNow());
  await refresh();
});
const disconnect = () => syncDo('Disconnecting…', async () => {
  takeSync(await api.syncOff());
  leaving.value = false;
});

async function refresh() {
  try {
    state.value = await api.transfer();
  } catch (e) {
    error.value = e.message;
  }
}
// While this page is open it asks every few seconds how syncing stands, so what arrives from the
// other computer is shown when it arrives. (The server does the syncing; asking it costs nothing.)
let asking = null;
onMounted(() => {
  refresh();
  refreshSync();
  asking = setInterval(() => {
    if (!document.hidden && !syncBusy.value) refreshSync();
  }, 5000);
});
onUnmounted(() => clearInterval(asking));

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
      <h2><Icon name="sync" /> Sync with GitHub</h2>
      <p class="hint first">
        Keeps what you chose to carry the same on every computer, by itself, through a private repository of yours on
        GitHub: your channels with their clubs, leagues and clubs with logos, sounds, briefs and overlays. Videos and
        clips stay on each computer.
      </p>
      <p v-if="syncError" class="error" role="alert">{{ syncError }}</p>

      <template v-if="sync.connected">
        <p class="status" role="status">
          <span v-if="syncBusy || sync.state === 'syncing'" class="running"><span class="spinner" aria-hidden="true" /> {{ syncBusy || 'Syncing…' }}</span>
          <span v-else-if="sync.state === 'error'" class="chip bad">Sync is failing</span>
          <span v-else-if="sync.state === 'offline'" class="chip warn">Offline</span>
          <span v-else class="chip good"><Icon name="check" /> In sync</span>
          <span class="muted">{{ sync.last ? `last synced at ${clock(sync.last)}` : 'not synced yet in this run' }} · <code>{{ sync.remote }}</code></span>
        </p>
        <p v-if="sync.message" class="notice">{{ sync.message }}</p>
        <div v-if="sync.result" class="last">
          <p v-if="sync.result.sent">Sent this computer's changes to GitHub at {{ clock(sync.result.at) }}.</p>
          <p v-if="sync.result.arrived?.length">Arrived from your other computer at {{ clock(sync.result.at) }}: {{ short(sync.result.arrived) }}.</p>
          <p v-if="sync.result.setAside?.length">Replaced or removed on the other computer, and kept here in <code>data/backups/sync</code>: {{ short(sync.result.setAside) }}.</p>
          <div v-if="sync.result.clashes?.length" class="confirm" role="note">
            <span><strong>Changed on both computers before they synced.</strong> The other computer's version was kept; this one's is in the repository's history:</span>
            <ul><li v-for="clash in sync.result.clashes" :key="clash">{{ clash }}</li></ul>
          </div>
        </div>
        <div class="row middle actions">
          <button class="fixed primary" :disabled="Boolean(syncBusy)" @click="syncNow"><Icon name="sync" /> Sync now</button>
          <button v-if="!leaving" class="fixed" :disabled="Boolean(syncBusy)" @click="leaving = true">Disconnect</button>
        </div>
        <div v-if="leaving" class="confirm" role="alertdialog">
          <span>Stop syncing on this computer? Its data stays as it is, and so does what is on GitHub. You can connect again later.</span>
          <button class="small danger" @click="disconnect">Disconnect</button>
          <button class="small" @click="leaving = false">Cancel</button>
        </div>
      </template>

      <template v-else>
        <div class="row">
          <div>
            <label for="sync-address">Address of your private data repository</label>
            <input id="sync-address" v-model="address" type="text" placeholder="git@github.com:you/wlc-clipper-data.git" :disabled="Boolean(syncBusy)" />
          </div>
          <button class="fixed" :disabled="!address.trim() || Boolean(syncBusy)" @click="check">Check this address</button>
        </div>
        <p v-if="syncBusy" class="running" role="status"><span class="spinner" aria-hidden="true" /> {{ syncBusy }}</p>
        <p class="hint">
          Make the repository on GitHub first: New repository, a name such as <code>wlc-clipper-data</code>,
          <strong>Private</strong>, and nothing else ticked. Connect the computer that has your data first.
        </p>

        <div v-if="looked" class="waiting">
          <template v-if="looked.empty">
            <p class="what"><strong>The repository is empty.</strong> This computer's data will be sent to it:</p>
            <table><tbody><tr v-for="[key, text] in KINDS" :key="key" :class="{ sub: text.startsWith('…') }"><th scope="row">{{ text }}</th><td class="numbers">{{ looked.here[key] ?? 0 }}</td></tr></tbody></table>
            <div class="row middle actions">
              <button class="fixed primary" :disabled="Boolean(syncBusy)" @click="connect()">Connect and send</button>
              <button class="fixed" :disabled="Boolean(syncBusy)" @click="looked = null">Cancel</button>
            </div>
          </template>
          <template v-else>
            <p class="what"><strong>The repository already holds data.</strong> Choose whose lists to keep. Whichever you choose, files only one side has are kept, and this computer's lists as they are now are saved under <code>data/backups</code>.</p>
            <table>
              <thead><tr><th scope="col" /><th scope="col">On GitHub</th><th scope="col">Here now</th></tr></thead>
              <tbody><tr v-for="[key, text] in KINDS" :key="key" :class="{ sub: text.startsWith('…') }"><th scope="row">{{ text }}</th><td class="numbers">{{ looked.there[key] ?? 0 }}</td><td class="numbers">{{ looked.here[key] ?? 0 }}</td></tr></tbody>
            </table>
            <div class="row middle actions">
              <button class="fixed primary" :disabled="Boolean(syncBusy)" @click="connect('github')">Take GitHub's data onto this computer</button>
              <button class="fixed" :disabled="Boolean(syncBusy)" @click="connect('here')">Send this computer's lists to GitHub instead</button>
              <button class="fixed" :disabled="Boolean(syncBusy)" @click="looked = null">Cancel</button>
            </div>
          </template>
        </div>
      </template>
    </section>

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
.status { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 0 0 8px; }
.last p { margin: 0 0 4px; }
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
