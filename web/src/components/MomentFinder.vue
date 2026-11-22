<script setup>
// "Suggested moments" on the cutting screen: moments from the transcript (the AI
// reads what was said), from the chat (bursts of chat activity, found on this
// computer), or both merged into one list. Event terms and guidance steer both.
//
// The sums are the engine's own, imported here as the Combine page does with its
// layout: src/chat/spikes.js finds the chat moments, src/moments/merge.js merges
// and ranks. So the chat settings change the list at once, with nothing sent anywhere.
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { PRESETS } from '../../../src/chat/presets.js';
import { activitySeries, detectSpikes, SPIKE_DEFAULTS, windowActivity } from '../../../src/chat/spikes.js';
import { parseTermGroups } from '../../../src/chat/terms.js';
import { enrich, mergeMoments } from '../../../src/moments/merge.js';
import { api } from '../api.js';
import { clock } from '../format.js';
import { describe, isActive, jobs, track } from '../jobs.js';
import Icon from './Icon.vue';
import TrashButton from './TrashButton.vue';

const props = defineProps({
  video: { type: String, required: true },
  ai: { type: Object, default: null }, // { configured, service, model, help }
  brief: { type: String, default: '' },
  lang: { type: String, default: 'en' },
  maxSeconds: { type: Number, default: 60 },
  usedKey: { type: String, default: '' },
  cutKeys: { type: Array, default: () => [] },
});
const emit = defineEmits(['use', 'seek']);

// --- Settings, remembered in this browser (a convenience; nothing depends on it) ---
const SAVED = 'wlc-moment-settings';
function remembered() {
  try {
    return JSON.parse(localStorage.getItem(SAVED) ?? '{}') ?? {};
  } catch {
    return {};
  }
}
const kept = remembered();
const source = ref(['transcript', 'chat', 'both'].includes(kept.source) ? kept.source : 'transcript');
const count = ref(Number.isInteger(kept.count) ? kept.count : 5);
const guidance = ref(typeof kept.guidance === 'string' ? kept.guidance : '');
const groups = reactive(Array.isArray(kept.groups) ? kept.groups.map((group) => ({ label: String(group.label ?? ''), terms: (group.terms ?? []).map(String), draft: '' })) : []);
const termMode = ref(['off', 'boost', 'only'].includes(kept.termMode) ? kept.termMode : 'boost');
const aiCheck = ref(kept.aiCheck === true);
const donations = ref(false);
const spikeRatio = ref(Number(kept.spikeRatio) || SPIKE_DEFAULTS.spikeRatio);
const minMessages = ref(Number(kept.minMessages) || SPIKE_DEFAULTS.minMessages);
const preRoll = ref(Number.isFinite(kept.preRoll) ? kept.preRoll : SPIKE_DEFAULTS.preRollSeconds);
const postRoll = ref(Number.isFinite(kept.postRoll) ? kept.postRoll : SPIKE_DEFAULTS.postRollSeconds);
const askAgain = ref(false);
watch([source, count, guidance, groups, termMode, aiCheck, spikeRatio, minMessages, preRoll, postRoll], () => {
  try {
    localStorage.setItem(SAVED, JSON.stringify({
      source: source.value, count: count.value, guidance: guidance.value, groups: groups.map(({ label, terms }) => ({ label, terms })),
      termMode: termMode.value, aiCheck: aiCheck.value, spikeRatio: spikeRatio.value, minMessages: minMessages.value, preRoll: preRoll.value, postRoll: postRoll.value,
    }));
  } catch {
    // Storage may be off in this browser; the settings then last until the page closes.
  }
}, { deep: true });

// --- Event terms ---
function addGroup() {
  groups.push({ label: '', terms: [], draft: '' });
}
function addTerm(group) {
  for (const term of group.draft.split(',').map((one) => one.trim()).filter(Boolean)) if (!group.terms.includes(term)) group.terms.push(term);
  group.draft = '';
}
function loadPreset(id) {
  groups.splice(0, groups.length, ...PRESETS[id].groups.map((group) => ({ label: group.label, terms: [...group.terms], draft: '' })));
}
// The same check the server makes. An empty group being typed is left out until it has a word.
const checkedTerms = computed(() => {
  const filled = groups.filter((group) => group.label.trim() || group.terms.length > 0).map(({ label, terms }) => ({ label, terms }));
  try {
    return { groups: parseTermGroups(filled), error: '' };
  } catch (error) {
    return { groups: [], error: error.message };
  }
});
const terms = computed(() => checkedTerms.value.groups);

