<script setup>
// Cut a new clip from one source video: choose the range, the layout and the
// text, then start the job and wait for it.
import { computed, onUnmounted, ref, watch } from 'vue';
import { api } from '../api.js';
import { clock } from '../format.js';
import { describe, isActive, jobs, track } from '../jobs.js';
import FramePicker from './FramePicker.vue';

const props = defineProps({
  video: { type: String, required: true },
  briefs: { type: Array, required: true },
});
const emit = defineEmits(['done']);

const HOOK_LIMIT = 60;

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
onUnmounted(() => (onScreen = false));
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

const ai = ref(null); // { configured, service, model }
const suggestCount = ref(5);
const suggestError = ref('');
const moments = computed(() => jobs.suggestions[props.video] ?? []);
const suggestJob = computed(() => jobs.list.find((job) => job.kind === 'suggest' && isActive(job) && job.label === props.video));
const noMoments = computed(() => props.video in jobs.suggestions && moments.value.length === 0);
api.ai().then((answer) => (ai.value = answer), () => {});

async function suggest() {
  suggestError.value = '';
  try {
    await track(await api.suggest({
      video: props.video, count: suggestCount.value || 5, brief: brief.value, lang: lang.value,
    }));
  } catch (error) {
    suggestError.value = error.message;
  }
}

// Which suggestion the form was filled from, so it can be shown as the one
// being worked on. It stays marked while the range is fine-tuned by hand.
const keyOf = (moment) => `${moment.start}-${moment.end}`;
const usedKey = ref('');
const usedNumber = computed(() => moments.value.findIndex((moment) => keyOf(moment) === usedKey.value) + 1);
const alreadyCut = (moment) => (jobs.cutMoments[props.video] ?? []).includes(keyOf(moment));

