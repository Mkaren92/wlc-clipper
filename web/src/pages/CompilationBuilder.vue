<script setup>
// Put videos and cards in order and render them into one video.
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { minuteLabel } from '../../../src/cards/config.js';
import { api } from '../api.js';
import { clock } from '../format.js';
import Icon from '../components/Icon.vue';
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

// What the open compilation looked like when it was last saved or opened, to tell when it has changes.
const savedText = ref('');
const draft = (value) => JSON.stringify({ name: value.name, preset: value.preset, items: value.items });
const unsaved = computed(() => current.value !== null && draft(current.value) !== savedText.value);

let onScreen = true;
onUnmounted(() => (onScreen = false));

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
  savedText.value = draft(current.value);
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
    savedText.value = draft(current.value);
    note.value = 'Saved.';
    return saved;
  } catch (e) {
    error.value = e.message;
    return null;
  }
}

// The credits and chapters, ready to paste under the video where it is posted.
const copied = ref(false);
async function copyDescription() {
  try {
    await navigator.clipboard.writeText(current.value.description ?? '');
    copied.value = true;
    setTimeout(() => (copied.value = false), 2000);
  } catch {
    error.value = 'The browser did not allow copying. Select the text and copy it by hand.';
  }
}

async function generate() {
  note.value = '';
  lastResult.value = null;
  const saved = await save();
  if (!saved) return;
  note.value = '';
  try {
    const started = await api.generate(saved.id);
    lastResult.value = await track(started);
    // The result is on this page already, so the side column need not announce it.
    if (onScreen) jobs.dismissed.push(started.id);
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
      <button class="primary" @click="create"><Icon name="plus" /> New compilation</button>
      <p v-if="compilations.length === 0" class="empty">No compilations yet. Start one with “New compilation”.</p>
      <div v-for="saved in compilations" :key="saved.id" class="entry" :class="{ current: current?.id === saved.id }">
        <button class="open" @click="open(saved)">
          <strong>{{ saved.name }}</strong>
          <span class="muted">{{ saved.items.length }} {{ saved.items.length === 1 ? 'item' : 'items' }} · {{ saved.preset === 'portrait' ? '1080×1920' : '1920×1080' }}</span>
        </button>
        <div v-if="confirming !== saved.id" class="row tools">
          <span v-if="saved.final" class="chip good"><Icon name="check" /> generated</span>
          <span v-else class="chip">not generated yet</span>
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
        <p class="hint first">Videos already in the project are added as they are. Nothing is copied.</p>
        <div v-for="(text, folder) in LIBRARIES" :key="folder" class="row adder">
          <div>
            <label :for="`pick-${folder}`">{{ text }}</label>
            <select :id="`pick-${folder}`" v-model="pick[folder]">
              <option value="">{{ library[folder].length > 0 ? 'Choose…' : 'None yet' }}</option>
              <option v-for="name in library[folder]" :key="name" :value="name">{{ name }}</option>
            </select>
          </div>
          <button class="fixed" :disabled="!pick[folder]" @click="addVideo(folder, pick[folder])"><Icon name="plus" /> Add</button>
        </div>
        <div
          class="drop" :class="{ over: dropping }"
          @dragover.prevent="dropping = true" @dragleave="dropping = false" @drop.prevent="onDrop"
        >
          <label for="files"><Icon name="download" /> Or choose files from your computer, or drop them here</label>
          <input id="files" type="file" accept="video/*,.mkv" multiple @change="addFiles([...$event.target.files]); $event.target.value = ''" />
          <p class="hint">A file from elsewhere is copied into the project's <code>in</code> folder, so it uses that much more disk space.</p>
          <p v-if="uploading" class="uploading" role="status"><span class="spinner" aria-hidden="true" /> {{ uploading }}</p>
        </div>
      </section>

      <section class="panel">
        <h2>Add a card</h2>
        <p v-if="matches.length === 0" class="empty">No saved cards yet. Make some on the Cards page first.</p>
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
          <button class="fixed" :disabled="!pick.card" @click="addCard"><Icon name="plus" /> Add</button>
        </div>
      </section>

      <section class="panel">
        <div class="row middle">
          <h2 class="fixed">Timeline</h2>
          <span />
          <span class="fixed total numbers"><strong>{{ clock(total) }}</strong> · {{ current.items.length }} {{ current.items.length === 1 ? 'item' : 'items' }}</span>
        </div>
        <p v-if="current.items.length === 0" class="empty">Add videos and cards above. They play in the order shown here.</p>
        <ol class="timeline">
          <li
            v-for="(item, index) in current.items" :key="item.id" :class="[item.kind, { dragging: dragged === index }]"
            draggable="true" @dragstart="dragged = index" @dragend="dragged = -1" @dragover.prevent @drop.prevent="dropOn(index)"
          >
            <div class="row head">
              <span class="fixed grip" title="Drag to reorder" aria-hidden="true">⋮⋮</span>
              <span class="fixed number numbers">{{ index + 1 }}</span>
              <span class="chip" :class="{ mark: item.kind === 'card' }"><Icon :name="item.kind === 'card' ? 'card' : 'video'" /> {{ item.kind === 'card' ? 'Card' : 'Video' }}</span>
              <strong class="what">{{ title(item) }}</strong>
              <span class="fixed muted numbers">{{ clock(seconds(item)) }}</span>
              <span v-if="state(index)" class="chip" :class="state(index) === STATE_NAMES.working ? 'accent' : state(index) === STATE_NAMES.waiting ? '' : 'good'" role="status">{{ state(index) }}</span>
              <button class="fixed small icon-only" :disabled="index === 0" :aria-label="`Move item ${index + 1} up`" title="Move up" @click="move(index, index - 1)"><Icon name="up" /></button>
              <button class="fixed small icon-only" :disabled="index === current.items.length - 1" :aria-label="`Move item ${index + 1} down`" title="Move down" @click="move(index, index + 1)"><Icon name="down" /></button>
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
      </section>

      <section v-if="current.final" class="panel result">
        <h2>Final video</h2>
        <video :key="current.final.version" :src="api.finalUrl(current.id, current.final.version)" controls playsinline :class="current.preset" />
        <p class="download">
          <a class="button" :href="api.finalUrl(current.id, current.final.version)" :download="`${current.name}.mp4`"><Icon name="download" /> Download the video</a>
          <span class="muted">It is also at <code>data/compilations/{{ current.id }}/final.mp4</code></span>
        </p>
        <div class="row middle">
          <h3 class="fixed">description.txt</h3>
          <span />
          <button class="fixed small" @click="copyDescription"><Icon name="copy" /> {{ copied ? 'Copied' : 'Copy' }}</button>
        </div>
        <pre>{{ current.description }}</pre>
      </section>

      <!-- Always in view, so a change is never left unsaved by accident. -->
      <div class="savebar">
        <span v-if="job" class="say" role="status"><span class="spinner" aria-hidden="true" /> {{ job.step === 'joining' ? 'Joining the segments…' : 'Making the segments…' }}</span>
        <span v-else-if="unsaved" class="say"><span class="chip warn">Changes not saved</span></span>
        <span v-else role="status" class="say muted">{{ note || 'Everything is saved.' }}</span>
        <button :disabled="Boolean(job) || !unsaved" @click="save">Save</button>
        <button class="primary" :disabled="Boolean(job) || current.items.length === 0" @click="generate"><Icon name="film" /> Generate the video</button>
      </div>

    </div>
    <p v-else class="empty wide">Choose a compilation on the left, or start a new one.</p>
  </div>
</template>

<style scoped>
.builder { display: grid; grid-template-columns: 270px minmax(0, 1fr); gap: var(--gap); align-items: start; }
.list .primary { width: 100%; }
.empty.wide { align-self: start; margin: 0; padding: 28px; }
.first { margin: 0 0 10px; }
.adder { margin-bottom: 8px; }
.drop { border: 2px dashed var(--line-strong); border-radius: var(--radius); padding: 14px; margin-top: 14px; background: var(--bg); }
.drop.over { border-color: var(--accent); background: var(--accent-tint); }
.drop label { display: flex; align-items: center; gap: 6px; color: var(--text); margin-bottom: 8px; }
.uploading { display: flex; align-items: center; gap: 8px; margin: 8px 0 0; }
.panel h2.fixed { margin: 0; }
.total { color: var(--muted); }
.total strong { color: var(--text); }
.timeline { list-style: none; margin: 12px 0 0; padding: 0; }
.timeline li {
  border: 1px solid var(--line); border-radius: var(--radius); padding: 10px 12px; margin-bottom: 8px;
  background: var(--panel); box-shadow: inset 4px 0 0 var(--accent);
}
.timeline li.card { box-shadow: inset 4px 0 0 var(--good); }
.timeline li.dragging { opacity: 0.5; }
.head { align-items: center; gap: 8px; }
.grip { cursor: grab; color: var(--muted); letter-spacing: -2px; padding: 0 2px; }
.number { color: var(--muted); font-weight: 650; min-width: 1.4em; text-align: right; }
.what { word-break: break-all; font-weight: 600; }
.fields { margin-top: 10px; }
.narrow { flex: 0 1 150px; }
.result video { width: 100%; max-height: 60vh; background: black; border-radius: var(--radius); display: block; }
.result video.portrait { max-width: 300px; }
.download { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 12px 0 16px; }
a.button {
  display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 6px 14px; border-radius: var(--radius);
  background: var(--accent); color: var(--accent-text); font-weight: 650; text-decoration: none;
}
a.button:hover { background: var(--accent-hover); }
.result h3 { margin: 0; }
pre {
  margin: 8px 0 0; background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px;
  white-space: pre-wrap; font: 13px/1.5 ui-monospace, Menlo, Consolas, monospace;
}
.savebar {
  position: sticky; bottom: 0; z-index: 4; display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 12px 16px;
  background: var(--panel); border: 1px solid var(--line); border-bottom: 0;
  border-radius: var(--radius-large) var(--radius-large) 0 0; box-shadow: 0 -4px 14px var(--shadow);
}
.savebar .say { flex: 1 1 200px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
@media (max-width: 900px) { .builder { grid-template-columns: 1fr; } }
</style>
