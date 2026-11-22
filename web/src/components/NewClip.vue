<script setup>
// Cut a new clip from one source video: choose the range, the layout and the
// text, then start the job and wait for it.
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { api } from '../api.js';
import { clock } from '../format.js';
import { describe, isActive, jobs, track } from '../jobs.js';
import FramePicker from './FramePicker.vue';
import Icon from './Icon.vue';
import MomentFinder from './MomentFinder.vue';
import { BOTTOM_AREA_TOP, CAM_MAX_HEIGHT, CAM_MIN_HEIGHT, CAPTION_AREA, BLUR_MIN_SIZE, camPanelHeight, facecamGameWindow, MAX_BLURS, fitGameToPanel, gameFit, OUT_HEIGHT, OUT_WIDTH, OVERLAY_DEFAULTS, OVERLAY_POSITIONS, overlayBox, overlayWarnings } from '../../../src/layout.js';

const props = defineProps({
  video: { type: String, required: true },
  briefs: { type: Array, required: true },
});
const emit = defineEmits(['done']);

const HOOK_LIMIT = 60;
const LAYOUTS = [
  { id: 'center', name: 'Center', about: 'Crop a column. Fills the screen.' },
  { id: 'blur', name: 'Blur', about: 'The whole frame, over a blurred copy.' },
  { id: 'facecam', name: 'Facecam', about: 'The webcam above the gameplay.' },
];

const info = ref(null);
const loadError = ref('');
const picker = ref(null);
const playable = ref(true);
const playing = ref(false);
const time = ref(0);
const duration = ref(0);

// The options of the cut. Times are text so "1:30" and "90" both work.
const start = ref('0');
const end = ref('');
const layout = ref('center');
const cropX = ref(undefined);
// Width of the center crop in source pixels; undefined is the 9:16 column.
const cropWidth = ref(undefined);
const cam = ref(undefined);
// The webcam box's shape: free, or kept at one of these while resizing.
const CAM_SHAPES = [{ name: 'Free', aspect: null }, { name: '16:9', aspect: 16 / 9 }, { name: '4:3', aspect: 4 / 3 }, { name: '1:1', aspect: 1 }];
const camShape = ref(null);
// The content box under the webcam: its own box, resized apart from the webcam's.
const game = ref(undefined);
const gameShown = computed(() => (cam.value && game.value ? gameFit(game.value, camPanelHeight(cam.value)) : null));
// --- Blur boxes: part of the picture hidden for some seconds (checked by checkBlurs in src/layout.js) ---
// Kept in the video's own seconds, so a box stays on the same footage when the clip's start moves.
const blurs = ref([]);
function addBlur() {
  const side = Math.max(BLUR_MIN_SIZE, Math.round(Math.min(info.value.width, info.value.height) * 0.15));
  const from = Number(here());
  blurs.value = [...blurs.value, {
    x: Math.round((info.value.width - side) / 2), y: Math.round((info.value.height - side) / 2), width: side, height: side,
    from, to: Number(Math.min(from + 2, duration.value || from + 2).toFixed(2)), style: 'blur',
  }];
}
const removeBlur = (i) => (blurs.value = blurs.value.filter((_, n) => n !== i));
function changeBlur(i, change) {
  const copy = [...blurs.value];
  copy[i] = { ...copy[i], ...change };
  blurs.value = copy;
}
const inClip = (box) => startSeconds.value !== null && endSeconds.value !== null && box.to > startSeconds.value && box.from < endSeconds.value;
function blurProblem(box) {
  if (!(box.to > box.from)) return 'It ends before it starts.';
  if (startSeconds.value !== null && endSeconds.value !== null && !inClip(box)) return "It is outside the clip's range, so it is left out.";
  return '';
}
// What the engine takes: seconds from the clip's start, cut to the clip.
const blursToSend = () => blurs.value.filter(inClip).map((box) => ({
  x: box.x, y: box.y, width: box.width, height: box.height, style: box.style,
  start: Math.round(Math.max(0, box.from - startSeconds.value) * 100) / 100,
  end: Math.round((Math.min(box.to, endSeconds.value) - startSeconds.value) * 100) / 100,
}));
function fitGame() {
  game.value = fitGameToPanel(game.value, camPanelHeight(cam.value));
}
function chooseCamShape(aspect) {
  camShape.value = aspect;
  if (!aspect || !cam.value || !info.value) return;
  // Keep the box's width and place, and make it the chosen shape, inside the video.
  const height = Math.min(Math.round(cam.value.width / aspect), info.value.height - cam.value.y);
  cam.value = { ...cam.value, width: Math.round(height * aspect), height };
}
// The top panel of the clip, as tall as the box's shape makes it (the engine's sums).
const camPanel = computed(() => {
  if (!cam.value) return null;
  const height = camPanelHeight(cam.value);
  const fitting = (1080 * cam.value.height) / cam.value.width;
  return { height, game: OUT_HEIGHT - height, cropped: fitting < CAM_MIN_HEIGHT - 2 ? 'sides' : fitting > CAM_MAX_HEIGHT + 2 ? 'top and bottom' : null };
});
const trim = ref(0);
const hook = ref('');
const hookSeconds = ref(2.5); // 0 keeps the hook for the whole clip
const captions = ref(true);
const lang = ref('en');
const brief = ref('');
const title = ref('');
const description = ref('');