// --- The chat ---
const chatInfo = ref(null); // { chat, duration, suggested, downloaderInstalled }
const chatError = ref('');
const chatUrl = ref('');
const chatOffset = ref('0');
const confirmRemove = ref(false);
const chatJob = computed(() => jobs.list.find((job) => job.kind === 'chat' && isActive(job) && job.label === props.video));
const hasChat = computed(() => Boolean(chatInfo.value?.chat));
const messages = computed(() => chatInfo.value?.chat?.messages ?? []);
const duration = computed(() => chatInfo.value?.duration ?? 0);

function showChat(answer) {
  chatInfo.value = { ...chatInfo.value, ...answer };
  const offset = answer.chat?.offset ?? answer.suggested?.offset ?? 0;
  chatOffset.value = String(offset);
  if (!chatUrl.value) chatUrl.value = answer.chat?.origin?.kind === 'youtube' ? `https://www.youtube.com/watch?v=${answer.chat.origin.videoId}` : answer.suggested?.link ?? '';
}
async function loadChat() {
  try {
    showChat(await api.chat(props.video));
    chatError.value = '';
  } catch (error) {
    chatError.value = error.message;
  }
}
async function fetchChat() {
  chatError.value = '';
  try {
    await track(await api.fetchChat(props.video, { url: chatUrl.value, offset: Number(chatOffset.value) || 0 }));
    await loadChat();
  } catch (error) {
    chatError.value = error.message;
  }
}
const fileInput = ref(null);
async function importFile(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  chatError.value = '';
  try {
    showChat(await api.importChat(props.video, file.name, await file.text(), Number(chatOffset.value) || 0));
  } catch (error) {
    chatError.value = error.message;
  }
}
async function applyOffset() {
  chatError.value = '';
  const offset = Number(chatOffset.value);
  if (!Number.isFinite(offset)) {
    chatError.value = 'The offset must be a number of seconds.';
    return;
  }
  try {
    showChat(await api.setChatOffset(props.video, offset));
  } catch (error) {
    chatError.value = error.message;
  }
}
async function removeChat() {
  confirmRemove.value = false;
  try {
    await api.deleteChat(props.video);
    chatInfo.value = { ...chatInfo.value, chat: null };
    aiResults.value = {};
  } catch (error) {
    chatError.value = error.message;
  }
}
const offsetChanged = computed(() => hasChat.value && Number(chatOffset.value) !== chatInfo.value.chat.offset);

// The transcript, only if it was already made: never transcribed for the chat.
const words = ref(null);
async function loadWords() {
  try {
    words.value = (await api.keptTranscript(props.video, props.lang)).words;
  } catch {
    words.value = null;
  }
}
onMounted(() => {
  loadChat();
  loadWords();
});
watch(() => props.lang, loadWords);

// --- Which sources run ---
const transcriptReady = computed(() => Boolean(props.ai?.configured));
const usesTranscript = computed(() => source.value !== 'chat');
const usesChat = computed(() => source.value !== 'transcript' && hasChat.value);
const chatReason = computed(() => (hasChat.value ? '' : 'Bring in a chat below first: these need a chat replay.'));

const chatOptions = computed(() => ({
  duration: duration.value,
  terms: terms.value,
  termMode: terms.value.length > 0 ? termMode.value : 'off',
  spikeRatio: Number(spikeRatio.value) || SPIKE_DEFAULTS.spikeRatio,
  minMessages: Number(minMessages.value) || SPIKE_DEFAULTS.minMessages,
  preRollSeconds: Number(preRoll.value) || 0,
  postRollSeconds: Number(postRoll.value) || 0,
}));
const series = computed(() => (hasChat.value && duration.value > 0 ? activitySeries(messages.value, chatOptions.value) : null));

