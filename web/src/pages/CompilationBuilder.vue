<script setup>
// Put videos and cards in order and render them into one video.
import { computed, onMounted, reactive, ref } from 'vue';
import { minuteLabel } from '../../../src/cards/config.js';
import { api } from '../api.js';
import { clock } from '../format.js';
import TrashButton from '../components/TrashButton.vue';
import { isActive, jobs, track } from '../jobs.js';

const PRESET_NAMES = { landscape: '1920×1080 (wide), 30 fps', portrait: '1080×1920 (tall), 30 fps' };
const LIBRARIES = { in: 'Videos', parts: 'Parts', clips: 'Clips' };
const STATE_NAMES = { waiting: 'Waiting', working: 'Working…', done: 'Done', reused: 'Done (kept from last time)' };

const compilations = ref([]);
const current = ref(null); // the compilation being edited: a copy, saved with Save or Generate
const matches = ref([]);
const sources = ref([]); // for filling in the credit of a fetched video
const prefixes = ref({}); // source id -> what its fetched files are named after
const library = reactive({ in: [], parts: [], clips: [] });
const pick = reactive({ in: '', parts: '', clips: '', match: '', card: '' });
const lengths = reactive({}); // "folder/name" -> seconds, for the running total
const error = ref('');
const note = ref('');
const uploading = ref('');
const dropping = ref(false);
const confirming = ref('');
const dragged = ref(-1);
const lastResult = ref(null);