// Work in progress is kept in jobs.js, not here, so leaving this screen and
// coming back shows it again.
let onScreen = true;
const cutError = ref('');
const cutsOfThisVideo = computed(() =>
  jobs.list.filter((job) => ['cut', 'part'].includes(job.kind) && isActive(job) && job.label.startsWith(`${props.video} `)),
);

// Only the range matters for a part: it is saved at the original size with
// nothing added. The layout, hook, captions and brief above are ignored.
const rangeProblem = computed(() => {
  if (length.value === null) return 'Enter the start and end as seconds or m:ss.';
  if (length.value <= 0) return 'The end must be after the start.';
  if (info.value && endSeconds.value > info.value.duration + 0.05) return 'The end is past the end of the video.';
  return '';
});
async function savePart() {
  cutError.value = '';
  try {
    await track(await api.savePart({ video: props.video, start: start.value, end: end.value }));
  } catch (error) {
    cutError.value = error.message;
  }
}

// --- AI suggestions ---------------------------------------------------------

// --- Overlay: a logo or full-frame picture for the whole clip, from the overlays folder ---
const overlays = ref([]);
api.overlays().then((list) => (overlays.value = list.filter((one) => !one.error)), () => {});
const overlayName = ref('');
const overlaySettings = ref({ ...OVERLAY_DEFAULTS });
const POSITION_NAMES = { 'top-left': 'Top left', 'top-right': 'Top right', 'bottom-left': 'Bottom left', 'bottom-right': 'Bottom right' };
// The brief wins: a brief with an overlay uses its own, whatever is chosen here.
const briefOverlay = computed(() => {
  const entry = props.briefs.find((b) => b.file === brief.value && b.ok);
  return entry?.brief?.overlay ? { ...entry.brief.overlay, name: entry.brief.overlay.image.split(/[\\/]/).pop(), size: entry.overlaySize } : null;
});
// What will be drawn, in the clip's own pixels: the engine's sums (src/layout.js).
const overlayShown = computed(() => {
  if (briefOverlay.value) {
    if (!briefOverlay.value.size) return null;
    return { ...briefOverlay.value, imageWidth: briefOverlay.value.size.width, imageHeight: briefOverlay.value.size.height };
  }
  const image = overlays.value.find((one) => one.name === overlayName.value);
  return image ? { ...overlaySettings.value, imageWidth: image.width, imageHeight: image.height, kind: image.kind } : null;
});
const overlayPlace = computed(() => (overlayShown.value ? overlayBox(overlayShown.value) : null));
const overlayProblems = computed(() => (overlayShown.value ? overlayWarnings(overlayShown.value) : []));
const sketch = (top, height) => ({ top: `${(top / OUT_HEIGHT) * 100}%`, height: `${(height / OUT_HEIGHT) * 100}%` });

// --- Hooks from the AI: proposals for the clip being set up, clicked into the hook box ---
const hookIdeas = ref([]);
const hookError = ref('');
const hookJob = computed(() => jobs.list.find((job) => job.kind === 'hook' && isActive(job) && job.label === props.video));
async function suggestHook() {
  hookError.value = '';
  hookIdeas.value = [];
  try {
    const started = await api.suggestHook({ video: props.video, start: start.value, end: end.value, brief: brief.value, lang: lang.value });
    // The answer is shown here, beside the box; the side column need not announce it as well.
    jobs.dismissed.push(started.id);
    hookIdeas.value = (await track(started)).hooks;
    if (hookIdeas.value.length === 0) hookError.value = 'No usable hook came back. Try again.';
  } catch (error) {
    hookError.value = error.message;
  }
}

// The list itself is in MomentFinder.vue (transcript, chat or both). The marks above the
// timeline follow what that list shows.
const ai = ref(null); // { configured, service, model }
const moments = computed(() => jobs.momentMarks[props.video] ?? []);
api.ai().then((answer) => (ai.value = answer), () => {});
// The longest clip the chosen brief allows, which caps a moment merged from two sources.
const maxSeconds = computed(() => {
  const chosen = props.briefs.find((one) => one.file === brief.value && one.ok)?.brief;
  return Math.max(1, (chosen?.maxSeconds ?? 60) - (chosen?.endCard?.seconds ?? 0));
});

// Which suggestion the form was filled from, so it can be shown as the one
// being worked on. It stays marked while the range is fine-tuned by hand.
const keyOf = (moment) => `${moment.start}-${moment.end}`;
const usedKey = ref('');
const usedNumber = computed(() => moments.value.findIndex((moment) => keyOf(moment) === usedKey.value) + 1);

// Fill the form from a suggestion. Nothing is cut until "Cut the clip" is pressed.
function useMoment(moment) {
  usedKey.value = moment.key ?? keyOf(moment);
  start.value = String(moment.start);
  end.value = String(moment.end);
  hook.value = moment.hook ?? '';
  title.value = moment.title;
  description.value = moment.description;
  seek(moment.start);
}

