<script setup>
// Two videos side by side, lined up by eye: a reaction and the thing reacted
// to. Both play together in the preview, so the start of each can be moved
// until they are in step, and the part of each that shows can be chosen.
//
// The preview is drawn with the same sums the engine uses (src/combine/layout.js):
// how long the result is, how long the screen is split, and which part of each
// video shows in its half. What is seen here is what "Make the combined video" makes.
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { COMBINE_SIZES, halves, MAIN_SHARES, MAX_ZOOM, rangeOf, shownPart, timing } from '../../../src/combine/layout.js';
import { api } from '../api.js';
import Icon from '../components/Icon.vue';
import TrashButton from '../components/TrashButton.vue';
import { describe, isActive, jobs, track } from '../jobs.js';

const LIBRARIES = { in: 'Videos', parts: 'Parts', clips: 'Clips' };
const SIDES = ['left', 'right'];
const PRESET_NAMES = { landscape: '1920×1080 (wide): left and right', portrait: '1080×1920 (tall): top and bottom' };
const SHARE_NAMES = { 50: 'Equal: 50–50', 60: 'Main video larger: 60–40', 70: 'Main video much larger: 70–30' };
const SOUND_NAMES = {
  low: 'Main video in front, the other quieter (about 70–30)',
  even: 'Both about the same (50–50)',
  off: 'Only the main video',
};
// How loud the other video plays in the preview. The made video is levelled properly; this only gives the idea.
const PREVIEW_VOLUME = { low: 0.35, even: 1, off: 0 };

const combinations = ref([]);
const current = ref(null); // the combination being edited: a copy, saved with Save or when making the video
const library = reactive({ in: [], parts: [], clips: [] });
const info = reactive({}); // "folder/name" -> { width, height, duration }, or null when the file cannot be read
const error = ref('');
const note = ref('');
const confirming = ref('');
const savedText = ref('');
const playError = reactive({ left: '', right: '' });

const key = (video) => `${video.library}/${video.name}`;
const copy = (value) => JSON.parse(JSON.stringify(value));
const draft = ({ result: _result, ...settings }) => JSON.stringify(settings);
const unsaved = computed(() => current.value !== null && draft(current.value) !== savedText.value);
const clock = (seconds) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;

async function load() {
  try {
    const [saved, videos, parts, clips] = await Promise.all([api.combinations(), api.videos(), api.parts(), api.clips()]);
    combinations.value = saved;
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
  if (combinations.value.length > 0) open(combinations.value[0]);
});

const openById = (id) => {
  const saved = combinations.value.find((one) => one.id === id);
  if (saved) open(saved);
};
const status = (saved) => (!saved.result ? 'not made yet' : saved.result.changedSince ? 'changed since it was made' : 'made');
const sideName = (side) => (boxes.value.wide ? (side === 'left' ? 'Left video' : 'Right video') : (side === 'left' ? 'Top video' : 'Bottom video'));

function open(saved) {
  pause();
  current.value = copy(saved);
  savedText.value = draft(current.value);
  note.value = '';
  confirming.value = '';
  time.value = 0;
  for (const side of SIDES) if (current.value[side]) learn(current.value[side]);
}

async function create() {
  try {
    const made = await api.createCombination({ name: 'New combination' });
    await load();
    open(made);
  } catch (e) {
    error.value = e.message;
  }
}

async function remove(id) {
  try {
    await api.deleteCombination(id);
    confirming.value = '';
    const wasOpen = current.value?.id === id;
    if (wasOpen) {
      pause();
      current.value = null;
    }
    await load();
    // The box at the top always shows one of the combinations, so another is opened in its place.
    if (wasOpen && combinations.value.length > 0) open(combinations.value[0]);
  } catch (e) {
    error.value = e.message;
  }
}

/** Find out a video's size and length, which the preview and the sliders need. */
async function learn(video) {
  if (info[key(video)] !== undefined) return;
  try {
    info[key(video)] = await api.videoInfo(video.library, video.name);
  } catch {
    info[key(video)] = null; // the file is gone; making the video will say so
  }
}

