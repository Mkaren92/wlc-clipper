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
// "Combined" holds the videos made on the Combine page, each named by its combination.
const LIBRARIES = { in: 'Videos', parts: 'Parts', clips: 'Clips', combined: 'Combined' };
const STATE_NAMES = { waiting: 'Waiting', working: 'Working…', done: 'Done', reused: 'Done (kept from last time)' };

const compilations = ref([]);
const current = ref(null); // the compilation being edited: a copy, saved with Save or Generate
const matches = ref([]);
const sounds = ref({ builtIn: [], files: [], automatic: {}, lengths: {} }); // what can play under a card
const sources = ref([]); // for filling in the credit of a fetched video
const prefixes = ref({}); // source id -> what its fetched files are named after
const pictures = ref({}); // source id -> a number that changes with the channel's picture
const library = reactive({ in: [], parts: [], clips: [], combined: [] });
const pick = reactive({ in: '', parts: '', clips: '', combined: '', match: '', card: '' });
const combinedNames = reactive({}); // a combination's id -> the name the owner gave it
/** What a video is called on the page: a combined video by its combination's name, anything else by its file name. */
const shownName = (folder, name) => (folder === 'combined' ? combinedNames[name] ?? name : name);
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
onUnmounted(() => {
  onScreen = false;
  stopHearing();
});