// Fill the form from a suggestion. Nothing is cut until "Cut the clip" is pressed.
function useMoment(moment) {
  usedKey.value = keyOf(moment);
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
  const width = Math.round(info.value.width * 0.375);
  const height = Math.round(width / info.value.layouts.camAspect);
  cam.value = { x: Math.round((info.value.width - width) / 2), y: Math.round(info.value.height * 0.1), width, height };
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
const markStart = () => (start.value = time.value.toFixed(2));
const markEnd = () => (end.value = time.value.toFixed(2));
const percent = (t) => `${((t ?? 0) / (duration.value || 1)) * 100}%`;

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
    // and then its "ready" notice is not needed. Otherwise the status bar offers it.
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
  <div class="stack">
    <p v-if="loadError" class="error">{{ loadError }}</p>

    <section v-if="info" class="panel">
      <h2>{{ video }}</h2>
      <p class="muted">
        {{ info.width }}×{{ info.height }}, {{ info.fps }} fps, {{ clock(info.duration) }} long,
        {{ info.audioStreams === 0 ? 'no sound' : info.audioStreams === 1 ? '1 audio track' : `${info.audioStreams} audio tracks (the first is used)` }}
      </p>
      <p v-if="!playable" class="notice">
        This browser cannot play this file, so there is no preview. You can still type the start and end and cut it.
      </p>

      <FramePicker
        ref="picker" v-model:crop-x="cropX" v-model:cam="cam"
        :src="api.videoUrl(video)" :info="info" :layout="layout"
        @time="onTime" @duration="duration = $event" @playing="playing = $event" @unplayable="playable = false"
      />

      <div class="timeline">
        <div class="range" :style="{ left: percent(startSeconds), width: percent(Math.max(0, length ?? 0)) }" />
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

      <div class="row controls">
        <button class="fixed primary" @click="toggle">{{ playing ? 'Pause' : 'Play' }}</button>
        <span class="fixed time">{{ clock(time) }} / {{ clock(duration) }}</span>
        <button class="fixed small" @click="seek(time - 1)">−1 s</button>
        <button class="fixed small" @click="seek(time - 0.1)">−0.1 s</button>
        <button class="fixed small" @click="seek(time + 0.1)">+0.1 s</button>
        <button class="fixed small" @click="seek(time + 1)">+1 s</button>
        <button class="fixed small" @click="playRange">Play the range</button>
      </div>
    </section>

    <section v-if="info && ai" class="panel">
      <h2>Suggested moments</h2>
      <p v-if="!ai.configured" class="muted">{{ ai.help }} Then restart the dashboard.</p>
      <template v-else>
        <p class="muted">
          Transcribes the whole video on this computer, then sends the transcript text (not the video) to
          {{ ai.service }} ({{ ai.model }}). The first time on a video takes a few minutes.
        </p>
        <div class="row">
          <div class="fixed count">
            <label for="count">How many</label>
            <input id="count" v-model.number="suggestCount" type="number" min="1" max="10" />
          </div>
          <button class="fixed" :disabled="Boolean(suggestJob)" @click="suggest">Suggest moments</button>
          <span v-if="suggestJob" role="status">{{ describe(suggestJob) }}</span>
          <span v-else-if="noMoments" class="muted">No usable moments came back. Try again.</span>
        </div>
        <p v-if="suggestError" class="error" role="alert">{{ suggestError }}</p>
        <ol v-if="moments.length > 0" class="moments">
          <li v-for="(moment, i) in moments" :key="i" :class="{ current: keyOf(moment) === usedKey }">
            <div class="row">
              <strong class="fixed">{{ clock(moment.start) }}–{{ clock(moment.end) }}</strong>
              <span class="fixed muted">{{ (moment.end - moment.start).toFixed(1) }} s · rated {{ moment.score.toFixed(2) }}</span>
              <button class="fixed small" :class="{ primary: keyOf(moment) === usedKey }" @click="useMoment(moment)">
                {{ keyOf(moment) === usedKey ? 'In use' : 'Use this' }}
              </button>
              <span v-if="alreadyCut(moment)" class="fixed pass">Already cut</span>
            </div>
            <p>{{ moment.reason }}</p>
            <p v-if="moment.hook" class="muted">Hook: “{{ moment.hook }}”</p>
            <p v-for="problem in moment.problems" :key="problem" class="fail">Brief: {{ problem }}</p>
          </li>
        </ol>
      </template>
    </section>

    <section v-if="info" class="panel stack">
      <div>
        <h2>Range</h2>
        <p v-if="usedNumber > 0" class="using">
          Working on suggestion {{ usedNumber }}. <button class="small" @click="usedKey = ''">Clear</button>
        </p>
        <div class="row">
          <div>
            <label for="start">Start</label>
            <input id="start" v-model="start" type="text" inputmode="decimal" />
          </div>
          <button class="fixed" @click="markStart">Set start here</button>
          <div>
            <label for="end">End</label>
            <input id="end" v-model="end" type="text" inputmode="decimal" />
          </div>
          <button class="fixed" @click="markEnd">Set end here</button>
        </div>
        <p v-if="length !== null && length > 0" class="muted length">
          {{ length.toFixed(1) }} s of footage<span v-if="total !== length">, {{ total.toFixed(1) }} s with the end card</span>
          <span v-if="chosenBrief?.minSeconds || chosenBrief?.maxSeconds">
            (the brief allows {{ chosenBrief.minSeconds ?? 0 }}–{{ chosenBrief.maxSeconds ?? '∞' }} s)
          </span>
        </p>
      </div>

      <div>
        <h2>Layout</h2>
        <div class="row">
          <div>
            <label for="layout">How to fit the picture into 9:16</label>
            <select id="layout" v-model="layout">
              <option value="center">Center: crop a column</option>
              <option value="blur">Blur: whole frame over a blurred copy</option>
              <option value="facecam">Facecam: webcam above gameplay</option>
            </select>
          </div>
          <div>
            <label for="trim">Trim each edge (pixels)</label>
            <input id="trim" v-model.number="trim" type="number" min="0" />
          </div>
        </div>
        <div v-if="layout === 'center' && info?.layouts.centerWidths" class="wider">
          <label for="crop-width">Show more of the picture</label>
          <input
            id="crop-width" v-model.number="widthSlider" type="range" step="2"
            :min="info.layouts.centerWidths.min" :max="info.layouts.centerWidths.max"
          />
          <p class="muted length">
            <template v-if="cropWidth === undefined">The crop is the 9:16 column and fills the screen.</template>
            <template v-else>
              The crop is {{ info.layouts.center.width }} px wide. It is shown whole, with a blurred copy above and below.
              <button class="small" @click="cropWidth = undefined">Back to the column</button>
            </template>
          </p>
        </div>
        <p v-if="layout === 'center' && cropX !== undefined" class="muted length">
          Crop starts {{ cropX }} px from the left. <button class="small" @click="cropX = undefined">Centre it</button>
        </p>
        <p v-if="layout === 'facecam' && cam" class="muted length">
          Webcam area: {{ cam.width }}×{{ cam.height }} at {{ cam.x }}, {{ cam.y }}.
        </p>
      </div>

      <div>
        <h2>Text</h2>
        <div class="row">
          <div class="wide">
            <label for="hook">Hook: a line shown at the top ({{ hook.length }}/{{ HOOK_LIMIT }})</label>
            <input id="hook" v-model="hook" type="text" />
          </div>
          <div>
            <label for="hook-seconds">Hook time in seconds (0 = whole clip)</label>
            <input id="hook-seconds" v-model.number="hookSeconds" type="number" min="0" step="0.5" />
          </div>
          <div>
            <label for="lang">Spoken language</label>
            <input id="lang" v-model="lang" type="text" />
          </div>
        </div>
        <div class="row post-text">
          <div>
            <label for="title">Title for the post{{ brief ? ' (the hook is used when empty)' : '' }}</label>
            <input id="title" v-model="title" type="text" />
          </div>
          <div class="wide">
            <label for="description">Description for the post</label>
            <input id="description" v-model="description" type="text" />
          </div>
        </div>
        <p class="muted post-note">The title and description are saved next to the clip as post.txt, ready to copy when you upload.</p>
        <label class="check"><input v-model="captions" type="checkbox" /> Burn in captions</label>
      </div>

      <div>
        <h2>Brief</h2>
        <label for="brief">Campaign brief to follow and check against</label>
        <select id="brief" v-model="brief">
          <option value="">None: no hashtags, no checks, no end card</option>
          <option v-for="b in briefs" :key="b.file" :value="b.file" :disabled="!b.ok">
            {{ b.ok ? b.brief.id : `${b.file} (not valid)` }}
          </option>
        </select>
      </div>

      <div class="row">
        <button class="fixed primary" :disabled="Boolean(problem)" @click="cut">Cut the clip</button>
        <button class="fixed" :disabled="Boolean(rangeProblem)" @click="savePart">Save this part as it is</button>
        <span v-if="problem" class="muted">{{ problem }}</span>
      </div>
      <p class="muted part-note">
        “Save this part as it is” keeps the original size and adds nothing: no reframing, hook or captions. It uses only
        the start and end, and the file goes to the <code>parts</code> folder.
      </p>
      <p v-for="running in cutsOfThisVideo" :key="running.id" role="status">{{ describe(running) }}</p>
      <p v-if="cutError" class="error" role="alert">{{ cutError }}</p>
    </section>
  </div>
</template>

<style scoped>
.timeline { position: relative; margin-top: 18px; padding-top: 8px; }
.timeline input { width: 100%; margin: 0; }
.range { position: absolute; top: 0; height: 5px; border-radius: 3px; background: var(--accent); }
.mark {
  position: absolute; top: -9px; height: 7px; min-width: 6px; padding: 0; border: 0; border-radius: 3px;
  background: #e8a020; cursor: pointer;
}
.count { width: 90px; }
.moments { margin: 12px 0 0; padding-left: 20px; }
.moments li { padding: 8px 10px; border-top: 1px solid var(--line); border-left: 4px solid transparent; }
.moments li.current { border-left-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); border-radius: 0 6px 6px 0; }
.mark.current { background: var(--accent); top: -12px; height: 10px; }
.using { margin-bottom: 10px; font-weight: 600; }
.moments p { margin: 4px 0 0; }
.controls { margin-top: 6px; align-items: center; }
.time { font-variant-numeric: tabular-nums; min-width: 120px; }
.length { margin-top: 8px; }
.wide { flex: 3 1 300px; }
.check { margin-top: 10px; color: var(--text); font-size: 15px; }
.post-text { margin-top: 10px; }
.post-note { margin: 6px 0 0; font-size: 13px; }
.part-note { margin: 0; font-size: 13px; }
</style>