// --- The two videos -----------------------------------------------------------

function choose(side, value) {
  pause();
  playError[side] = '';
  if (!value) {
    current.value[side] = null;
    return;
  }
  const [folder, ...rest] = value.split('/');
  current.value[side] = { library: folder, name: rest.join('/'), start: null, end: null, zoom: 1, x: 0.5, y: 0.5 };
  learn(current.value[side]);
}
const urlOf = (video) => (video.library === 'in' ? api.videoUrl(video.name) : video.library === 'parts' ? api.partUrl(video.name) : api.clipUrl(video.name, 0));
const infoOf = (side) => (current.value[side] ? info[key(current.value[side])] ?? null : null);

/** The other way round: what was on the left goes right, and the same video stays the main one. */
function swap() {
  pause();
  const now = current.value;
  [now.left, now.right] = [now.right, now.left];
  now.main = now.main === 'left' ? 'right' : 'left';
  [playError.left, playError.right] = [playError.right, playError.left];
}

function move(side, field, by) {
  const video = current.value[side];
  const whole = infoOf(side)?.duration ?? 0;
  const from = video[field] ?? (field === 'start' ? 0 : whole);
  video[field] = Math.round(Math.min(Math.max(from + by, 0), whole) * 10) / 10;
}
// An empty box means "from the start" or "to the end".
const blankIsNull = (video, field, value) => (video[field] = value === '' || value === null ? null : Math.max(0, Number(value)));

// --- What the engine will make, worked out with the engine's own sums ------------

const size = computed(() => COMBINE_SIZES[current.value.preset]);
const boxes = computed(() => halves(size.value, current.value.main, current.value.mainShare));
const otherSide = computed(() => (current.value.main === 'left' ? 'right' : 'left'));
const range = (side) => rangeOf(current.value[side], infoOf(side).duration);
/** Lengths of the result and of its split part, or null until both videos are chosen and read. */
const plan = computed(() => {
  if (!current.value || !infoOf('left') || !infoOf('right')) return null;
  return timing(range(current.value.main).seconds, range(otherSide.value).seconds);
});
const part = (side) => (infoOf(side) ? shownPart(infoOf(side), boxes.value[side], current.value[side]) : null);
/** Whether there is anything to move along an axis: nothing sticks out along it when the video just fits. */
const sticksOut = (side, axis) => {
  const shown = part(side);
  return shown !== null && (axis === 'x' ? shown.width > boxes.value[side].width : shown.height > boxes.value[side].height);
};

// --- The preview: both videos, kept in step by this page -------------------------------

const time = ref(0); // seconds into the result
const playing = ref(false);
const players = { left: null, right: null };
let frame = 0;
const split = computed(() => plan.value !== null && time.value < plan.value.split);
const percent = (value, of) => `${(value / of) * 100}%`;

/** Where a side's box is on the stage: its half while the screen is split, all of it for the main video after. */
function boxStyle(side) {
  if (!split.value && plan.value) return side === current.value.main ? { left: '0', top: '0', width: '100%', height: '100%' } : { display: 'none' };
  const box = boxes.value[side];
  return { left: percent(box.x, size.value.width), top: percent(box.y, size.value.height), width: percent(box.width, size.value.width), height: percent(box.height, size.value.height) };
}
/** Where the video is inside its box: enlarged and shifted while split, fitted whole after. */
function videoStyle(side) {
  const shown = part(side);
  if (!shown || (!split.value && plan.value)) return { left: '0', top: '0', width: '100%', height: '100%', objectFit: 'contain' };
  const box = boxes.value[side];
  return { left: percent(-shown.x, box.width), top: percent(-shown.y, box.height), width: percent(shown.width, box.width), height: percent(shown.height, box.height), objectFit: 'fill' };
}

