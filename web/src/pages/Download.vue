<script setup>
// Bringing part of a YouTube or Twitch video, or a whole one up to three hours, into the videos
// folder (`in/`), from a channel in the sources list. The engine does every check that counts (src/fetch.js);
// this page runs the same link and range checks first (src/fetchLink.js), so a
// mistake shows while typing instead of after the job starts.
import { computed, onMounted, ref } from 'vue';
import { checkFetchRange, MAX_FETCH_SECONDS, MAX_WHOLE_SECONDS, videoLink } from '../../../src/fetchLink.js';
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
// The whole video instead of a part. Its length is known only once the site is asked, so the engine checks it.
const whole = ref(false);
const startError = ref('');
const stopping = ref(false);
// Transcribe the video for "Suggest moments" straight after downloading it. Remembered in this
// browser only, as a convenience; on by default.
const transcribeAfter = ref(true);
try {
  transcribeAfter.value = localStorage.getItem('clipper.transcribeAfter') !== 'no';
} catch {
  // No storage here: on, as by default.
}
function rememberTranscribe() {
  try {
    localStorage.setItem('clipper.transcribeAfter', transcribeAfter.value ? 'yes' : 'no');
  } catch {
    // Not remembered; it still applies to this download.
  }
}

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
    const checked = videoLink(link.value);
    return { url: checked.url, site: checked.site, id: checked.id, error: '' };
  } catch (e) {
    return { url: null, error: e.message };
  }
});

