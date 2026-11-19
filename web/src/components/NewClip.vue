<script setup>
// Cut a new clip from one source video: choose the range, the layout and the
// text, then start the job and wait for it.
import { computed, ref, watch } from 'vue';
import { api } from '../api.js';
import { clock } from '../format.js';
import { useJob } from '../useJob.js';
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
const cam = ref(undefined);
const trim = ref(0);
const hook = ref('');
const captions = ref(true);
const lang = ref('en');
const brief = ref('');
const title = ref('');
const description = ref('');

const { state: job, follow } = useJob();

async function loadInfo() {
  try {
    info.value = await api.video(props.video, trim.value || 0);
    loadError.value = '';
    duration.value ||= info.value.duration;
    if (!end.value) end.value = String(Math.min(30, Math.floor(info.value.duration)));
    // A crop chosen before the trim changed may now lie outside the frame.
    const { minX, maxX } = info.value.layouts.center;
    if (cropX.value !== undefined && minX !== null) cropX.value = Math.min(Math.max(cropX.value, minX), maxX);
  } catch (error) {
    loadError.value = error.message;
  }
}
watch(trim, loadInfo, { immediate: true });

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
  try {
    const started = await api.cut({
      video: props.video,
      start: start.value,
      end: end.value,
      layout: layout.value,
      cropX: layout.value === 'center' ? cropX.value : undefined,
      cam: layout.value === 'facecam' ? cam.value : undefined,
      trim: trim.value || 0,
      hook: hook.value,
      captions: captions.value,
      lang: lang.value,
      brief: brief.value,
      title: brief.value ? title.value : '',
      description: brief.value ? description.value : '',
    });
    const result = await follow(started);
    emit('done', result.clip);
  } catch (error) {
    job.error = error.message;
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

    <section v-if="info" class="panel stack">
      <div>
        <h2>Range</h2>
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
            <label for="hook">Hook: shown at the top for the first 2.5 seconds ({{ hook.length }}/{{ HOOK_LIMIT }})</label>
            <input id="hook" v-model="hook" type="text" />
          </div>
          <div>
            <label for="lang">Spoken language</label>
            <input id="lang" v-model="lang" type="text" />
          </div>
        </div>
        <label class="check"><input v-model="captions" type="checkbox" /> Burn in captions</label>
      </div>

      <div>
        <h2>Brief</h2>
        <label for="brief">Campaign brief to follow and check against</label>
        <select id="brief" v-model="brief">
          <option value="">None: no post text, no checks, no end card</option>
          <option v-for="b in briefs" :key="b.file" :value="b.file" :disabled="!b.ok">
            {{ b.ok ? b.brief.id : `${b.file} (not valid)` }}
          </option>
        </select>
        <div v-if="brief" class="row brief-text">
          <div>
            <label for="title">Title for the post (the hook is used when empty)</label>
            <input id="title" v-model="title" type="text" />
          </div>
          <div>
            <label for="description">Description</label>
            <input id="description" v-model="description" type="text" />
          </div>
        </div>
      </div>

      <div class="row">
        <button class="fixed primary" :disabled="job.running || Boolean(problem)" @click="cut">Cut the clip</button>
        <span v-if="job.running" role="status">{{ job.text }}</span>
        <span v-else-if="problem" class="muted">{{ problem }}</span>
      </div>
      <p v-if="job.error" class="error" role="alert">{{ job.error }}</p>
    </section>
  </div>
</template>

<style scoped>
.timeline { position: relative; margin-top: 10px; padding-top: 8px; }
.timeline input { width: 100%; margin: 0; }
.range { position: absolute; top: 0; height: 5px; border-radius: 3px; background: var(--accent); }
.controls { margin-top: 6px; align-items: center; }
.time { font-variant-numeric: tabular-nums; min-width: 120px; }
.length { margin-top: 8px; }
.wide { flex: 3 1 300px; }
.check { margin-top: 10px; color: var(--text); font-size: 15px; }
.brief-text { margin-top: 10px; }
</style>