/** Put both videos where they belong at the current time. */
function place() {
  if (!plan.value) return;
  for (const side of SIDES) {
    const player = players[side];
    if (!player || !infoOf(side)) continue;
    // After the split the other video stays on its last frame, out of sight.
    const at = side === current.value.main ? time.value : Math.min(time.value, plan.value.split);
    player.currentTime = range(side).start + at;
  }
}

function tick() {
  if (!playing.value || !plan.value) return;
  const main = players[current.value.main];
  const other = players[otherSide.value];
  time.value = Math.min(Math.max(main.currentTime - range(current.value.main).start, 0), plan.value.seconds);
  if (time.value >= plan.value.seconds - 0.02 || main.ended) {
    pause();
    time.value = plan.value.seconds;
    return;
  }
  if (time.value < plan.value.split) {
    // The main video is the clock; the other is pulled back when it drifts.
    const wanted = range(otherSide.value).start + time.value;
    if (Math.abs(other.currentTime - wanted) > 0.15) other.currentTime = wanted;
    if (other.paused) other.play().catch(() => {});
  } else if (!other.paused) other.pause();
  frame = requestAnimationFrame(tick);
}

async function play() {
  if (!plan.value || !players.left || !players.right) return;
  if (time.value >= plan.value.seconds - 0.05) time.value = 0;
  place();
  setVolumes();
  playing.value = true;
  try {
    await players[current.value.main].play();
    frame = requestAnimationFrame(tick);
  } catch {
    playing.value = false;
  }
}
function pause() {
  playing.value = false;
  cancelAnimationFrame(frame);
  for (const side of SIDES) players[side]?.pause();
}
function seek(value) {
  pause();
  time.value = Math.min(Math.max(Number(value) || 0, 0), plan.value?.seconds ?? 0);
  place();
}
function setVolumes() {
  if (!current.value) return;
  for (const side of SIDES) {
    if (!players[side]) continue;
    const volume = side === current.value.main ? 1 : PREVIEW_VOLUME[current.value.sound];
    players[side].volume = volume;
    players[side].muted = volume === 0;
  }
}
const setPlayer = (side, element) => (players[side] = element);
const cannotPlay = (side) => (playError[side] = 'The browser cannot play this file, so it cannot be previewed. The video can still be made.');

// A change to which videos, their starts or ends, or which is main, starts the preview over from the first frame.
watch(() => current.value && [current.value.left?.name, current.value.left?.start, current.value.left?.end, current.value.right?.name, current.value.right?.start, current.value.right?.end, current.value.main, current.value.preset, plan.value?.seconds], () => {
  if (current.value) seek(0);
}, { flush: 'post' });
watch(() => current.value?.sound, setVolumes);
// Leaving the page stops both videos.
onUnmounted(pause);

// --- Saving and making the video ---------------------------------------------------

const job = computed(() => jobs.list.find((j) => j.kind === 'combine' && isActive(j) && j.label === current.value?.name));

async function save() {
  error.value = '';
  try {
    const saved = await api.saveCombination(current.value);
    await load();
    // Only what the server holds is taken back, so the preview does not start over.
    current.value.result = saved.result;
    current.value.name = saved.name;
    savedText.value = draft(current.value);
    note.value = 'Saved.';
    return saved;
  } catch (e) {
    error.value = e.message;
    return null;
  }
}

async function generate() {
  pause();
  const saved = await save();
  if (!saved) return;
  note.value = '';
  try {
    const started = await api.generateCombination(saved.id);
    await track(started);
    // The result is on this page already, so the side column need not announce it.
    jobs.dismissed.push(started.id);
    await load();
    const fresh = combinations.value.find((one) => one.id === saved.id);
    if (fresh && current.value?.id === saved.id) current.value.result = fresh.result;
    note.value = 'The combined video is ready. It is now in Compilations, under “Add videos”, in the “Combined” list.';
  } catch (e) {
    error.value = e.message;
  }
}
</script>

