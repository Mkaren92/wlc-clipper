<script setup>
// Bringing part of a YouTube video, or a whole one up to three hours, into the videos
// folder (`in/`), from a channel in the sources list. The engine does every check that counts (src/fetch.js);
// this page runs the same link and range checks first (src/fetchLink.js), so a
// mistake shows while typing instead of after the job starts.
import { computed, onMounted, ref } from 'vue';
import { checkFetchRange, MAX_FETCH_SECONDS, MAX_WHOLE_SECONDS, videoUrl } from '../../../src/fetchLink.js';
import { formatClock, parseTime } from '../../../src/time.js';
import { api } from '../api.js';
import Icon from '../components/Icon.vue';
import { describe, isActive, jobs, refresh as refreshJobs, track } from '../jobs.js';
import { live } from '../live.js';

const emit = defineEmits(['open']);

const installed = ref(true);
const loaded = ref(false);
const loadError = ref('');
const channels = ref([]); // the saved channels that may be fetched from
const link = ref('');
const start = ref('');
const end = ref('');
// The whole video instead of a part. Its length is known only once YouTube is asked, so the engine checks it.
const whole = ref(false);
const startError = ref('');
const stopping = ref(false);

onMounted(async () => {
  try {
    const answer = await api.sources();
    channels.value = answer.sources.filter((source) => source.status === 'agreed');
    installed.value = answer.downloaderInstalled;
  } catch (e) {
    loadError.value = e.message;
  }
  loaded.value = true;
});

// The link, checked as the engine will check it. Nothing is said while the box is empty.
const checkedLink = computed(() => {
  if (!link.value.trim()) return { url: null, error: '' };
  try {
    return { url: videoUrl(link.value), error: '' };
  } catch (e) {
    return { url: null, error: e.message };
  }
});

// A link to a stream that a channel in the list is broadcasting right now: the engine refuses it,
// so the page says so before anything is asked. Only what the live store already knows is used.
const liveChannel = computed(() => {
  if (!checkedLink.value.url) return null;
  const id = new URL(checkedLink.value.url).searchParams.get('v');
  const entry = Object.entries(live.channels).find(([, stream]) => stream?.live && stream.videoId === id);
  return entry ? (channels.value.find((source) => source.id === entry[0])?.name ?? 'This channel') : null;
});

// The range, checked as the engine will check it.
function seconds(text) {
  try {
    return { value: parseTime(text), error: '' };
  } catch (e) {
    return { value: null, error: e.message };
  }
}
const range = computed(() => {
  if (!start.value.trim() || !end.value.trim()) return { length: null, error: '' };
  const from = seconds(start.value);
  const to = seconds(end.value);
  if (from.error || to.error) return { length: null, error: from.error || to.error };
  try {
    return { length: checkFetchRange(from.value, to.value), error: '', from: from.value, to: to.value };
  } catch (e) {
    return { length: null, error: e.message };
  }
});

// The fetch that is running, or else the last one, read from the server's list of jobs,
// so it is still shown after moving to another page or reloading.
const fetches = computed(() => jobs.list.filter((job) => job.kind === 'fetch'));
const running = computed(() => fetches.value.find(isActive));
const last = computed(() => running.value ?? fetches.value.at(-1));
const busy = computed(() => jobs.list.some(isActive));

const ready = computed(() => installed.value && channels.value.length > 0 && checkedLink.value.url && (whole.value || range.value.length) && !liveChannel.value && !running.value);

async function download() {
  startError.value = '';
  try {
    const job = await api.fetchVideo(whole.value ? { url: checkedLink.value.url, whole: true } : { url: checkedLink.value.url, start: range.value.from, end: range.value.to });
    link.value = '';
    // The side column announces it too, so it is not missed after moving to another page.
    // How it ended is shown below from the job itself, so the promise's own error is not needed here.
    await track(job).catch(() => {});
  } catch (e) {
    startError.value = e.message;
  }
}

async function stop() {
  stopping.value = true;
  try {
    await api.stopJob(running.value.id);
  } catch {
    // It finished by itself in the meantime; the list will say so.
  }
  await refreshJobs();
  stopping.value = false;
}
</script>