const copy = (value) => JSON.parse(JSON.stringify(value));
const newId = () => `i${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const key = (item) => `${item.library}/${item.name}`;

async function load() {
  try {
    const [saved, savedMatches, videos, parts, clips, sourceList, soundList] = await Promise.all([api.compilations(), api.matches(), api.videos(), api.parts(), api.clips(), api.sources(), api.sounds()]);
    sounds.value = soundList;
    sources.value = sourceList.sources;
    prefixes.value = sourceList.prefixes;
    pictures.value = sourceList.pictures ?? {};
    compilations.value = saved;
    matches.value = savedMatches;
    library.in = videos.map((v) => v.name);
    library.parts = parts.map((p) => p.name);
    library.clips = clips.filter((c) => c.rendered).map((c) => c.name);
    // Only the combinations whose video has been made. Each is kept by its id and shown by its name.
    const combined = (await api.combinations()).filter((one) => one.result);
    library.combined = combined.map((one) => one.id);
    for (const one of combined) combinedNames[one.id] = one.name;
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
  for (const item of current.value.items) {
    if (item.kind !== 'video') continue;
    learnLength(item);
    if (item.beside) learnLength(item.beside);
  }
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
// A credit is chosen from the channels on the Sources page. It is matched on the
// name whatever its capitals, as the engine matches it for the link and the picture.
const creditSource = (credit) => sources.value.find((source) => source.name.toLowerCase() === (credit ?? '').trim().toLowerCase()) ?? null;
const creditFor = (name) => sources.value.find((source) => name.startsWith(`${prefixes.value[source.id]}_`))?.name ?? '';

// --- A second video beside the first ---------------------------------------------

// Every video in the project, as "folder/name", for choosing the one shown beside another.
const everyVideo = computed(() => Object.keys(LIBRARIES).flatMap((folder) => library[folder].map((name) => `${folder}/${name}`)));
const besideKey = (item) => `${item.beside.library}/${item.beside.name}`;
function setBeside(item, value) {
  const at = value.indexOf('/');
  Object.assign(item.beside, { library: value.slice(0, at), name: value.slice(at + 1), start: null, end: null });
  learnLength(item.beside);
}
function toggleBeside(item, on) {
  if (!on) {
    item.beside = null;
    return;
  }
  // Start with another video than the one it is beside, if there is one.
  const first = everyVideo.value.find((value) => value !== key(item)) ?? everyVideo.value[0];
  // The streamer in front, the other video under it: what a reaction usually wants.
  item.beside = { library: 'in', name: '', start: null, end: null, sound: 'low' };
  setBeside(item, first);
}
/** How long the second video runs beside the first, for the note under it. */
function besideSeconds(item) {
  const whole = lengths[key(item.beside)];
  if (whole === undefined || whole === null) return null;
  return Math.max(0, Math.min((item.beside.end ?? whole) - (item.beside.start ?? 0), seconds(item)));
}

function addVideo(folder, name) {
  if (!name) return;
  const item = { id: newId(), kind: 'video', library: folder, name, start: null, end: null, credit: creditFor(name), beside: null };
  current.value.items.push(item);
  learnLength(item);
}

function addCard() {
  if (!pick.match || !pick.card) return;
  // No length of its own: the card is shown exactly as long as its sound.
  current.value.items.push({ id: newId(), kind: 'card', matchId: pick.match, cardId: pick.card, seconds: null, sound: 'auto' });
}

// --- Sounds under cards ---------------------------------------------------------

const cardOf = (item) => matches.value.find((m) => m.id === item.matchId)?.cards.find((c) => c.id === item.cardId);
/** The sound "Automatic" stands for on this card: your file named after its kind, or the built-in one. */
const autoSound = (item) => sounds.value.automatic[cardOf(item)?.type] ?? 'none';
/** The sound a card really plays, whatever its setting says. */
const soundOf = (item) => (item.sound === 'auto' ? autoSound(item) : item.sound);
function soundName(choice) {
  if (choice.startsWith('file:')) return `${choice.slice(5)} (your file)`;
  return sounds.value.builtIn.find((sound) => `builtin:${sound.id}` === choice)?.name ?? 'no sound';
}
const missingFile = (item) => item.sound.startsWith('file:') && !sounds.value.files.includes(item.sound.slice(5));

// One sound at a time can be listened to. Pressing the button again stops it.
let player = null;
const hearing = ref('');
function stopHearing() {
  player?.pause();
  player = null;
  hearing.value = '';
}
function hear(item) {
  const again = hearing.value === item.id;
  stopHearing();
  const url = again ? null : api.soundUrl(item.sound, autoSound(item));
  if (!url) return;
  player = new Audio(url);
  hearing.value = item.id;
  player.addEventListener('ended', stopHearing);
  player.addEventListener('error', () => {
    stopHearing();
    error.value = 'That sound could not be played. If it is one of your files, check that it is still in the sounds folder.';
  });
  player.play().catch(stopHearing);
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
  if (card.type === 'intro') return 'Intro';
  if (card.type === 'goal') return `Goal: ${minuteLabel(card.minute, card.added)} ${card.scorer}`.trim();
  if (card.type === 'red') return `Red card: ${minuteLabel(card.minute, card.added)} ${card.player}`.trim();
  return `Full time ${card.homeScore}–${card.awayScore}`;
}
function title(item) {
  if (item.kind === 'video') return shownName(item.library, item.name);
  const match = matches.value.find((m) => m.id === item.matchId);
  const card = match?.cards.find((c) => c.id === item.cardId);
  return card ? `${cardLabel(card)} (${match.home} v ${match.away})` : 'A card that was deleted';
}
function seconds(item) {
  // A card with no length of its own lasts as long as its sound, or 3 seconds when it has none.
  if (item.kind === 'card') return Number(item.seconds) || sounds.value.lengths[soundOf(item)] || 3;
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
              <option v-for="name in library[folder]" :key="name" :value="name">{{ shownName(folder, name) }}</option>
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
        <p class="hint first">
          A card plays a sound and is shown exactly as long as that sound: a voice saying “Goool” under a goal, a
          tragic chord under a red card and a soft whistle under full time. These are made by the tool (the voice is a
          computer's), so listen before you rely on them. To use your own, put audio files in the project's
          <code>sounds</code> folder and reload. A file named <code>intro</code>, <code>goal</code>, <code>red</code>
          or <code>fulltime</code> (for example <code>goal.mp3</code>) is used for every card of that kind without
          choosing anything. An intro card is silent unless there is such a file. A video file there works too
          (for example <code>intro.mp4</code>): its sound plays and its picture moves behind the card.
        </p>
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
                <label :for="`credit-${item.id}`">Credit: the streamer, shown in a corner</label>
                <div class="credit">
                  <img
                    v-if="creditSource(item.credit) && pictures[creditSource(item.credit).id]" class="face"
                    :src="api.sourcePictureUrl(creditSource(item.credit).id, pictures[creditSource(item.credit).id])" alt=""
                  />
                  <select :id="`credit-${item.id}`" :value="creditSource(item.credit)?.name ?? item.credit ?? ''" @change="item.credit = $event.target.value">
                    <option value="">No credit</option>
                    <option v-for="source in sources" :key="source.id" :value="source.name">{{ source.name }}</option>
                    <!-- A name typed before credits were chosen from the list is kept until another is chosen. -->
                    <option v-if="item.credit && !creditSource(item.credit)" :value="item.credit">{{ item.credit }} (not in Sources: name only)</option>
                  </select>
                </div>
              </div>
            </div>
            <div v-if="item.kind === 'video'" class="beside">
              <label class="check">
                <input type="checkbox" :checked="Boolean(item.beside)" :disabled="everyVideo.length === 0" @change="toggleBeside(item, $event.target.checked)" />
                Show another video beside it, such as the goal being reacted to
              </label>
              <template v-if="item.beside">
                <div class="row fields">
                  <div>
                    <label :for="`beside-${item.id}`">The video shown beside it</label>
                    <select :id="`beside-${item.id}`" :value="besideKey(item)" @change="setBeside(item, $event.target.value)">
                      <optgroup v-for="(text, folder) in LIBRARIES" :key="folder" :label="text">
                        <option v-for="name in library[folder]" :key="name" :value="`${folder}/${name}`">{{ shownName(folder, name) }}</option>
                      </optgroup>
                    </select>
                  </div>
                  <div class="narrow">
                    <label :for="`beside-start-${item.id}`">Its start (seconds)</label>
                    <input :id="`beside-start-${item.id}`" type="number" min="0" step="0.1" placeholder="beginning" :value="item.beside.start ?? ''" @input="blankIsNull(item.beside, 'start', $event.target.value)" />
                  </div>
                  <div class="narrow">
                    <label :for="`beside-end-${item.id}`">Its end (seconds)</label>
                    <input :id="`beside-end-${item.id}`" type="number" min="0" step="0.1" placeholder="end" :value="item.beside.end ?? ''" @input="blankIsNull(item.beside, 'end', $event.target.value)" />
                  </div>
                  <div>
                    <label :for="`beside-sound-${item.id}`">Its sound</label>
                    <select :id="`beside-sound-${item.id}`" v-model="item.beside.sound">
                      <option value="low">Quiet, under this video's sound (about 70–30)</option>
                      <option value="even">As loud as this video's sound (about 50–50)</option>
                      <option value="off">Off: only this video is heard</option>
                    </select>
                  </div>
                </div>
                <p class="hint">
                  <template v-if="besideSeconds(item) !== null">For the first {{ clock(besideSeconds(item)) }}, the</template>
                  <template v-else>While it runs, the</template>
                  screen is split in two, and each video fills its half with the middle of its picture: this video on
                  the left and the other on the right (bottom and top in a tall video). After that this video fills
                  the screen.
                </p>
              </template>
            </div>
            <div v-else class="row fields">
              <div class="narrow">
                <label :for="`seconds-${item.id}`">Shown for (seconds)</label>
                <input
                  :id="`seconds-${item.id}`" type="number" min="0.5" max="60" step="0.5" placeholder="as the sound" :value="item.seconds ?? ''"
                  title="Leave empty to show the card exactly as long as its sound plays"
                  @input="item.seconds = $event.target.value === '' ? null : Math.min(60, Math.max(0.5, Number($event.target.value)))"
                />
              </div>
              <div>
                <label :for="`sound-${item.id}`">Sound, or video, under the card</label>
                <div class="joined">
                  <select :id="`sound-${item.id}`" v-model="item.sound" @change="stopHearing">
                    <option value="auto">Automatic: {{ soundName(autoSound(item)) }}</option>
                    <option value="none">No sound</option>
                    <optgroup label="Made by the tool">
                      <option v-for="sound in sounds.builtIn" :key="sound.id" :value="`builtin:${sound.id}`">{{ sound.name }}</option>
                    </optgroup>
                    <optgroup v-if="sounds.files.length > 0 || missingFile(item)" label="Your files, from the sounds folder">
                      <option v-for="name in sounds.files" :key="name" :value="`file:${name}`">{{ name }}</option>
                      <option v-if="missingFile(item)" :value="item.sound">{{ item.sound.slice(5) }} (not in the folder any more)</option>
                    </optgroup>
                  </select>
                  <button :disabled="item.sound === 'none' || missingFile(item)" :aria-label="`${hearing === item.id ? 'Stop' : 'Listen to'} the sound of item ${index + 1}`" @click="hear(item)">
                    <Icon :name="hearing === item.id ? 'pause' : 'play'" /> {{ hearing === item.id ? 'Stop' : 'Listen' }}
                  </button>
                </div>
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
/* The credited channel's picture beside the box that chooses it. */
.credit { display: flex; align-items: center; gap: 8px; }
.credit .face { width: 36px; height: 36px; flex: none; border-radius: 50%; }
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
.beside { margin-top: 12px; padding-top: 10px; border-top: 1px dashed var(--line); }
.beside .check { padding-bottom: 0; }
.joined { display: flex; }
.joined select { border-radius: var(--radius) 0 0 var(--radius); min-width: 0; }
.joined button { flex: none; border-left: 0; border-radius: 0 var(--radius) var(--radius) 0; white-space: nowrap; }
.narrow { flex: 0 1 150px; }
/* The player is the video's own shape, so no black bars stand beside the picture. */
.result video { width: auto; height: auto; max-width: 100%; max-height: 60vh; aspect-ratio: 16 / 9; background: black; border-radius: var(--radius); display: block; }
.result video.portrait { max-width: 300px; aspect-ratio: 9 / 16; }
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