<template>
  <div class="combiner stack">
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <!-- One row: which combination is open, its name and its size. -->
    <section class="panel">
      <div class="row">
        <div class="which">
          <label for="combination-open">Combination</label>
          <select id="combination-open" :value="current?.id ?? ''" :disabled="combinations.length === 0" @change="openById($event.target.value)">
            <option v-if="combinations.length === 0" value="">None yet</option>
            <option v-for="saved in combinations" :key="saved.id" :value="saved.id">{{ saved.name }} ({{ status(saved) }})</option>
          </select>
        </div>
        <button class="fixed primary" @click="create"><Icon name="plus" /> New combination</button>
        <TrashButton v-if="current" class="fixed" :label="`Delete the combination ${current.name}`" @click="confirming = current.id" />
        <template v-if="current">
          <div><label for="combination-name">Name</label><input id="combination-name" v-model="current.name" type="text" maxlength="80" /></div>
          <div>
            <label for="combination-preset">Size</label>
            <select id="combination-preset" v-model="current.preset">
              <option v-for="(text, id) in PRESET_NAMES" :key="id" :value="id">{{ text }}</option>
            </select>
          </div>
        </template>
      </div>
      <div v-if="current && confirming === current.id" class="confirm" role="alertdialog">
        <span>Delete this combination and its combined video? This cannot be undone. A compilation that uses the video will no longer find it.</span>
        <button class="small danger" @click="remove(current.id)">Delete</button>
        <button class="small" @click="confirming = ''">Cancel</button>
      </div>
    </section>

    <template v-if="current">
      <!-- The preview on the left stays where it is; the settings are beside it. -->
      <div class="work">
        <div class="watch stack">
          <section class="panel">
            <div class="row middle head">
              <h2 class="fixed">Preview</h2>
              <span v-if="plan" class="muted numbers">{{ clock(plan.seconds) }} long · split for the first {{ clock(plan.split) }}</span>
              <span v-else class="muted">Choose both videos to see them together.</span>
            </div>
            <!-- The stage has the shape of the finished video. Its colours are fixed, like a player's. -->
            <div class="stage" :class="current.preset" :style="{ aspectRatio: `${size.width} / ${size.height}` }">
              <div v-for="side in SIDES" :key="side" class="half" :style="boxStyle(side)">
                <video
                  v-if="current[side]" :key="key(current[side])" :ref="(element) => setPlayer(side, element)" :src="urlOf(current[side])"
                  :style="videoStyle(side)" preload="auto" playsinline @loadedmetadata="place(); setVolumes()" @error="cannotPlay(side)"
                />
                <span v-else class="hole">{{ sideName(side) }}</span>
              </div>
            </div>
            <div class="row middle transport">
              <button class="fixed primary" :disabled="!plan" @click="playing ? pause() : play()">
                <Icon :name="playing ? 'pause' : 'play'" /> {{ playing ? 'Pause' : 'Play both' }}
              </button>
              <button class="fixed" :disabled="!plan" @click="seek(0)">From the start</button>
              <div class="scrub">
                <label for="combination-time" class="sr">Position in the combined video</label>
                <input id="combination-time" type="range" min="0" :max="plan?.seconds ?? 0" step="0.01" :value="time" :disabled="!plan" @input="seek($event.target.value)" />
              </div>
              <span class="fixed numbers muted">{{ clock(time) }} / {{ clock(plan?.seconds ?? 0) }}</span>
            </div>
          </section>

          <section class="panel">
            <div class="row">
              <div>
                <label for="combination-share">Screen while it is split</label>
                <select id="combination-share" v-model.number="current.mainShare">
                  <option v-for="share in MAIN_SHARES" :key="share" :value="share">{{ SHARE_NAMES[share] }}</option>
                </select>
              </div>
              <div>
                <label for="combination-sound">Sound</label>
                <select id="combination-sound" v-model="current.sound">
                  <option v-for="(text, id) in SOUND_NAMES" :key="id" :value="id">{{ text }}</option>
                </select>
              </div>
              <button class="fixed" :disabled="!current.left && !current.right" @click="swap">Swap sides</button>
            </div>
            <p class="hint">
              Move a video's start until the two are in step. The main video sets the length and has the whole screen
              once the other ends. The sound balance in this preview is only rough.
            </p>
          </section>
        </div>

        <div class="sides stack">
          <section v-for="side in SIDES" :key="side" class="panel" :class="{ main: current.main === side }">
            <div class="row middle head">
              <h2 class="fixed">{{ sideName(side) }}</h2>
              <span v-if="current.main === side" class="chip accent fixed">Main</span>
              <span />
              <label v-if="current[side] && infoOf(side)" class="check fixed" title="The main video sets the length, and goes full screen when the other ends">
                <input v-model="current.main" type="radio" name="main" :value="side" /> Main video
              </label>
            </div>
            <label :for="`pick-${side}`" class="sr">Video</label>
            <select :id="`pick-${side}`" :value="current[side] ? key(current[side]) : ''" @change="choose(side, $event.target.value)">
              <option value="">Choose a video…</option>
              <optgroup v-for="(text, folder) in LIBRARIES" :key="folder" :label="text">
                <option v-for="name in library[folder]" :key="name" :value="`${folder}/${name}`">{{ name }}</option>
              </optgroup>
            </select>
            <p v-if="playError[side]" class="notice">{{ playError[side] }}</p>
            <p v-else-if="current[side] && infoOf(side) === null && info[key(current[side])] === null" class="notice">This video is not in the project any more. Choose another.</p>

            <template v-if="current[side] && infoOf(side)">
              <label :for="`start-${side}`">Starts at: {{ clock(current[side].start ?? 0) }} of {{ clock(infoOf(side).duration) }}</label>
              <input :id="`start-${side}`" type="range" min="0" :max="infoOf(side).duration" step="0.1" :value="current[side].start ?? 0" @input="current[side].start = Number($event.target.value)" />
              <div class="row nudge">
                <button class="small fixed" @click="move(side, 'start', -1)">−1 s</button>
                <button class="small fixed" @click="move(side, 'start', -0.1)">−0.1 s</button>
                <button class="small fixed" @click="move(side, 'start', 0.1)">+0.1 s</button>
                <button class="small fixed" @click="move(side, 'start', 1)">+1 s</button>
                <span />
                <label :for="`end-${side}`" class="fixed inline">Ends at</label>
                <input :id="`end-${side}`" class="fixed end" type="number" min="0" step="0.1" placeholder="the end" title="In seconds. Empty means the end of the video." :value="current[side].end ?? ''" @change="blankIsNull(current[side], 'end', $event.target.value)" />
              </div>

              <div class="row middle part-head">
                <h3 class="fixed">The part shown while split</h3>
                <span />
                <button class="small fixed" @click="Object.assign(current[side], { zoom: 1, x: 0.5, y: 0.5 })">Back to the middle</button>
              </div>
              <div class="row part">
                <div>
                  <label :for="`zoom-${side}`">Zoom: {{ current[side].zoom.toFixed(2) }}×</label>
                  <input :id="`zoom-${side}`" v-model.number="current[side].zoom" type="range" min="1" :max="MAX_ZOOM" step="0.05" />
                </div>
                <div>
                  <label :for="`x-${side}`">Left ↔ right</label>
                  <input :id="`x-${side}`" v-model.number="current[side].x" type="range" min="0" max="1" step="0.01" :disabled="!sticksOut(side, 'x')" />
                </div>
                <div>
                  <label :for="`y-${side}`">Up ↔ down</label>
                  <input :id="`y-${side}`" v-model.number="current[side].y" type="range" min="0" max="1" step="0.01" :disabled="!sticksOut(side, 'y')" />
                </div>
              </div>
            </template>
          </section>
        </div>
      </div>

      <section v-if="current.result" class="panel result">
        <div class="row middle head">
          <h2 class="fixed">The combined video</h2>
          <span v-if="current.result.changedSince || unsaved" class="chip warn fixed">Settings changed since it was made</span>
        </div>
        <video :key="current.result.version" :src="api.combinedUrl(current.id, current.result.version)" controls preload="metadata" :class="current.preset" />
        <p class="hint">To use it, go to Compilations and add it from the “Combined” list under “Add videos”.</p>
      </section>

      <div class="savebar">
        <div class="say">
          <span v-if="job" class="running" role="status"><span class="spinner" aria-hidden="true" /> {{ describe(job) }}</span>
          <span v-else-if="unsaved" class="chip warn">Changes not saved</span>
          <span v-else role="status" class="muted">{{ note || 'Everything is saved.' }}</span>
        </div>
        <button :disabled="Boolean(job) || !unsaved" @click="save">Save</button>
        <button class="primary" :disabled="Boolean(job) || !plan" @click="generate"><Icon name="film" /> Make the combined video</button>
      </div>
    </template>
    <p v-else class="empty wide">
      Put a reaction and the thing reacted to side by side, line them up by eye, and make one video of the two.
      Start with “New combination”.
    </p>
  </div>