// A link to a stream that a channel in the list is broadcasting right now: the engine refuses it,
// so the page says so before anything is asked. Only what the live store already knows is used.
const liveChannel = computed(() => {
  // Only a YouTube stream is known by its video's id; a Twitch broadcast still going is refused by the engine.
  if (!checkedLink.value.url || checkedLink.value.site !== 'youtube') return null;
  const id = checkedLink.value.id;
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
    const where = whole.value ? { whole: true } : { start: range.value.from, end: range.value.to };
    const job = await api.fetchVideo({ url: checkedLink.value.url, ...where, transcribe: transcribeAfter.value });
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

// --- Clips from a finished stream's chat ---------------------------------------
// The chat is read, and only the parts where it exploded are downloaded. The
// choosing is the engine's (src/chat/pick.js); this only asks and shows.
const streamLink = ref('');
const words = ref('');
const clipCount = ref(6);
const before = ref(30);
const after = ref(30);
// Leave out the parts of this stream given before (the engine keeps the list, and
// counts parts of it already in the videos folder).
const skipSuggested = ref(false);
const clipsError = ref('');
// A Twitch stream's chat, saved by the owner with TwitchDownloader: Twitch does not let the tool read it.
const chatFile = ref(null);
const chatFileInput = ref(null);
const sendingChat = ref(false);
const checkedStream = computed(() => {
  if (!streamLink.value.trim()) return { url: null, error: '' };
  try {
    const checked = videoLink(streamLink.value);
    return { url: checked.url, site: checked.site, error: '' };
  } catch (e) {
    return { url: null, error: e.message };
  }
});
const clipJobs = computed(() => jobs.list.filter((job) => job.kind === 'chat-clips'));
const clipsRunning = computed(() => clipJobs.value.find(isActive));
const lastClips = computed(() => clipsRunning.value ?? clipJobs.value.at(-1));
const countOk = computed(() => Number.isInteger(clipCount.value) && clipCount.value >= 1 && clipCount.value <= 20);
const secondsOk = computed(() => [before.value, after.value].every((n) => Number.isFinite(n) && n >= 1 && n <= 120));
const clipsReady = computed(() => installed.value && channels.value.length > 0 && checkedStream.value.url && countOk.value && secondsOk.value && !clipsRunning.value && !sendingChat.value);

function chooseChatFile(event) {
  chatFile.value = event.target.files?.[0] ?? null;
  event.target.value = '';
}

async function getClips() {
  clipsError.value = '';
  try {
    // A Twitch stream's chat file goes first; without one, a chat imported for this stream before is used.
    if (checkedStream.value.site === 'twitch' && chatFile.value) {
      sendingChat.value = true;
      try {
        await api.importStreamChat(checkedStream.value.url, chatFile.value.name, chatFile.value);
      } finally {
        sendingChat.value = false;
      }
      chatFile.value = null;
    }
    const job = await api.clipsFromChat({ url: checkedStream.value.url, words: words.value, count: clipCount.value, before: before.value, after: after.value, skipSuggested: skipSuggested.value });
    await track(job).catch(() => {});
  } catch (e) {
    clipsError.value = e.message;
  }
}
async function stopClips() {
  stopping.value = true;
  try {
    await api.stopJob(clipsRunning.value.id);
  } catch {
    // It finished by itself in the meantime.
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
        Paste the link to a YouTube video, or a Twitch past broadcast (<code>twitch.tv/videos/…</code>), from one of your
        channels, and give the part you want, up to
        {{ MAX_FETCH_SECONDS / 3600 }} hours, or tick "Whole video" for all of it, up to {{ MAX_WHOLE_SECONDS / 3600 }} hours.
        It is saved in your videos (the <code>in</code> folder), named after the channel, ready to cut. The picture is kept
        exactly as the site sends it, so a part may start a few seconds before the time you give; set the exact start when you cut.
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
          <input id="dl-link" v-model="link" type="text" placeholder="https://www.youtube.com/watch?v=... or https://www.twitch.tv/videos/..." autocomplete="off" spellcheck="false" />
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
        Suggestions work on videos up to 3 hours.
      </p>
      <template v-else>
        <p v-if="range.error" class="error" role="alert">{{ range.error }}</p>
        <p v-else-if="range.length" class="muted length">{{ formatClock(range.length) }} long</p>
      </template>
      <label class="check after">
        <input v-model="transcribeAfter" type="checkbox" @change="rememberTranscribe" />
        Transcribe it for “Suggest moments” straight after
      </label>
      <p class="hint">
        So the suggestions start at once when you open the video. It runs after the download, in Activity, and can be stopped there;
        other work waits for it. Videos over 3 hours are skipped, since suggestions do not take them.
      </p>
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

    <section class="panel">
      <h2><Icon name="spark" /> Clips from a stream's chat</h2>
      <p class="hint first">
        Paste the link of a <strong>finished live stream</strong> from one of your channels. Its chat and top comments are read
        (not the video), and only the best moments are downloaded into your videos, from {{ before }} s before to {{ after }} s
        after each one. A moment is where chat <em>reacted</em> (laughing, “W”, “L”, “no way”, “clip it”; commands, poll votes and
        pasted messages do not count) or where viewers pointed in the comments (“3:45:40 the jump scare”). With words, moments
        where they were written come first. An uploaded video has comments but no chat, so it cannot be used here.
        For a <strong>Twitch</strong> past broadcast, Twitch does not let this tool read the chat: save it with TwitchDownloader as
        JSON and choose the file here. Twitch has no comments, so the moments come from chat alone.
      </p>
      <div class="row">
        <div class="wide">
          <label for="cc-link">Link to the finished stream</label>
          <input id="cc-link" v-model="streamLink" type="text" placeholder="https://www.youtube.com/watch?v=... or https://www.twitch.tv/videos/..." autocomplete="off" spellcheck="false" />
        </div>
        <div v-if="checkedStream.site === 'twitch'" class="fixed chat-file">
          <span class="label-like">Chat file</span>
          <button type="button" @click="chatFileInput.click()"><Icon name="plus" /> {{ chatFile ? chatFile.name : 'Choose…' }}</button>
          <input ref="chatFileInput" type="file" accept=".json,application/json" hidden @change="chooseChatFile" />
        </div>
        <div class="wide">
          <label for="cc-words">Words (optional)</label>
          <input id="cc-words" v-model="words" type="text" placeholder="goal, penalty" autocomplete="off" />
        </div>
        <div class="tiny">
          <label for="cc-count">Clips</label>
          <input id="cc-count" v-model.number="clipCount" type="number" min="1" max="20" class="numbers" />
        </div>
        <button class="fixed primary go" :disabled="!clipsReady" @click="getClips"><Icon name="download" /> Get the clips</button>
      </div>
      <label class="check"><input v-model="skipSuggested" type="checkbox" /> Skip parts already suggested for this stream</label>
      <p class="hint">For new moments when you did not like the last ones: every part of this stream given to you before, and every part of it already in your videos, is left out.</p>
      <details class="more">
        <summary>Seconds before and after</summary>
        <div class="row">
          <div class="tiny"><label for="cc-before">Before</label><input id="cc-before" v-model.number="before" type="number" min="1" max="120" class="numbers" /></div>
          <div class="tiny"><label for="cc-after">After</label><input id="cc-after" v-model.number="after" type="number" min="1" max="120" class="numbers" /></div>
        </div>
      </details>
      <p class="hint">A word from the Football or Gaming words brings its whole group: “goal” also counts gol, golazo and GOOOOL. Separate words with commas.</p>
      <p v-if="checkedStream.site === 'twitch' && !chatFile" class="hint">
        No file chosen: a chat imported for this stream before is used, if there is one.
      </p>
      <p v-if="sendingChat" class="running" role="status"><span class="spinner" aria-hidden="true" /> Reading the chat file…</p>
      <p v-if="checkedStream.error" class="error" role="alert">{{ checkedStream.error }}</p>
      <p v-if="!countOk" class="error" role="alert">Ask for 1 to 20 clips.</p>
      <p v-if="!secondsOk" class="error" role="alert">The seconds before and after must each be between 1 and 120.</p>
      <p v-if="clipsError" class="error" role="alert">{{ clipsError }}</p>

      <div v-if="lastClips" class="result" :class="lastClips.status">
        <div v-if="isActive(lastClips)" class="row middle">
          <span class="fixed running"><span class="spinner" aria-hidden="true" /> {{ describe(lastClips) }}</span>
          <span />
          <button class="fixed small" :disabled="stopping" @click="stopClips"><Icon name="stop" /> {{ stopping ? 'Stopping…' : 'Stop' }}</button>
        </div>
        <template v-else-if="lastClips.status === 'done'">
          <p class="row middle done-line">
            <Icon name="check" class="fixed" />
            <span>
              {{ lastClips.result.clips.filter((clip) => clip.name).length }} clips from <strong>{{ lastClips.result.title }}</strong>
              ({{ lastClips.result.messages }} chat messages<template v-if="!/^tw\d+$/.test(lastClips.result.videoId ?? '')"> and {{ lastClips.result.comments ?? 0 }} comments</template> read)<template v-if="lastClips.result.words.length">;
                {{ lastClips.result.matched }} of them with {{ lastClips.result.words.join(' or ') }}</template>.
              <template v-if="lastClips.result.skipped">{{ lastClips.result.skipped }} {{ lastClips.result.skipped === 1 ? 'part' : 'parts' }} suggested before {{ lastClips.result.skipped === 1 ? 'was' : 'were' }} left out.</template>
            </span>
          </p>
          <p v-if="lastClips.result.words.length && lastClips.result.matched < lastClips.result.asked" class="muted">
            Only {{ lastClips.result.matched }} {{ lastClips.result.matched === 1 ? 'explosion was' : 'explosions were' }} with your words, so the rest are the biggest other explosions.
          </p>
          <p v-if="lastClips.result.clips.length < lastClips.result.asked && lastClips.result.skipped" class="notice">
            You asked for {{ lastClips.result.asked }}, but only {{ lastClips.result.clips.length }} new
            {{ lastClips.result.clips.length === 1 ? 'moment is' : 'moments are' }} left once the {{ lastClips.result.skipped }} parts suggested before are left out.
          </p>
          <p v-else-if="lastClips.result.clips.length < lastClips.result.asked" class="notice">
            You asked for {{ lastClips.result.asked }}, but only {{ lastClips.result.clips.length }}
            {{ lastClips.result.clips.length === 1 ? 'moment stood' : 'moments stood' }} out. Even with the loosest settings, a moment needs
            at least two people reacting at once, and this stream's chat has only {{ lastClips.result.messages }} messages<template v-if="(lastClips.result.comments ?? 0) < 10">
            and {{ lastClips.result.comments ?? 0 }} comments</template>. That is common when a streamer's main chat is on another site.
            For more clips from it, use "Suggested moments" on the cutting screen, which reads what is said in the video.
          </p>
          <ol class="clips">
            <li v-for="clip in lastClips.result.clips" :key="clip.start">
              <div class="row middle">
                <strong class="fixed numbers">{{ formatClock(clip.start) }}–{{ formatClock(clip.end) }}</strong>
                <span v-if="clip.label" class="chip mark fixed">{{ clip.label }}</span>
                <span v-for="where in clip.sources ?? ['chat']" :key="where" class="chip fixed">{{ where === 'comments' ? 'viewers pointed here' : 'chat reacted' }}</span>
                <span class="muted">
                  <template v-if="clip.reactions?.length">{{ clip.people }} people: {{ clip.reactions.map((one) => `${one.label} ${one.count}`).join(', ') }}</template>
                  <template v-if="clip.topWords?.length"> · “{{ clip.topWords.slice(0, 4).map((word) => word.word).join('”, “') }}”</template>
                </span>
                <button v-if="clip.name" class="fixed small" @click="emit('open', clip.name)"><Icon name="scissors" /> Open</button>
              </div>
              <p v-if="clip.comments" class="muted">Viewers: {{ clip.comments.texts.map((text) => `“${text}”`).join(' ') }}</p>
              <p v-if="clip.error" class="error">Not downloaded: {{ clip.error }}</p>
            </li>
          </ol>
        </template>
        <p v-else-if="lastClips.status === 'stopped'" class="row middle"><Icon name="stop" class="fixed" /> {{ describe(lastClips) }} The clips already downloaded are kept.</p>
        <p v-else class="error" role="alert">{{ describe(lastClips) }}</p>
      </div>
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
.after { margin-top: 10px; }
.error, .notice { margin-top: 10px; }
.running { display: inline-flex; align-items: center; gap: 8px; }
.result.done { border-color: var(--good); }
.panel .result { margin-top: 12px; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius); }
.tiny { flex: 0 1 90px; }
.chat-file { display: flex; flex-direction: column; gap: 4px; align-self: flex-end; }
.label-like { font-size: 13px; font-weight: 550; color: var(--muted); }
.more { margin-top: 8px; }
.more summary { cursor: pointer; font-size: 13px; color: var(--muted); }
.clips { list-style: none; padding: 0; margin: 8px 0 0; }
.clips li { padding: 6px 0; border-top: 1px solid var(--line); }
.clips li p { margin: 4px 0 0; }
.result.done .done-line .icon { color: var(--good); }
.result.failed { border-color: var(--bad); }
.done-line { gap: 8px; margin: 0 0 4px; }
.result .muted { margin: 0 0 12px; word-break: break-word; }
summary { cursor: pointer; font-weight: 600; }
.names { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
</style>