const copy = (value) => JSON.parse(JSON.stringify(value));
const newId = () => `i${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const key = (item) => `${item.library}/${item.name}`;

async function load() {
  try {
    const [saved, savedMatches, videos, parts, clips, sourceList] = await Promise.all([api.compilations(), api.matches(), api.videos(), api.parts(), api.clips(), api.sources()]);
    sources.value = sourceList.sources;
    prefixes.value = sourceList.prefixes;
    compilations.value = saved;
    matches.value = savedMatches;
    library.in = videos.map((v) => v.name);
    library.parts = parts.map((p) => p.name);
    library.clips = clips.filter((c) => c.rendered).map((c) => c.name);
    error.value = '';
  } catch (e) {
    error.value = e.message;
  }
}
onMounted(async () => {
  await load();
  if (compilations.value.length > 0) open(compilations.value[0]);
});

function open(saved) {
  current.value = copy(saved);
  lastResult.value = null;
  note.value = '';
  for (const item of current.value.items) if (item.kind === 'video') learnLength(item);
}

async function create() {
  try {
    const made = await api.createCompilation({ name: 'New compilation', preset: 'landscape', items: [] });
    await load();
    open(made);
  } catch (e) {
    error.value = e.message;
  }
}

async function remove(id) {
  try {
    await api.deleteCompilation(id);
    confirming.value = '';
    if (current.value?.id === id) current.value = null;
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

// --- Adding items ---------------------------------------------------------------

async function learnLength(item) {
  if (lengths[key(item)] !== undefined) return;
  try {
    lengths[key(item)] = (await api.videoInfo(item.library, item.name)).duration;
  } catch {
    lengths[key(item)] = null; // the file is gone; Generate will say so
  }
}

// A fetched video is named after its channel, so its credit can be filled in.
const creditFor = (name) => sources.value.find((source) => name.startsWith(`${prefixes.value[source.id]}_`))?.name ?? '';

function addVideo(folder, name) {
  if (!name) return;
  const item = { id: newId(), kind: 'video', library: folder, name, start: null, end: null, credit: creditFor(name) };
  current.value.items.push(item);
  learnLength(item);
}

function addCard() {
  if (!pick.match || !pick.card) return;
  current.value.items.push({ id: newId(), kind: 'card', matchId: pick.match, cardId: pick.card, seconds: 3 });
}

// A file chosen here is copied into the project's videos folder first: a
// page cannot tell the server where the original file is.
async function addFiles(files) {
  error.value = '';
  for (const file of files) {
    try {
      uploading.value = `Copying ${file.name} into the videos folder…`;
      const { name } = await api.upload(file);
      if (!library.in.includes(name)) library.in.push(name);
      addVideo('in', name);
    } catch (e) {
      error.value = `${file.name}: ${e.message}`;
    }
  }
  uploading.value = '';
}
function onDrop(event) {
  dropping.value = false;
  addFiles([...event.dataTransfer.files]);
}

// --- The timeline ---------------------------------------------------------------

const pickedMatch = computed(() => matches.value.find((m) => m.id === pick.match));

function cardLabel(card) {
  if (card.type === 'goal') return `Goal: ${minuteLabel(card.minute, card.added)} ${card.scorer}`.trim();
  if (card.type === 'red') return `Red card: ${minuteLabel(card.minute, card.added)} ${card.player}`.trim();
  return `Full time ${card.homeScore}–${card.awayScore}`;
}
function title(item) {
  if (item.kind === 'video') return item.name;
  const match = matches.value.find((m) => m.id === item.matchId);
  const card = match?.cards.find((c) => c.id === item.cardId);
  return card ? `${cardLabel(card)} (${match.home} v ${match.away})` : 'A card that was deleted';
}
function seconds(item) {
  if (item.kind === 'card') return Number(item.seconds) || 0;
  const whole = lengths[key(item)];
  if (whole === undefined || whole === null) return 0;
  return Math.max(0, (item.end ?? whole) - (item.start ?? 0));
}
const total = computed(() => current.value.items.reduce((sum, item) => sum + seconds(item), 0));

function move(from, to) {
  const items = current.value.items;
  if (to < 0 || to >= items.length || from === to) return;
  items.splice(to, 0, items.splice(from, 1)[0]);
}
function dropOn(index) {
  if (dragged.value >= 0) move(dragged.value, index);
  dragged.value = -1;
}
// An empty box means "from the start" or "to the end".
const blankIsNull = (item, field, value) => (item[field] = value === '' || value === null ? null : Math.max(0, Number(value)));

// --- Saving and generating ----------------------------------------------------------

const job = computed(() => jobs.list.find((j) => j.kind === 'compile' && isActive(j) && j.label === current.value?.name));
/** What to show beside an item: its state in the run going on, or in the one just finished. */
function state(index) {
  const running = job.value?.detail?.items?.[index];
  if (running) return STATE_NAMES[running];
  const finished = lastResult.value?.items?.[index];
  return finished ? STATE_NAMES[finished.reused ? 'reused' : 'done'] : '';
}

async function save() {
  error.value = '';
  try {
    const saved = await api.saveCompilation(current.value);
    await load();
    current.value = copy(saved);
    note.value = 'Saved.';
    return saved;
  } catch (e) {
    error.value = e.message;
    return null;
  }
}

async function generate() {
  note.value = '';
  lastResult.value = null;
  const saved = await save();
  if (!saved) return;
  note.value = '';
  try {
    lastResult.value = await track(await api.generate(saved.id));
    await load();
    const fresh = compilations.value.find((c) => c.id === saved.id);
    if (fresh && current.value?.id === saved.id) Object.assign(current.value, { final: fresh.final, description: fresh.description });
  } catch (e) {
    error.value = e.message;
  }
}
</script>

<template>
  <div class="builder">
    <section class="panel list">
      <h2>Compilations</h2>
      <button class="primary" @click="create">New compilation</button>
      <p v-if="compilations.length === 0" class="muted empty">No compilations yet.</p>
      <div v-for="saved in compilations" :key="saved.id" class="entry" :class="{ current: current?.id === saved.id }">
        <button class="open" @click="open(saved)">
          <strong>{{ saved.name }}</strong>
          <span class="muted">{{ saved.items.length }} items{{ saved.final ? ' · generated' : '' }}</span>
        </button>
        <div v-if="confirming !== saved.id" class="row tools">
          <span class="muted">{{ saved.preset === 'portrait' ? '1080×1920' : '1920×1080' }}</span>
          <TrashButton class="fixed" :label="`Delete the compilation ${saved.name}`" @click="confirming = saved.id" />
        </div>
        <div v-else class="confirm" role="alertdialog">
          <span>Delete this compilation, its final video and its description? This cannot be undone.</span>
          <button class="small danger" @click="remove(saved.id)">Delete</button>
          <button class="small" @click="confirming = ''">Cancel</button>
        </div>
      </div>
    </section>

    <div v-if="current" class="stack">
      <p v-if="error" class="error" role="alert">{{ error }}</p>

      <section class="panel">
        <div class="row">
          <div><label for="name">Name</label><input id="name" v-model="current.name" type="text" /></div>
          <div>
            <label for="preset">Size of the final video</label>
            <select id="preset" v-model="current.preset">
              <option v-for="(text, id) in PRESET_NAMES" :key="id" :value="id">{{ text }}</option>
            </select>
          </div>
        </div>
      </section>

      <section class="panel">
        <h2>Add videos</h2>
        <p class="muted hint">Videos already in the project are added as they are. Nothing is copied.</p>
        <div v-for="(text, folder) in LIBRARIES" :key="folder" class="row adder">
          <div>
            <label :for="`pick-${folder}`">{{ text }}</label>
            <select :id="`pick-${folder}`" v-model="pick[folder]">
              <option value="">{{ library[folder].length > 0 ? 'Choose…' : 'None yet' }}</option>
              <option v-for="name in library[folder]" :key="name" :value="name">{{ name }}</option>
            </select>
          </div>
          <button class="fixed" :disabled="!pick[folder]" @click="addVideo(folder, pick[folder])">Add</button>
        </div>
        <div
          class="drop" :class="{ over: dropping }"
          @dragover.prevent="dropping = true" @dragleave="dropping = false" @drop.prevent="onDrop"
        >
          <label for="files">Or choose files from your computer, or drop them here</label>
          <input id="files" type="file" accept="video/*,.mkv" multiple @change="addFiles([...$event.target.files]); $event.target.value = ''" />
          <p class="muted hint">A file from elsewhere is copied into the project's <code>in</code> folder, so it uses that much more disk space.</p>
          <p v-if="uploading" role="status">{{ uploading }}</p>
        </div>
      </section>

      <section class="panel">
        <h2>Add a card</h2>
        <p v-if="matches.length === 0" class="muted">No saved cards yet. Make some on the Cards page first.</p>
        <div v-else class="row adder">
          <div>
            <label for="pick-match">Match</label>
            <select id="pick-match" v-model="pick.match" @change="pick.card = ''">
              <option value="">Choose…</option>
              <option v-for="m in matches" :key="m.id" :value="m.id">{{ m.home }} v {{ m.away }}</option>
            </select>
          </div>
          <div>
            <label for="pick-card">Card</label>
            <select id="pick-card" v-model="pick.card" :disabled="!pickedMatch">
              <option value="">Choose…</option>
              <option v-for="c in pickedMatch?.cards ?? []" :key="c.id" :value="c.id">{{ cardLabel(c) }}</option>
            </select>
          </div>
          <button class="fixed" :disabled="!pick.card" @click="addCard">Add</button>
        </div>
      </section>

      <section class="panel">
        <h2>Timeline</h2>
        <p v-if="current.items.length === 0" class="muted">Add videos and cards above. They play in this order.</p>
        <ol class="timeline">
          <li
            v-for="(item, index) in current.items" :key="item.id" :class="[item.kind, { dragging: dragged === index }]"
            draggable="true" @dragstart="dragged = index" @dragend="dragged = -1" @dragover.prevent @drop.prevent="dropOn(index)"
          >
            <div class="row head">
              <span class="fixed grip" title="Drag to reorder" aria-hidden="true">⋮⋮</span>
              <strong class="what">{{ index + 1 }}. {{ item.kind === 'card' ? 'Card' : 'Video' }}: {{ title(item) }}</strong>
              <span class="fixed muted">{{ clock(seconds(item)) }}</span>
              <span v-if="state(index)" class="fixed state" role="status">{{ state(index) }}</span>
              <button class="fixed small" :disabled="index === 0" :aria-label="`Move item ${index + 1} up`" @click="move(index, index - 1)">Up</button>
              <button class="fixed small" :disabled="index === current.items.length - 1" :aria-label="`Move item ${index + 1} down`" @click="move(index, index + 1)">Down</button>
              <TrashButton class="fixed" :label="`Remove item ${index + 1} from the timeline`" @click="current.items.splice(index, 1)" />
            </div>
            <div v-if="item.kind === 'video'" class="row fields">
              <div class="narrow">
                <label :for="`start-${item.id}`">Start (seconds)</label>
                <input :id="`start-${item.id}`" type="number" min="0" step="0.1" placeholder="beginning" :value="item.start ?? ''" @input="blankIsNull(item, 'start', $event.target.value)" />
              </div>
              <div class="narrow">
                <label :for="`end-${item.id}`">End (seconds)</label>
                <input :id="`end-${item.id}`" type="number" min="0" step="0.1" placeholder="end" :value="item.end ?? ''" @input="blankIsNull(item, 'end', $event.target.value)" />
              </div>
              <div>
                <label :for="`credit-${item.id}`">Credit: the streamer's name, shown in a corner</label>
                <input :id="`credit-${item.id}`" v-model="item.credit" type="text" maxlength="60" />
              </div>
            </div>
            <div v-else class="row fields">
              <div class="narrow">
                <label :for="`seconds-${item.id}`">Shown for (seconds)</label>
                <input :id="`seconds-${item.id}`" v-model.number="item.seconds" type="number" min="0.5" max="60" step="0.5" />
              </div>
            </div>
          </li>
        </ol>
        <p class="total">Total length: <strong>{{ clock(total) }}</strong> ({{ current.items.length }} items)</p>
      </section>

      <section class="panel">
        <div class="row">
          <button class="fixed" :disabled="Boolean(job)" @click="save">Save</button>
          <button class="fixed primary" :disabled="Boolean(job) || current.items.length === 0" @click="generate">Generate the video</button>
          <span v-if="job" role="status">{{ job.step === 'joining' ? 'Joining the segments…' : 'Making the segments…' }}</span>
          <span v-else role="status" class="muted">{{ note }}</span>
        </div>
      </section>

      <section v-if="current.final" class="panel result">
        <h2>Final video</h2>
        <video :key="current.final.version" :src="api.finalUrl(current.id, current.final.version)" controls playsinline :class="current.preset" />
        <p>
          <a :href="api.finalUrl(current.id, current.final.version)" :download="`${current.name}.mp4`">Download the video</a>
          <span class="muted"> · it is also at <code>data/compilations/{{ current.id }}/final.mp4</code></span>
        </p>
        <h3>description.txt</h3>
        <pre>{{ current.description }}</pre>
      </section>
    </div>
    <p v-else class="muted">Choose a compilation, or start a new one.</p>
  </div>
</template>

<style scoped>
.builder { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 16px; align-items: start; }
.list .primary { width: 100%; margin-bottom: 10px; }
.empty { margin: 10px 0 0; }
.entry { border: 1px solid var(--line); border-radius: 8px; padding: 8px; margin-top: 8px; }
.entry.current { border-color: var(--accent); }
.open { display: flex; flex-direction: column; align-items: flex-start; width: 100%; text-align: left; border: 0; padding: 2px; background: transparent; font-size: 13px; }
.open strong { font-size: 14px; }
.tools { margin-top: 6px; align-items: center; font-size: 13px; }
.confirm { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 13px; margin-top: 6px; }
.confirm span { flex: 1 1 100%; }
.danger { background: var(--bad); border-color: var(--bad); color: #fff; font-weight: 600; }
.hint { margin: 0 0 8px; font-size: 13px; }
.adder { margin-bottom: 8px; }
.drop { border: 2px dashed var(--line); border-radius: 8px; padding: 12px; margin-top: 12px; }
.drop.over { border-color: var(--accent); }
.drop .hint { margin: 6px 0 0; }
.timeline { list-style: none; margin: 0; padding: 0; }
.timeline li { border: 1px solid var(--line); border-left: 5px solid var(--accent); border-radius: 8px; padding: 10px; margin-bottom: 8px; background: var(--panel); }
.timeline li.card { border-left-color: #e8a020; }
.timeline li.dragging { opacity: 0.5; }
.head { align-items: center; }
.grip { cursor: grab; color: var(--muted); letter-spacing: -2px; }
.what { word-break: break-all; }
.state { color: var(--good); font-size: 13px; }
.fields { margin-top: 8px; }
.narrow { flex: 0 1 150px; }
.total { margin: 12px 0 0; }
.result video { width: 100%; max-height: 60vh; background: #000; border-radius: 8px; display: block; }
.result video.portrait { max-width: 300px; }
pre { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 10px; white-space: pre-wrap; font: 13px ui-monospace, Menlo, monospace; }
@media (max-width: 900px) { .builder { grid-template-columns: 1fr; } }
</style>