// The AI's verdicts on chat moments, by window. A changed setting gives new windows, which have none yet.
const aiResults = ref({});
const aiError = ref('');
const windowKey = (item) => `${item.start}-${item.end}`;
const chatCandidates = computed(() => {
  if (!usesChat.value || duration.value <= 0) return [];
  return detectSpikes(messages.value, chatOptions.value).map((candidate) => ({ ...candidate, ...(aiResults.value[windowKey(candidate)] ?? { ai: null, needsReview: false }) }));
});

const transcriptMoments = computed(() => (usesTranscript.value ? jobs.suggestions[props.video] ?? [] : []));
const suggestJob = computed(() => jobs.list.find((job) => job.kind === 'suggest' && isActive(job) && job.label === props.video));
const checkJob = computed(() => jobs.list.find((job) => job.kind === 'chat-check' && isActive(job) && job.label === props.video));
const runError = ref('');
watch(() => jobs.suggestions[props.video], loadWords);

async function findMoments() {
  runError.value = '';
  aiError.value = '';
  const waits = [];
  try {
    if (usesTranscript.value) {
      waits.push(track(await api.suggest({
        video: props.video, count: count.value || 5, brief: props.brief, lang: props.lang, terms: terms.value, guidance: guidance.value, force: askAgain.value,
      })));
    }
    if (usesChat.value && aiCheck.value && chatCandidates.value.length > 0) {
      const asked = chatCandidates.value.slice(0, 20);
      waits.push(track(await api.checkChat(props.video, {
        candidates: asked.map((candidate) => ({ start: candidate.start, end: candidate.end, label: candidate.label })),
        terms: terms.value, guidance: guidance.value, donations: donations.value, lang: props.lang,
      })).then((result) => {
        aiError.value = result.error ?? '';
        const next = { ...aiResults.value };
        asked.forEach((candidate, index) => (next[windowKey(candidate)] = result.results[index]));
        aiResults.value = next;
      }));
    }
    await Promise.all(waits);
  } catch (error) {
    runError.value = error.message;
  }
}
const canRun = computed(() => !checkedTerms.value.error && !suggestJob.value && !checkJob.value
  && ((usesTranscript.value && transcriptReady.value) || (usesChat.value && aiCheck.value && transcriptReady.value)));

// --- The one list ---
const merged = computed(() => enrich(
  mergeMoments(transcriptMoments.value, chatCandidates.value, { maxSeconds: props.maxSeconds }),
  { words: words.value ?? undefined, series: series.value ?? undefined, windowActivity },
));
// Times edited in the list, by the item's own window, so a new list keeps them where it can.
const edits = reactive({});
const shown = (item) => edits[windowKey(item)] ?? { start: item.start, end: item.end };
function edit(item, which, value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return;
  edits[windowKey(item)] = { ...shown(item), [which]: seconds };
}
const sourceFilter = ref('all');
const labelFilter = ref('all');
const labelsInList = computed(() => [...new Set(merged.value.flatMap((item) => [item.label, item.labels.transcript, item.labels.chat]).filter(Boolean))].sort());
const visible = computed(() => merged.value.filter((item) => {
  if (sourceFilter.value === 'both' && item.sources.length < 2) return false;
  if (['transcript', 'chat'].includes(sourceFilter.value) && !item.sources.includes(sourceFilter.value)) return false;
  if (labelFilter.value === 'none') return !item.label && !item.needsReview;
  if (labelFilter.value === 'review') return item.needsReview;
  if (labelFilter.value !== 'all') return item.label === labelFilter.value || item.labels.transcript === labelFilter.value || item.labels.chat === labelFilter.value;
  return true;
}));
// The marks above the cutting screen's timeline follow this list.
watch(visible, (list) => {
  jobs.momentMarks[props.video] = list.map((item) => ({ ...shown(item), reason: item.transcript?.reason ?? item.chat?.ai?.description ?? describeChat(item.chat) }));
}, { immediate: true });