// The windows are asked for again on every change of the trim or the crop
// width. Only the latest answer is used, so a slow one cannot undo a newer one.
let asked = 0;
async function loadInfo() {
  const mine = ++asked;
  try {
    const answer = await api.video(props.video, trim.value || 0, cropWidth.value);
    if (mine !== asked) return;
    info.value = answer;
    loadError.value = '';
    duration.value ||= info.value.duration;
    if (!end.value) end.value = String(Math.min(30, Math.floor(info.value.duration)));
    // A crop chosen before the trim changed may now lie outside the frame.
    const { minX, maxX } = info.value.layouts.center;
    if (cropX.value !== undefined && minX !== null) cropX.value = Math.min(Math.max(cropX.value, minX), maxX);
    // The same for a width chosen before the trim changed.
    const widths = info.value.layouts.centerWidths;
    if (cropWidth.value !== undefined && (!widths || cropWidth.value <= widths.min)) cropWidth.value = undefined;
    else if (cropWidth.value !== undefined && cropWidth.value > widths.max) cropWidth.value = widths.max;
  } catch (error) {
    if (mine === asked) loadError.value = error.message;
  }
}
watch([trim, cropWidth], loadInfo, { immediate: true });

// The slider's lowest position is the 9:16 column, which is "no width chosen".
const widthSlider = computed({
  get: () => cropWidth.value ?? info.value?.layouts.centerWidths?.min,
  set: (value) => (cropWidth.value = value <= info.value.layouts.centerWidths.min ? undefined : value),
});

// Give the webcam box a starting place the first time facecam is chosen.
watch(layout, (name) => {
  if (name !== 'facecam' || cam.value || !info.value) return;
  const width = Math.round(info.value.width * 0.3);
  const height = Math.round(width / (16 / 9));
  cam.value = { x: Math.round((info.value.width - width) / 2), y: Math.round(info.value.height * 0.1), width, height };
  // The content box starts as the middle of the gameplay under that webcam; from then on it is the owner's.
  const start = facecamGameWindow(info.value.layouts.area, camPanelHeight(cam.value));
  game.value = { x: start.x, y: start.y, width: start.width, height: start.height };
});

/** Read "90", "1:30" or "1:02:03.5" as seconds; null when it is not a time. */
function seconds(text) {
  const parts = String(text).trim().split(':');
  if (parts.length > 3 || parts.some((part) => part === '' || Number.isNaN(Number(part)))) return null;
  return parts.reduce((total, part) => total * 60 + Number(part), 0);
}

const startSeconds = computed(() => seconds(start.value));
const endSeconds = computed(() => seconds(end.value));
const length = computed(() =>
  startSeconds.value === null || endSeconds.value === null ? null : endSeconds.value - startSeconds.value,
);
const chosenBrief = computed(() => props.briefs.find((b) => b.file === brief.value)?.brief ?? null);
const total = computed(() => (length.value === null ? null : length.value + (chosenBrief.value?.endCard?.seconds ?? 0)));

const problem = computed(() => {
  if (length.value === null) return 'Enter the start and end as seconds or m:ss.';
  if (length.value <= 0) return 'The end must be after the start.';
  if (info.value && endSeconds.value > info.value.duration + 0.05) return 'The end is past the end of the video.';
  if (hook.value.length > HOOK_LIMIT) return `The hook is longer than ${HOOK_LIMIT} characters.`;
  if (typeof hookSeconds.value !== 'number' || hookSeconds.value < 0) return 'The hook time must be 0 or more seconds.';
  if (chosenBrief.value && !title.value.trim() && !hook.value.trim()) return 'With a brief, enter a title or a hook.';
  return '';
});

// One line saying what "Cut the clip" will make, beside the button.
const summary = computed(() => {
  if (length.value === null || length.value <= 0) return null;
  return {
    range: `${clock(startSeconds.value)}–${clock(endSeconds.value)} · ${total.value.toFixed(1)} s`,
    rest: [
      LAYOUTS.find((known) => known.id === layout.value).name,
      captions.value ? 'captions' : 'no captions',
      hook.value.trim() ? 'hook' : 'no hook',
      chosenBrief.value ? `brief “${chosenBrief.value.id}”` : 'no brief',
    ].join(' · '),
  };
});

// --- Player ---------------------------------------------------------------

const element = () => picker.value?.video;
// A browser may refuse to start playback (a file it cannot play, or no click
// from the person yet). The Play button then simply stays as it is.
const play = () => element()?.play().catch(() => {});
function toggle() {
  const video = element();
  stopAtEnd = false;
  if (video) video.paused ? play() : video.pause();
}
function seek(to) {
  const video = element();
  if (video) video.currentTime = Math.min(Math.max(to, 0), duration.value || 0);
}
// A step is counted from where the video really is, not from the last time
// it reported: pressing a key three times quickly then moves three steps.
const nudge = (by) => seek((element()?.currentTime ?? time.value) + by);
// Set by "Play the range" only, so the ordinary Play button never stops by itself.
let stopAtEnd = false;
function playRange() {
  if (startSeconds.value === null) return;
  seek(startSeconds.value);
  stopAtEnd = true;
  play();
}
function onTime(now) {
  time.value = now;
  if (stopAtEnd && endSeconds.value !== null && now >= endSeconds.value) {
    stopAtEnd = false;
    element()?.pause();
  }
}
// Refs are already unwrapped in the template, so the marking is done here by name.
const here = () => (element()?.currentTime ?? time.value).toFixed(2);
const markStart = () => (start.value = here());
const markEnd = () => (end.value = here());
const percent = (t) => `${(Math.min(Math.max(t ?? 0, 0), duration.value || 1) / (duration.value || 1)) * 100}%`;