<template>
  <div class="stack download">
    <section class="panel">
      <h2><Icon name="download" /> Download a video</h2>
      <p class="hint first">
        Paste the link to a YouTube video from one of your channels, and give the part you want, up to
        {{ MAX_FETCH_SECONDS / 60 }} minutes, or tick "Whole video" for all of it, up to {{ MAX_WHOLE_SECONDS / 3600 }} hours.
        It is saved in your videos (the <code>in</code> folder), named after the channel, ready to cut. The picture is kept
        exactly as YouTube sends it, so a part may start a few seconds before the time you give; set the exact start when you cut.
      </p>

      <p v-if="loadError" class="error" role="alert">{{ loadError }}</p>
      <p v-else-if="!installed" class="notice">
        The downloader is not installed yet. Run <code>npm run setup</code> in the project folder, then restart the dashboard.
      </p>
      <p v-else-if="loaded && channels.length === 0" class="notice">
        There are no channels to download from yet. Add the channels that have agreed on the Sources page first.
      </p>

      <div class="row">
        <div class="wide">
          <label for="dl-link">Link to the video</label>
          <input id="dl-link" v-model="link" type="text" placeholder="https://www.youtube.com/watch?v=..." autocomplete="off" spellcheck="false" />
        </div>
        <template v-if="!whole">
          <div class="narrow">
            <label for="dl-start">From</label>
            <input id="dl-start" v-model="start" type="text" placeholder="1:02:00" class="numbers" autocomplete="off" />
          </div>
          <div class="narrow">
            <label for="dl-end">To</label>
            <input id="dl-end" v-model="end" type="text" placeholder="1:04:30" class="numbers" autocomplete="off" />
          </div>
        </template>
        <label class="check fixed whole"><input v-model="whole" type="checkbox" /> Whole video</label>
        <button class="fixed primary go" :disabled="!ready" @click="download">
          <Icon name="download" /> Download
        </button>
      </div>

      <p v-if="checkedLink.error" class="error" role="alert">{{ checkedLink.error }}</p>
      <p v-else-if="liveChannel" class="notice">
        {{ liveChannel }} is live on this stream right now. It can be downloaded once the stream has ended and
        YouTube shows it as an ordinary video.
      </p>
      <p v-if="whole" class="muted length">
        All of it, up to {{ MAX_WHOLE_SECONDS / 3600 }} hours; a longer video is refused before anything is downloaded.
        Suggestions work on videos up to 60 minutes, so a long one is cut by hand.
      </p>
      <template v-else>
        <p v-if="range.error" class="error" role="alert">{{ range.error }}</p>
        <p v-else-if="range.length" class="muted length">{{ formatClock(range.length) }} long</p>
      </template>
      <p v-if="busy && !running" class="muted">Another job is running; this download will wait for it.</p>
      <p v-if="startError" class="error" role="alert">{{ startError }}</p>
    </section>

    <section v-if="last" class="panel result" :class="last.status" aria-live="polite">
      <div v-if="isActive(last)" class="row middle">
        <span class="fixed running"><span class="spinner" aria-hidden="true" /> {{ describe(last) }}</span>
        <span />
        <button class="fixed small" :disabled="stopping" @click="stop"><Icon name="stop" /> {{ stopping ? 'Stopping…' : 'Stop' }}</button>
      </div>
      <template v-else-if="last.status === 'done'">
        <p class="row middle done-line">
          <Icon name="check" class="fixed" />
          <span><strong>{{ last.result.name }}</strong> is in your videos.</span>
        </p>
        <p class="muted">
          {{ last.result.source }}: {{ last.result.title }}. {{ formatClock(last.result.seconds) }} long{{ last.result.early > 0.05 ? `, starting ${last.result.early.toFixed(1)} s before the time asked` : '' }}.
        </p>
        <p v-if="last.result.slow" class="notice">
          This one came the slow way, because the fast way did not work: {{ last.result.slow }}
        </p>
        <button class="primary" @click="emit('open', last.result.name)"><Icon name="scissors" /> Open it to cut</button>
      </template>
      <p v-else-if="last.status === 'stopped'" class="row middle"><Icon name="stop" class="fixed" /> {{ describe(last) }} Nothing was kept.</p>
      <p v-else class="error" role="alert">{{ describe(last) }}</p>
    </section>

    <section v-if="channels.length > 0" class="panel">
      <details>
        <summary>You can download from {{ channels.length }} {{ channels.length === 1 ? 'channel' : 'channels' }}</summary>
        <p class="hint">
          The channel is read from the video itself, so a video from any other channel is refused. To add one, use the Sources page.
        </p>
        <ul class="names">
          <li v-for="source in channels" :key="source.id" class="chip">{{ source.name }}</li>
        </ul>
      </details>
    </section>
  </div>
</template>

<style scoped>
.panel > h2 { display: flex; align-items: center; gap: 8px; margin: 0; }
.first { margin: 6px 0 12px; }
.wide { flex: 3 1 320px; }
.narrow { flex: 0 1 150px; }
.go { align-self: flex-end; }
.whole { align-self: flex-end; min-height: 36px; }
.length { margin: 8px 0 0; }
.error, .notice { margin-top: 10px; }
.running { display: inline-flex; align-items: center; gap: 8px; }
.result.done { border-color: var(--good); }
.result.done .done-line .icon { color: var(--good); }
.result.failed { border-color: var(--bad); }
.done-line { gap: 8px; margin: 0 0 4px; }
.result .muted { margin: 0 0 12px; word-break: break-word; }
summary { cursor: pointer; font-weight: 600; }
.names { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
</style>
