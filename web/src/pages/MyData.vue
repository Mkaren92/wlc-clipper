<script setup>
// The owner's data that travels between machines, kept the same on each of
// them through a private GitHub repository. The server does the syncing
// (server/sync.js); this page connects a machine, shows how sync stands, and
// asks for a round now.
import { onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api.js';
import Icon from '../components/Icon.vue';
import { refreshSync, sync, takeSync } from '../sync.js';

// What is counted, in the owner's words, in the order it is shown.
const KINDS = [
  ['channels', 'Channels'], ['channelsWithClub', '… with a club'], ['channelPictures', '… with a picture'],
  ['leagues', 'Leagues'], ['clubs', 'Clubs'], ['clubsWithLogo', '… with a logo'], ['sounds', 'Sounds'], ['overlays', 'Overlays'], ['briefs', 'Briefs'],
];

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
});
const syncNow = () => syncDo('Syncing…', async () => {
  takeSync(await api.syncNow());
});
const disconnect = () => syncDo('Disconnecting…', async () => {
  takeSync(await api.syncOff());
  leaving.value = false;
});

// While this page is open it asks every few seconds how syncing stands, so what arrives from the
// other computer is shown when it arrives. (The server does the syncing; asking it costs nothing.)
let asking = null;
onMounted(() => {
  refreshSync();
  asking = setInterval(() => {
    if (!document.hidden && !syncBusy.value) refreshSync();
  }, 5000);
});
onUnmounted(() => clearInterval(asking));
</script>

<template>
  <div class="stack">
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
  </div>
</template>

<style scoped>
.panel > h2 { display: flex; align-items: center; gap: 8px; margin: 0; }
.status { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 0 0 8px; }
.last p { margin: 0 0 4px; }
.first { margin: 6px 0 12px; }
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
</style>