// Keys for the player. They are ignored while a box, a list or a slider has
// the keyboard, so typing a title never moves the video. On a button or a
// link only Space and Enter are left alone, because those press it: after
// choosing a video or pressing Play, a button is where the keyboard is.
// Keys are told apart by their place on the keyboard, not by the letter they
// type, so they work the same on a keyboard set to another alphabet.
const KEYS = [
  ['Space', 'play or pause'], ['← →', '1 second'], ['Shift + ← →', '0.1 second'],
  ['I', 'set start'], ['O', 'set end'], ['P', 'play the range'],
];
function onKey(event) {
  if (!info.value || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target;
  if (target instanceof HTMLElement) {
    if (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
    if (['BUTTON', 'A'].includes(target.tagName) && ['Space', 'Enter', 'NumpadEnter'].includes(event.code)) return;
  }
  const step = event.shiftKey ? 0.1 : 1;
  const action = {
    Space: toggle,
    KeyK: toggle,
    ArrowLeft: () => nudge(-step),
    ArrowRight: () => nudge(step),
    KeyI: markStart,
    KeyO: markEnd,
    KeyP: playRange,
  }[event.code];
  if (!action) return;
  event.preventDefault();
  action();
}
onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => {
  onScreen = false;
  window.removeEventListener('keydown', onKey);
});

// --- Cutting ----------------------------------------------------------------

async function cut() {
  cutError.value = '';
  try {
    const started = await api.cut({
      video: props.video,
      start: start.value,
      end: end.value,
      layout: layout.value,
      cropX: layout.value === 'center' ? cropX.value : undefined,
      cropWidth: layout.value === 'center' ? cropWidth.value : undefined,
      cam: layout.value === 'facecam' ? cam.value : undefined,
      game: layout.value === 'facecam' ? game.value : undefined,
      blurs: blursToSend(),
      overlay: overlayName.value && !briefOverlay.value ? { name: overlayName.value, ...overlaySettings.value } : undefined,
      trim: trim.value || 0,
      hook: hook.value,
      hookSeconds: hookSeconds.value,
      captions: captions.value,
      lang: lang.value,
      brief: brief.value,
      title: title.value,
      description: description.value,
    });
    // Remember which suggestion this was, so the list shows it as done.
    if (usedNumber.value > 0) (jobs.cutMoments[props.video] ??= []).push(usedKey.value);
    const result = await track(started);
    // Open the new clip only if this screen is still the one being looked at,
    // and then its "ready" notice is not needed. Otherwise the side column offers it.
    if (onScreen) {
      jobs.dismissed.push(started.id);
      emit('done', result.clip);
    }
  } catch (error) {
    cutError.value = error.message;
  }
}
</script>

<template>
  <div class="cutting">
    <header class="page-head">
      <h1>{{ video }}</h1>
      <p v-if="info" class="facts">
        <span class="chip">{{ info.width }}×{{ info.height }}</span>
        <span class="chip">{{ info.fps }} fps</span>
        <span class="chip">{{ clock(info.duration) }} long</span>
        <span class="chip" :class="{ warn: info.audioStreams === 0 }">
          {{ info.audioStreams === 0 ? 'no sound' : info.audioStreams === 1 ? '1 audio track' : `${info.audioStreams} audio tracks (the first is used)` }}
        </span>
      </p>
    </header>
    <p v-if="loadError" class="error" role="alert">{{ loadError }}</p>

    <div v-if="info" class="columns">
      <!-- The video stays in view while the settings beside it scroll. -->
      <section class="panel watch" aria-label="The video">
        <p v-if="!playable" class="notice">
          This browser cannot play this file, so there is no preview. You can still type the start and end and cut it.
        </p>

        <FramePicker
          ref="picker" v-model:crop-x="cropX" v-model:cam="cam" v-model:cam-shape="camShape" v-model:game="game" v-model:blurs="blurs"
          :src="api.videoUrl(video)" :info="info" :layout="layout" :now="time"
          @time="onTime" @duration="duration = $event" @playing="playing = $event" @unplayable="playable = false"
        />

        <div class="timeline">
          <div class="track" aria-hidden="true">
            <div class="range" :style="{ left: percent(startSeconds), width: percent(Math.max(0, length ?? 0)) }" />
          </div>
          <button
            v-for="(moment, i) in moments" :key="i" class="mark" :class="{ current: keyOf(moment) === usedKey }"
            :title="`Suggestion ${i + 1}: ${moment.reason}`"
            :aria-label="`Use suggestion ${i + 1}`"
            :style="{ left: percent(moment.start), width: percent(moment.end - moment.start) }" @click="useMoment(moment)"
          />
          <input
            type="range" min="0" :max="duration" step="0.01" :value="time" aria-label="Position in the video"
            @input="seek(Number($event.target.value))"
          />
        </div>

        <div class="controls">
          <button class="primary play" :aria-label="playing ? 'Pause' : 'Play'" @click="toggle">
            <Icon :name="playing ? 'pause' : 'play'" /> {{ playing ? 'Pause' : 'Play' }}
          </button>
          <span class="time numbers">{{ clock(time) }} <span class="muted">/ {{ clock(duration) }}</span></span>
          <span class="steps" role="group" aria-label="Step through the video">
            <button class="small" @click="nudge(-1)">−1 s</button>
            <button class="small" @click="nudge(-0.1)">−0.1 s</button>
            <button class="small" @click="nudge(0.1)">+0.1 s</button>
            <button class="small" @click="nudge(1)">+1 s</button>
          </span>
          <button class="small" @click="playRange"><Icon name="refresh" /> Play the range</button>
        </div>

        <p v-if="playable" class="keys">
          <span v-for="[key, what] in KEYS" :key="key"><kbd>{{ key }}</kbd> {{ what }}</span>
        </p>
      </section>

      <div class="settings stack">
        <section class="panel">
          <h2><span class="step">1</span> Range</h2>
          <p v-if="usedNumber > 0" class="using">
            <span class="chip mark">Suggestion {{ usedNumber }}</span> is filled in below.
            <button class="small" @click="usedKey = ''">Clear</button>
          </p>
          <div class="row">
            <div>
              <label for="start">Start</label>
              <div class="joined">
                <input id="start" v-model="start" type="text" inputmode="decimal" class="numbers" />
                <button title="Set the start to where the video is now (I)" @click="markStart"><Icon name="start" /> Set start here</button>
              </div>
            </div>
            <div>
              <label for="end">End</label>
              <div class="joined">
                <input id="end" v-model="end" type="text" inputmode="decimal" class="numbers" />
                <button title="Set the end to where the video is now (O)" @click="markEnd"><Icon name="end" /> Set end here</button>
              </div>
            </div>
          </div>
          <p class="hint">
            Seconds, or minutes and seconds such as 1:30.
            <template v-if="length !== null && length > 0">
              <strong class="numbers">{{ length.toFixed(1) }} s</strong> of footage<span v-if="total !== length">, {{ total.toFixed(1) }} s with the end card</span>
              <span v-if="chosenBrief?.minSeconds || chosenBrief?.maxSeconds">
                (the brief allows {{ chosenBrief.minSeconds ?? 0 }}–{{ chosenBrief.maxSeconds ?? '∞' }} s)
              </span>.
            </template>
          </p>
        </section>

        <section class="panel">
          <h2><span class="step">2</span> Layout</h2>
          <div class="layouts" role="radiogroup" aria-label="How to fit the picture into 9:16">
            <label v-for="known in LAYOUTS" :key="known.id" class="layout-choice" :class="{ chosen: layout === known.id }">
              <input v-model="layout" type="radio" name="layout" :value="known.id" />
              <!-- A small drawing of the tall frame and what goes where in it. -->
              <svg class="drawing" viewBox="0 0 36 64" aria-hidden="true">
                <rect class="frame" x="1" y="1" width="34" height="62" rx="4" />
                <rect v-if="known.id === 'center'" class="main" x="4" y="4" width="28" height="56" rx="2" />
                <template v-else-if="known.id === 'blur'">
                  <rect class="faint" x="4" y="4" width="28" height="56" rx="2" />
                  <rect class="main" x="4" y="24" width="28" height="16" rx="1" />
                </template>
                <template v-else>
                  <rect class="main" x="4" y="4" width="28" height="18" rx="2" />
                  <rect class="faint" x="4" y="24" width="28" height="36" rx="2" />
                </template>
              </svg>
              <span class="words"><strong>{{ known.name }}</strong><span>{{ known.about }}</span></span>
            </label>
          </div>

          <div v-if="layout === 'center' && info.layouts.centerWidths" class="option">
            <label for="crop-width">Show more of the picture</label>
            <input
              id="crop-width" v-model.number="widthSlider" type="range" step="2"
              :min="info.layouts.centerWidths.min" :max="info.layouts.centerWidths.max"
            />
            <p class="hint">
              <template v-if="cropWidth === undefined">
                The crop is the 9:16 column and fills the screen. Widen it when a person moves out of the column.
              </template>
              <template v-else>
                The crop is {{ info.layouts.center.width }} px wide. It is shown whole, with a blurred copy above and below.
                <button class="small" @click="cropWidth = undefined">Back to the column</button>
              </template>
            </p>
          </div>
          <p v-if="layout === 'center'" class="hint">
            Drag the bright window on the video to move the crop.
            <template v-if="cropX !== undefined">
              It starts {{ cropX }} px from the left. <button class="small" @click="cropX = undefined">Centre it</button>
            </template>
          </p>
          <div v-if="layout === 'facecam' && cam" class="cam-shape">
            <div class="row middle">
              <span class="fixed muted">Webcam shape</span>
              <span class="choices fixed" role="group" aria-label="Webcam shape">
                <button v-for="shape in CAM_SHAPES" :key="shape.name" :aria-pressed="camShape === shape.aspect" @click="chooseCamShape(shape.aspect)">{{ shape.name }}</button>
              </span>
            </div>
            <p class="hint">
              Drag the yellow box on the video over the webcam, and its corner to fit it. Now
              {{ cam.width }}×{{ cam.height }} at {{ cam.x }}, {{ cam.y }}.
              In the clip the webcam is the top {{ camPanel.height }} px and the gameplay the {{ camPanel.game }} px below.
              <template v-if="camPanel.cropped">The box is too {{ camPanel.cropped === 'sides' ? 'wide' : 'tall' }} for the panel, so a little of its {{ camPanel.cropped }} is cut off.</template>
            </p>
            <p v-if="game" class="hint">
              The blue box is the content shown below the webcam: move and resize it on its own. Now {{ game.width }}×{{ game.height }} at {{ game.x }}, {{ game.y }}.
              <template v-if="gameShown?.fills">It fills the bottom panel.</template>
              <template v-else-if="gameShown">It is shown whole, with a blurred copy of itself at the {{ gameShown.blurred }}.
                <button class="small" @click="fitGame">Fit to the panel</button>
              </template>
            </p>
          </div>

          <div class="option trim">
            <label for="trim">Trim each edge (pixels)</label>
            <input id="trim" v-model.number="trim" type="number" min="0" />
            <p class="hint">For a thin frame baked into a recording. Leave at 0 otherwise.</p>
          </div>

          <div class="option overlay">
            <label for="overlay">Overlay: a logo for the whole clip</label>
            <p v-if="briefOverlay" class="hint">The brief sets the overlay: <strong>{{ briefOverlay.name }}</strong>, {{ POSITION_NAMES[briefOverlay.position] }}, {{ briefOverlay.width }} px wide. It is used for this clip.</p>
            <template v-else>
              <select id="overlay" v-model="overlayName">
                <option value="">None</option>
                <option v-for="one in overlays" :key="one.name" :value="one.name">{{ one.name }} ({{ one.kind === 'full' ? 'full frame' : 'logo' }})</option>
              </select>
              <p v-if="overlays.length === 0" class="hint">Put PNG or WebP images (with transparency) in the project's <code>overlays</code> folder and reload to choose one here.</p>
              <div v-if="overlayShown && overlayShown.kind === 'logo'" class="row overlay-settings">
                <div class="narrow"><label for="ov-width">Width (px)</label><input id="ov-width" v-model.number="overlaySettings.width" type="number" min="20" max="1080" /></div>
                <div class="narrow"><label for="ov-margin">Margin (px)</label><input id="ov-margin" v-model.number="overlaySettings.margin" type="number" min="0" max="400" /></div>
                <div class="narrow"><label for="ov-offset">Move down (px)</label><input id="ov-offset" v-model.number="overlaySettings.offsetY" type="number" step="10" /></div>
                <div class="fixed">
                  <span class="label-like">Corner</span>
                  <span class="choices" role="group" aria-label="Corner">
                    <button v-for="position in OVERLAY_POSITIONS" :key="position" :aria-pressed="overlaySettings.position === position" @click="overlaySettings.position = position">{{ POSITION_NAMES[position] }}</button>
                  </span>
                </div>
              </div>
            </template>
            <div v-if="overlayPlace" class="row middle overlay-preview">
              <!-- A small 9:16 sketch of the clip: where the logo lands beside the captions and the bottom 15%. -->
              <div class="sketch fixed" aria-hidden="true">
                <div v-if="layout === 'facecam' && cam" class="band cam-band" :style="sketch(0, camPanelHeight(cam))" />
                <div class="band caption-band" :style="sketch(CAPTION_AREA.top, CAPTION_AREA.bottom - CAPTION_AREA.top)" />
                <div class="band bottom-band" :style="sketch(BOTTOM_AREA_TOP, OUT_HEIGHT - BOTTOM_AREA_TOP)" />
                <div class="logo-box" :style="{ left: `${(overlayPlace.x / OUT_WIDTH) * 100}%`, top: `${(overlayPlace.y / OUT_HEIGHT) * 100}%`, width: `${(overlayPlace.width / OUT_WIDTH) * 100}%`, height: `${(overlayPlace.height / OUT_HEIGHT) * 100}%` }" />
              </div>
              <div>
                <p class="hint">Shown from the first frame to the last, under the captions. The sketch shows the clip: <span class="key-logo">the logo</span>, <span class="key-caption">the captions</span>, <span class="key-bottom">the bottom 15%</span><template v-if="layout === 'facecam'">, <span class="key-cam">the webcam</span></template>.</p>
                <p v-for="problem in overlayProblems" :key="problem" class="fail small-print">{{ problem }}</p>
              </div>
            </div>
            <p v-else-if="briefOverlay && !briefOverlay.size" class="error">The brief's overlay image cannot be read.</p>
          </div>

          <div class="option blurs">
            <label>Blur part of the picture for some seconds</label>
            <p class="hint">
              For something the apps would take the clip down for, such as nudity in game footage. Go to where it shows and press "Add a blur box",
              then drag the pink box over it and resize it from its corner. The box stays where it is drawn: if the thing moves, add another box for the next seconds.
            </p>
            <div v-for="(box, i) in blurs" :key="i" class="row middle blur-row">
              <strong>{{ i + 1 }}</strong>
              <div class="narrow"><label :for="'blur-from-' + i">From (s)</label><input :id="'blur-from-' + i" :value="box.from" type="number" step="0.1" min="0" @change="changeBlur(i, { from: Number($event.target.value) })" /></div>
              <button title="Set to where the video is now" @click="changeBlur(i, { from: Number(here()) })">Now</button>
              <div class="narrow"><label :for="'blur-to-' + i">To (s)</label><input :id="'blur-to-' + i" :value="box.to" type="number" step="0.1" min="0" @change="changeBlur(i, { to: Number($event.target.value) })" /></div>
              <button title="Set to where the video is now" @click="changeBlur(i, { to: Number(here()) })">Now</button>
              <span class="choices fixed" role="group" aria-label="How it is hidden">
                <button :aria-pressed="box.style === 'blur'" @click="changeBlur(i, { style: 'blur' })">Blur</button>
                <button :aria-pressed="box.style === 'black'" @click="changeBlur(i, { style: 'black' })">Black</button>
              </span>
              <button title="Go to where this box starts" @click="seek(box.from)">Go to</button>
              <button title="Remove this box" @click="removeBlur(i)">Remove</button>
              <p v-if="blurProblem(box)" class="fail small-print">{{ blurProblem(box) }}</p>
            </div>
            <button :disabled="blurs.length >= MAX_BLURS" @click="addBlur">Add a blur box</button>
          </div>
        </section>

        <section class="panel">
          <h2><span class="step">3</span> Text</h2>
          <div class="row">
            <div class="wide">
              <label for="hook">
                Hook: a line shown at the top
                <span class="chip" :class="{ bad: hook.length > HOOK_LIMIT }">{{ hook.length }}/{{ HOOK_LIMIT }}</span>
              </label>
              <div class="joined">
                <input id="hook" v-model="hook" type="text" :aria-invalid="hook.length > HOOK_LIMIT" />
                <button
                  :disabled="!ai?.configured || Boolean(rangeProblem) || Boolean(hookJob)"
                  :title="ai?.configured ? 'Ask the AI for hooks for this clip. It reads the words spoken in the range, not the video.' : ai?.help"
                  @click="suggestHook"
                >
                  <span v-if="hookJob" class="spinner" aria-hidden="true" /><Icon v-else name="spark" /> Suggest
                </button>
              </div>
            </div>
            <div class="narrow">
              <label for="hook-seconds">Hook time (seconds)</label>
              <input id="hook-seconds" v-model.number="hookSeconds" type="number" min="0" step="0.5" />
            </div>
          </div>
          <p v-if="hookJob" class="hint" role="status">{{ describe(hookJob) }}</p>
          <div v-if="hookIdeas.length" class="hook-ideas" role="group" aria-label="Suggested hooks">
            <button v-for="idea in hookIdeas" :key="idea.text" class="small" :class="{ primary: hook === idea.text }" :title="idea.problems.join(' · ')" @click="hook = idea.text">
              {{ idea.text }}<span v-if="idea.problems.length" class="chip bad">brief</span>
            </button>
          </div>
          <p v-for="problem in [...new Set(hookIdeas.flatMap((idea) => idea.problems))]" :key="problem" class="fail small-print">Brief: {{ problem }}</p>
          <p v-if="hookError" class="error" role="alert">{{ hookError }}</p>
          <p class="hint">A hook time of 0 keeps the hook for the whole clip. “Suggest” sends only the words spoken in this range to {{ ai?.service ?? 'the AI' }}; click a hook to use it.</p>

          <div class="row option">
            <label class="check fixed"><input v-model="captions" type="checkbox" /> Burn in captions</label>
            <div class="narrow">
              <label for="lang">Spoken language</label>
              <input id="lang" v-model="lang" type="text" />
            </div>
          </div>

          <div class="row option">
            <div>
              <label for="title">Title for the post{{ brief ? ' (the hook is used when empty)' : '' }}</label>
              <input id="title" v-model="title" type="text" />
            </div>
            <div class="wide">
              <label for="description">Description for the post</label>
              <input id="description" v-model="description" type="text" />
            </div>
          </div>
          <p class="hint">The title and description are saved next to the clip as post.txt, ready to copy when you upload.</p>
        </section>

        <section class="panel">
          <h2><span class="step">4</span> Brief</h2>
          <label for="brief">Campaign brief to follow and check against</label>
          <select id="brief" v-model="brief">
            <option value="">None: no hashtags, no checks, no end card</option>
            <option v-for="b in briefs" :key="b.file" :value="b.file" :disabled="!b.ok">
              {{ b.ok ? b.brief.id : `${b.file} (not valid)` }}
            </option>
          </select>
        </section>

        <p class="hint part-note">
          “Save this part as it is”, in the bar below, keeps the original size and adds nothing: no reframing, hook
          or captions. It uses only the start and end, and the file goes to the <code>parts</code> folder.
        </p>

        <MomentFinder
          v-if="ai" :key="video" :video="video" :ai="ai" :brief="brief" :lang="lang" :max-seconds="maxSeconds"
          :used-key="usedKey" :cut-keys="jobs.cutMoments[video] ?? []" @use="useMoment" @seek="seek"
        />
      </div>
    </div>

    <!-- Always in view: what will be made, what is in the way, and the two buttons. -->
    <div v-if="info" class="cutbar">
      <div class="say">
        <p v-if="problem" class="problem"><Icon name="alert" /> {{ problem }}</p>
        <p v-else-if="summary" class="summary"><strong class="numbers">{{ summary.range }}</strong> · {{ summary.rest }}</p>
        <p v-for="running in cutsOfThisVideo" :key="running.id" class="running" role="status">
          <span class="spinner" aria-hidden="true" /> {{ describe(running) }}
        </p>
        <p v-if="cutError" class="error" role="alert">{{ cutError }}</p>
      </div>
      <button
        :disabled="Boolean(rangeProblem)"
        title="Keeps the original size and adds nothing: no reframing, hook or captions. Uses only the start and end. The file goes to the parts folder."
        @click="savePart"
      >
        <Icon name="piece" /> Save this part as it is
      </button>
      <button class="primary" :disabled="Boolean(problem)" @click="cut"><Icon name="scissors" /> Cut the clip</button>
    </div>
  </div>
</template>

<style scoped>
.facts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.columns { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--gap); align-items: start; }
@media (min-width: 1250px) {
  .columns { grid-template-columns: minmax(0, 1.15fr) minmax(380px, 1fr); }
  .watch { position: sticky; top: 16px; }
}