function describeChat(chat) {
  if (!chat) return '';
  return `Chat burst: ${chat.messageCount} messages, ${chat.peakRatio.toFixed(1)}× the usual rate${chat.topWords.length ? `; ${chat.topWords.slice(0, 3).map((word) => word.word).join(', ')}` : ''}`;
}
const keyOfShown = (item) => `${shown(item).start}-${shown(item).end}`;
function send(item) {
  const { start, end } = shown(item);
  emit('use', {
    key: `${start}-${end}`, start, end,
    hook: item.transcript?.hook ?? '',
    title: item.transcript?.title ?? '',
    description: item.transcript?.description ?? item.chat?.ai?.description ?? '',
  });
}
const percentOf = (share) => `${Math.round(share * 100)}%`;

// --- The chart: chat per bucket, its usual level, the bursts, the terms, and the transcript's moments ---
const W = 1000;
const H = 120;
const chart = computed(() => {
  const data = series.value;
  if (!data || !usesChat.value) return null;
  const peak = Math.max(1, ...data.buckets.map((bucket) => bucket.count));
  const x = (t) => (t / duration.value) * W;
  const y = (n) => H - (n / peak) * (H - 14);
  const width = Math.max(0.6, x(data.bucketSeconds) - 0.4);
  return {
    peak,
    bars: data.buckets.map((bucket) => ({ x: x(bucket.t), y: y(bucket.count), h: H - y(bucket.count), w: width, spike: bucket.spike })),
    baseline: data.buckets.map((bucket) => `${x(bucket.t + data.bucketSeconds / 2).toFixed(1)},${y(bucket.baseline).toFixed(1)}`).join(' '),
    terms: Object.entries(data.termRates ?? {}).map(([label, rates], index) => ({
      label, dash: ['', '6 3', '2 3', '8 3 2 3', '1 2'][index % 5],
      points: rates.map((n, i) => `${x(data.buckets[i].t + data.bucketSeconds / 2).toFixed(1)},${y(n).toFixed(1)}`).join(' '),
    })),
    chat: chatCandidates.value.map((candidate) => ({ x: x(candidate.start), w: Math.max(1, x(candidate.end) - x(candidate.start)) })),
    transcript: transcriptMoments.value.map((moment) => ({ x: x(moment.start), w: Math.max(2, x(moment.end) - x(moment.start)) })),
  };
});
function seekChart(event) {
  const box = event.currentTarget.getBoundingClientRect();
  emit('seek', Math.max(0, Math.min(duration.value, ((event.clientX - box.left) / box.width) * duration.value)));
}
</script>