</template>

<style scoped>
.which { flex: 1.4 1 200px; }
.empty.wide { margin-top: var(--gap); padding: 28px; }
.head { gap: 8px; margin-bottom: 10px; }
.head h2 { margin: 0; }
/* The preview and the settings side by side. The preview column stays put while the settings scroll, if they need to. */
.work { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(380px, 1fr); gap: var(--gap); align-items: start; }
.watch { position: sticky; top: 8px; }
/* The stage is a player: black behind the videos, whatever the palette. It is as large as fits the window's height. */
.stage { position: relative; width: 100%; max-width: calc((100vh - 400px) * 16 / 9); min-width: 240px; margin: 0 auto; background: black; border-radius: var(--radius); overflow: hidden; }
.stage.portrait { max-width: calc((100vh - 400px) * 9 / 16); min-width: 150px; }
.half { position: absolute; overflow: hidden; display: grid; place-items: center; }
.half video { position: absolute; max-width: none; }
.hole { color: white; opacity: 0.6; font-size: 13px; } /* on the stage's black, like the rest of it */
.transport { margin-top: 12px; gap: 8px; flex-wrap: nowrap; }
/* An empty span in a row only pushes what follows to the right; it must not force a new line. */
.row > span:empty { flex: 1 1 0; }
.scrub { flex: 1 1 140px; }
.sides .panel { padding: 14px 16px; }
.sides .panel.main { border-color: var(--accent); box-shadow: inset 0 3px 0 var(--accent); }
.sides label { margin-top: 8px; }
.sides .head label, .sides label.inline { margin: 0; }
.nudge { margin-top: 6px; align-items: center; gap: 6px; flex-wrap: nowrap; }
.nudge button { padding: 2px 7px; }
.nudge .end { width: 92px; min-height: 28px; padding: 2px 8px; }
.part-head { margin-top: 12px; flex-wrap: nowrap; }
.part-head h3 { margin: 0; }
.part { gap: 12px; }
.notice { margin: 10px 0 0; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.result video { width: 100%; max-height: 60vh; background: black; border-radius: var(--radius); display: block; }
.result video.portrait { max-width: 300px; }
.running { display: flex; align-items: center; gap: 8px; }
.savebar {
  position: sticky; bottom: 0; z-index: 4; display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 12px 16px;
  background: var(--panel); border: 1px solid var(--line); border-bottom: 0;
  border-radius: var(--radius-large) var(--radius-large) 0 0; box-shadow: 0 -4px 14px var(--shadow);
}
.savebar .say { flex: 1 1 200px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
/* A narrow window: the preview on top, still in view, and the settings under it. */
@media (max-width: 1150px) {
  .work { grid-template-columns: 1fr; }
  .watch { z-index: 3; }
  .stage { max-width: calc(34vh * 16 / 9); }
  .stage.portrait { max-width: calc(40vh * 9 / 16); }
}
</style>