/* The timeline: a track with the chosen range on it, suggestions above, the position slider below. */
.timeline { position: relative; margin-top: 22px; }
.track { position: relative; height: 8px; border-radius: 4px; background: var(--soft); overflow: hidden; }
.range { position: absolute; top: 0; bottom: 0; min-width: 3px; background: var(--accent); }
.mark {
  position: absolute; top: -12px; height: 8px; min-width: 8px; min-height: 0; padding: 0;
  border: 0; border-radius: 3px; background: var(--warn);
}
.mark:hover:not(:disabled) { background: var(--accent-hover); }
.mark.current { background: var(--accent); top: -14px; height: 10px; }
.timeline input { margin-top: 6px; }

.controls { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 8px; }
.play { min-width: 104px; }
.time { min-width: 128px; font-weight: 600; }
.steps { display: inline-flex; gap: 4px; }
.keys { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 12px 0 0; font-size: 12px; color: var(--muted); }
kbd {
  font: 600 11px ui-monospace, Menlo, Consolas, monospace; padding: 1px 6px; border-radius: 4px;
  background: var(--soft); color: var(--text); border: 1px solid var(--line);
}

h2 { display: flex; align-items: center; gap: 8px; }
.step {
  display: grid; place-items: center; width: 24px; height: 24px; flex: none; border-radius: 50%;
  background: var(--highlight); color: var(--highlight-text); font-size: 13px;
}
.using { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 10px; }
.joined { display: flex; }
.joined input { border-radius: var(--radius) 0 0 var(--radius); min-width: 0; }
.joined button { flex: none; border-left: 0; border-radius: 0 var(--radius) var(--radius) 0; white-space: nowrap; }
.option { margin-top: 14px; }
.trim { max-width: 260px; }
.wide { flex: 3 1 260px; }
.narrow { flex: 0 1 170px; }
label .chip { margin-left: 6px; }