<template>
  <section class="panel finder">
    <h2><Icon name="spark" /> Suggested moments</h2>
    <p class="hint first">
      <template v-if="ai?.configured">
        From the transcript: transcribes the whole video on this computer, then sends the transcript text (not the video) to
        {{ ai.service }} ({{ ai.model }}). The first time on a video takes a few minutes.
      </template>
      <template v-else>From the transcript needs an AI service: {{ ai?.help }} Then restart the dashboard.</template>
      From the chat: finds bursts of chat activity on this computer, from a finished stream's chat replay, without transcribing.
      When the AI check is on, the chat messages of the candidate windows (their words and times, not who wrote them) are sent too.
    </p>

    <!-- Where the moments come from -->
    <div class="row middle sources">
      <span class="fixed label-like">Find moments from</span>
      <span class="choices fixed" role="group" aria-label="Find moments from">
        <button :aria-pressed="source === 'transcript'" @click="source = 'transcript'">Transcript</button>
        <button :aria-pressed="source === 'chat'" :disabled="!hasChat" :title="chatReason" @click="source = 'chat'">Chat</button>
        <button :aria-pressed="source === 'both'" :disabled="!hasChat" :title="chatReason" @click="source = 'both'">Both</button>
      </span>
      <span v-if="!hasChat" class="muted small-text">{{ chatReason }}</span>
    </div>
    <p v-if="source !== 'transcript' && !hasChat" class="notice">This video has no chat yet, so only the transcript can be used.</p>

    <!-- The chat replay -->
    <details class="block" :open="!hasChat && source !== 'transcript'">
      <summary>
        Chat
        <span v-if="hasChat" class="chip good">{{ chatInfo.chat.messages.length }} messages in this video</span>
        <span v-else class="chip">none yet</span>
      </summary>
      <p v-if="hasChat" class="hint">
        From {{ chatInfo.chat.origin.kind === 'youtube' ? `YouTube's chat replay of ${chatInfo.chat.origin.videoId}` : `the file ${chatInfo.chat.origin.name}` }},
        {{ chatInfo.chat.total }} messages in all. It stays on this computer.
      </p>
      <div class="row">
        <div class="wide">
          <label :for="`chat-url-${video}`">Chat replay of a finished stream</label>
          <input :id="`chat-url-${video}`" v-model="chatUrl" type="text" placeholder="https://www.youtube.com/watch?v=..." spellcheck="false" />
        </div>
        <button class="fixed" :disabled="!chatUrl.trim() || Boolean(chatJob) || chatInfo?.downloaderInstalled === false" @click="fetchChat">
          <Icon name="download" /> Fetch the chat
        </button>
      </div>
      <p class="hint">Only the chat is downloaded, never the video, and only from a channel in your Sources list.</p>
      <p v-if="chatJob" class="running" role="status"><span class="spinner" aria-hidden="true" /> {{ describe(chatJob) }}</p>
      <div class="row">
        <div class="narrow">
          <label :for="`chat-offset-${video}`">Offset, seconds</label>
          <input :id="`chat-offset-${video}`" v-model="chatOffset" type="text" inputmode="decimal" class="numbers" />
        </div>
        <button v-if="offsetChanged" class="fixed" @click="applyOffset">Use this offset</button>
        <button class="fixed" @click="fileInput.click()"><Icon name="plus" /> Import a chat file</button>
        <input ref="fileInput" type="file" accept=".json,.csv,application/json,text/csv" hidden @change="importFile" />
        <TrashButton v-if="hasChat && !confirmRemove" class="fixed" label="Remove this video's chat" @click="confirmRemove = true" />
      </div>
      <p class="hint">
        The offset is how far into the stream this video begins. For a part downloaded here it is filled in from its name
        (the part may begin a few seconds earlier, at a keyframe). A file is JSON or CSV with a time and a text for each message.
      </p>
      <div v-if="confirmRemove" class="confirm" role="alertdialog">
        <span>Remove this video's chat? The video stays. You can fetch or import it again.</span>
        <button class="small danger" @click="removeChat">Remove</button>
        <button class="small" @click="confirmRemove = false">Cancel</button>
      </div>
      <p v-if="chatError" class="error" role="alert">{{ chatError }}</p>
    </details>

    <!-- What to look for -->
    <details class="block" :open="groups.length > 0 || Boolean(guidance)">
      <summary>
        What to look for
        <span v-if="terms.length" class="chip mark">{{ terms.length }} {{ terms.length === 1 ? 'event' : 'events' }}</span>
        <span v-if="guidance.trim()" class="chip mark">guidance</span>
      </summary>
      <div class="row middle">
        <span class="fixed muted small-text">Load</span>
        <button v-for="(preset, id) in PRESETS" :key="id" class="fixed small" @click="loadPreset(id)">{{ preset.name }}</button>
        <button class="fixed small" @click="addGroup"><Icon name="plus" /> Event</button>
        <button v-if="groups.length" class="fixed small quiet" @click="groups.splice(0)">Clear</button>
      </div>
      <div v-for="(group, gi) in groups" :key="gi" class="group">
        <div class="row middle">
          <input v-model="group.label" type="text" class="fixed label-input" placeholder="Event, e.g. Goal" :aria-label="`Name of event ${gi + 1}`" />
          <span class="terms">
            <span v-for="(term, ti) in group.terms" :key="term" class="chip term">
              {{ term }}
              <button class="x" :aria-label="`Remove ${term}`" @click="group.terms.splice(ti, 1)"><Icon name="cross" /></button>
            </span>
            <input
              v-model="group.draft" type="text" class="draft" placeholder="add words, comma between"
              :aria-label="`Add words to ${group.label || `event ${gi + 1}`}`" @keydown.enter.prevent="addTerm(group)" @blur="addTerm(group)"
            />
          </span>
          <TrashButton class="fixed" :label="`Remove ${group.label || 'this event'}`" @click="groups.splice(gi, 1)" />
        </div>
      </div>
      <p v-if="checkedTerms.error" class="error" role="alert">{{ checkedTerms.error }}</p>
      <p class="hint">Words are matched whole, any case, accents and stretched letters aside: “GOOOOL” counts as “gol”, “pen” does not match “open”.</p>
      <label :for="`guidance-${video}`">Guidance</label>
      <textarea :id="`guidance-${video}`" v-model="guidance" rows="2" maxlength="500" placeholder="What a good moment is for this video, e.g. big reactions to goals and referee decisions" />
    </details>

    <!-- Chat settings: they change the chat moments at once -->
    <details v-if="usesChat" class="block" open>
      <summary>Chat settings</summary>
      <div class="row">
        <div class="narrow"><label :for="`ratio-${video}`">Burst: times the usual rate</label><input :id="`ratio-${video}`" v-model.number="spikeRatio" type="number" min="1" step="0.5" /></div>
        <div class="narrow"><label :for="`min-${video}`">Messages per {{ SPIKE_DEFAULTS.bucketSeconds }} s, at least</label><input :id="`min-${video}`" v-model.number="minMessages" type="number" min="1" step="1" /></div>
        <div class="narrow"><label :for="`pre-${video}`">Seconds before</label><input :id="`pre-${video}`" v-model.number="preRoll" type="number" min="0" step="1" /></div>
        <div class="narrow"><label :for="`post-${video}`">Seconds after</label><input :id="`post-${video}`" v-model.number="postRoll" type="number" min="0" step="1" /></div>
      </div>
      <div class="row middle">
        <div v-if="terms.length" class="fixed">
          <label :for="`mode-${video}`">Event words</label>
          <select :id="`mode-${video}`" v-model="termMode">
            <option value="boost">Raise moments with them</option>
            <option value="only">Only moments with them</option>
            <option value="off">Ignore them</option>
          </select>
        </div>
        <label class="check fixed" :title="transcriptReady ? '' : ai?.help"><input v-model="aiCheck" type="checkbox" :disabled="!transcriptReady" /> AI check of chat moments</label>
        <label v-if="aiCheck && !terms.length" class="check fixed"><input v-model="donations" type="checkbox" /> Allow “donation or raid”</label>
      </div>
      <p class="hint">A quiet chat may need fewer messages and a lower rate. The list below changes as you type.</p>
    </details>

    <figure v-if="chart" class="chart">
      <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" role="img" :aria-label="`Chat messages across the video, busiest ${chart.peak} per bucket`" @click="seekChart">
        <rect v-for="(window, i) in chart.chat" :key="`c${i}`" class="window" :x="window.x" y="0" :width="window.w" :height="H" />
        <rect v-for="(bar, i) in chart.bars" :key="`b${i}`" :class="bar.spike ? 'spike' : 'bar'" :x="bar.x" :y="bar.y" :width="bar.w" :height="bar.h" />
        <polyline class="baseline" :points="chart.baseline" />
        <polyline v-for="line in chart.terms" :key="line.label" class="term-line" :stroke-dasharray="line.dash" :points="line.points" />
        <rect v-for="(mark, i) in chart.transcript" :key="`t${i}`" class="said" :x="mark.x" y="0" :width="mark.w" height="7" />
      </svg>
      <figcaption>
        <span><i class="key bar" /> messages</span>
        <span><i class="key spike" /> burst</span>
        <span><i class="key baseline" /> usual rate</span>
        <span v-for="line in chart.terms" :key="line.label"><svg class="key-line" viewBox="0 0 20 4"><line x1="0" y1="2" x2="20" y2="2" :stroke-dasharray="line.dash" /></svg> {{ line.label }}</span>
        <span v-if="chart.transcript.length"><i class="key said" /> from the transcript</span>
        <span class="muted">Click to jump there.</span>
      </figcaption>
    </figure>

    <!-- Run -->
    <div class="row middle run">
      <div v-if="usesTranscript" class="fixed count">
        <label :for="`count-${video}`">How many</label>
        <input :id="`count-${video}`" v-model.number="count" type="number" min="1" max="10" />
      </div>
      <button class="fixed primary" :disabled="!canRun" @click="findMoments"><Icon name="spark" /> {{ usesTranscript ? 'Suggest moments' : 'Check with AI' }}</button>
      <label v-if="usesTranscript" class="check fixed"><input v-model="askAgain" type="checkbox" /> Ask again</label>
      <span v-if="suggestJob" role="status" class="running"><span class="spinner" aria-hidden="true" /> {{ describe(suggestJob) }}</span>
      <span v-if="checkJob" role="status" class="running"><span class="spinner" aria-hidden="true" /> {{ describe(checkJob) }}</span>
    </div>
    <p v-if="usesTranscript && !askAgain" class="hint">The same inputs give the answer kept from last time; tick “Ask again” for a new one.</p>
    <p v-if="runError" class="error" role="alert">{{ runError }}</p>
    <p v-if="aiError" class="notice">{{ aiError }}</p>

    <!-- The list -->
    <template v-if="merged.length > 0">
      <div class="row middle filters">
        <div class="fixed">
          <label :for="`fs-${video}`">Show</label>
          <select :id="`fs-${video}`" v-model="sourceFilter">
            <option value="all">All sources</option>
            <option value="both">Found by both</option>
            <option value="transcript">From the transcript</option>
            <option value="chat">From the chat</option>
          </select>
        </div>
        <div class="fixed">
          <label :for="`fl-${video}`">Label</label>
          <select :id="`fl-${video}`" v-model="labelFilter">
            <option value="all">Any label</option>
            <option v-for="label in labelsInList" :key="label" :value="label">{{ label }}</option>
            <option value="review">Needs review</option>
            <option value="none">No label</option>
          </select>
        </div>
        <span class="muted small-text">{{ visible.length }} of {{ merged.length }}</span>
      </div>
      <ol class="moments">
        <li v-for="(item, i) in visible" :key="windowKey(item)" :class="{ current: keyOfShown(item) === usedKey }" @click.self="emit('seek', shown(item).start)">
          <div class="row middle">
            <button class="fixed quiet numbers jump" :title="'Jump to its start'" @click="emit('seek', shown(item).start)"><strong>{{ i + 1 }}.</strong></button>
            <input class="fixed time numbers" type="number" min="0" step="0.1" :value="shown(item).start" :aria-label="`Start of moment ${i + 1}`" @change="edit(item, 'start', $event.target.value)" />
            <span class="fixed">–</span>
            <input class="fixed time numbers" type="number" min="0" step="0.1" :value="shown(item).end" :aria-label="`End of moment ${i + 1}`" @change="edit(item, 'end', $event.target.value)" />
            <span class="fixed muted numbers">{{ clock(shown(item).start) }} · {{ (shown(item).end - shown(item).start).toFixed(1) }} s · score {{ item.combined.toFixed(2) }}</span>
          </div>
          <div class="row middle tags">
            <span v-for="where in item.sources" :key="where" class="chip fixed">{{ where }}</span>
            <span v-if="item.label" class="chip mark fixed">{{ item.label }}</span>
            <span v-if="item.needsReview" class="chip warn fixed">needs review</span>
            <span v-if="cutKeys.includes(keyOfShown(item))" class="chip good fixed"><Icon name="check" /> Already cut</span>
            <span class="spacer" />
            <button class="fixed small" :class="{ primary: keyOfShown(item) === usedKey }" @click="send(item)">{{ keyOfShown(item) === usedKey ? 'In use' : 'Send to cut' }}</button>
          </div>
          <p v-if="item.needsReview" class="small-text">
            Transcript says <strong>{{ item.labels.transcript ?? 'none' }}</strong>, chat says <strong>{{ item.labels.chat ?? item.chat?.label ?? 'none' }}</strong><template v-if="item.chat?.ai?.label && item.chat.label && item.chat.ai.label !== item.chat.label">; the AI says <strong>{{ item.chat.ai.label }}</strong>, the words say <strong>{{ item.chat.label }}</strong></template>.
          </p>
          <template v-if="item.transcript">
            <p>{{ item.transcript.reason }}</p>
            <p v-if="item.transcript.hook" class="muted">Hook: “{{ item.transcript.hook }}”</p>
            <p v-if="item.transcript.matchedTerms" class="muted">Heard: {{ item.transcript.matchedTerms.join(', ') }}</p>
            <p v-for="found in item.transcript.problems" :key="found" class="fail">Brief: {{ found }}</p>
          </template>
          <template v-if="item.chat">
            <p class="muted">
              Chat: {{ item.chat.messageCount }} messages, {{ item.chat.peakRatio.toFixed(1) }}× the usual rate<template v-if="item.chat.topWords.length">; {{ item.chat.topWords.slice(0, 6).map((word) => word.word).join(', ') }}</template>
              <template v-for="(share, label) in item.chat.termShares" :key="label"><template v-if="share > 0">; {{ label }} {{ percentOf(share) }}</template></template>
            </p>
            <p v-if="item.chat.ai" class="muted">
              AI: {{ item.chat.ai.label ?? 'no label' }} ({{ percentOf(item.chat.ai.confidence) }} sure)<template v-if="item.chat.ai.description">: {{ item.chat.ai.description }}</template>
            </p>
          </template>
          <p v-if="item.chatActivity" class="muted">Chat here: {{ item.chatActivity.messages }} messages, {{ item.chatActivity.ratio.toFixed(1) }}× the usual rate</p>
          <p v-if="item.lines?.length" class="said-lines muted">Said: {{ item.lines.map((line) => line.text).join(' ') }}</p>
        </li>
      </ol>
    </template>
    <p v-else-if="usesChat && chatCandidates.length === 0 && !usesTranscript" class="muted">No bursts with these settings. Try a lower rate or fewer messages.</p>
    <p v-else-if="usesTranscript && video in jobs.suggestions && merged.length === 0" class="muted">No usable moments came back. Try again.</p>
  </section>