/* Three layouts to choose from, each with a small drawing. */
.layouts { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
.layout-choice {
  position: relative; display: flex; align-items: center; gap: 10px; margin: 0; padding: 10px; cursor: pointer;
  border: 1px solid var(--line-strong); border-radius: var(--radius); background: var(--panel); color: var(--text); font-weight: 400;
}
.layout-choice:hover { border-color: var(--accent); background: var(--soft); }
.layout-choice.chosen { border-color: var(--accent); background: var(--accent-tint); box-shadow: inset 0 0 0 1px var(--accent); }
.layout-choice input { position: absolute; opacity: 0; inset: 0; margin: 0; cursor: pointer; }
.layout-choice:has(input:focus-visible) { outline: 3px solid var(--accent); outline-offset: 2px; }
.drawing { width: 30px; height: 53px; flex: none; }
.drawing .frame { fill: none; stroke: var(--line-strong); stroke-width: 2; }
.drawing .main { fill: var(--accent); }
.drawing .faint { fill: var(--soft-strong); }
.words { display: flex; flex-direction: column; min-width: 0; }
.words strong { font-size: 14px; }
.words span { font-size: 12px; color: var(--muted); line-height: 1.35; }

.first { margin: 0 0 10px; }

/* The bar at the bottom of the screen. */
.cutbar {
  position: sticky; bottom: 0; z-index: 4; display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
  margin-top: var(--gap); padding: 12px 16px;
  background: var(--panel); border: 1px solid var(--line); border-bottom: 0;
  border-radius: var(--radius-large) var(--radius-large) 0 0; box-shadow: 0 -4px 14px var(--shadow);
}
.say { flex: 1 1 260px; min-width: 0; }
.say p { margin: 0; }
.say p + p { margin-top: 6px; }
.summary { font-size: 14px; color: var(--muted); }
.summary strong { color: var(--text); }
.problem { display: flex; align-items: center; gap: 8px; color: var(--warn); font-weight: 600; }
.running { display: flex; align-items: center; gap: 8px; }
.hook-ideas { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.hook-ideas button { text-align: left; white-space: normal; }
.small-print { font-size: 13px; margin: 4px 0 0; }
.overlay { margin-top: 14px; }
.blurs { margin-top: 14px; }
.blur-row { gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.overlay select { max-width: 100%; }
.overlay-settings { margin-top: 8px; }
.label-like { display: block; margin-bottom: 4px; font-size: 13px; font-weight: 550; color: var(--muted); }
.overlay-preview { margin-top: 10px; gap: 14px; align-items: flex-start; }
/* The clip in small: 9:16, with the areas the logo should keep clear of. */
.sketch { position: relative; width: 72px; height: 128px; border: 1px solid var(--line-strong); border-radius: 6px; background: var(--soft); overflow: hidden; }
.sketch .band { position: absolute; left: 0; right: 0; }
.cam-band, .key-cam { background: var(--soft-strong); }
.caption-band, .key-caption { background: var(--warn-bg); }
.bottom-band, .key-bottom { background: var(--bad-bg); }
.logo-box, .key-logo { background: var(--accent); }
.logo-box { position: absolute; opacity: 0.85; border-radius: 2px; }
.key-logo, .key-caption, .key-bottom, .key-cam { padding: 0 4px; border-radius: 3px; }
.key-logo { color: var(--accent-text); }
</style>