</template>

<style scoped>
.first { margin: 6px 0 12px; }
.small-text { font-size: 13px; }
.label-like { font-size: 13px; font-weight: 550; color: var(--muted); }
.sources { margin-bottom: 8px; }
.block { border-top: 1px solid var(--line); padding: 10px 0 4px; }
.block > summary { cursor: pointer; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.block .row { margin-top: 8px; }
.wide { flex: 3 1 240px; }
.narrow { flex: 1 1 110px; }
.group { margin-top: 6px; }
.label-input { width: 150px; }
.terms { flex: 1 1 200px; display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.term { padding-right: 2px; }
.term .x { min-height: 0; padding: 0 2px; border: 0; background: transparent; color: inherit; }
.term .x .icon { width: 12px; height: 12px; }
.draft { flex: 1 1 140px; min-width: 120px; }
textarea { width: 100%; resize: vertical; font: inherit; }
.chart { margin: 12px 0 0; }
.chart > svg { width: 100%; height: 120px; display: block; cursor: pointer; background: var(--soft); border-radius: var(--radius); }
.chart .bar { fill: var(--line-strong); }
.chart .spike { fill: var(--accent); }
.chart .window { fill: var(--accent-tint); }
.chart .said { fill: var(--highlight); }
.chart .baseline { fill: none; stroke: var(--muted); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.chart .term-line { fill: none; stroke: var(--text); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
figcaption { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 6px; font-size: 12px; align-items: center; }
figcaption span { display: inline-flex; align-items: center; gap: 5px; }
.key { display: inline-block; width: 12px; height: 10px; border-radius: 2px; }
.key.bar { background: var(--line-strong); }
.key.spike { background: var(--accent); }
.key.said { background: var(--highlight); }
.key.baseline { height: 2px; background: var(--muted); }
.key-line { width: 20px; height: 4px; }
.key-line line { stroke: var(--text); stroke-width: 2; }
.run { margin-top: 12px; }
.count input { width: 70px; }
.running { display: inline-flex; align-items: center; gap: 8px; }
.filters { margin-top: 12px; }
.moments { list-style: none; padding: 0; margin: 10px 0 0; }
.moments li { border: 1px solid var(--line); border-radius: var(--radius); padding: 8px 10px; margin-top: 8px; }
.moments li.current { border-color: var(--accent); background: var(--accent-tint); }
.moments li p { margin: 4px 0 0; }
.moments .row { gap: 6px; flex-wrap: nowrap; }
.moments .row.tags { flex-wrap: wrap; margin-top: 6px; }
.time { width: 84px; }
.jump { min-height: 28px; padding: 2px 6px; }
.spacer { flex: 1 1 0; }
.said-lines { font-style: italic; }
</style>
