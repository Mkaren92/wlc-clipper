<script setup>
// One finished clip: watch it, see how it did against its brief, copy the
// post text, and fix caption words.
import { computed, onUnmounted, ref } from 'vue';
import { api } from '../api.js';
import { clock } from '../format.js';
import { describe, isActive, jobs, track } from '../jobs.js';

const props = defineProps({ name: { type: String, required: true } });
const emit = defineEmits(['changed']);

const clip = ref(null);
const checks = ref([]);
const words = ref([]);
const postText = ref('');
const error = ref('');
const note = ref('');
// A render in progress is kept in jobs.js, so it still shows after leaving
// this screen and coming back.
let onScreen = true;
onUnmounted(() => (onScreen = false));
const renderJob = computed(() => jobs.list.find((j) => j.kind === 'render' && isActive(j) && j.label === props.name));
const job = computed(() => ({ running: Boolean(renderJob.value) }));

// AI word fixes: proposals are typed into the word boxes for review, and
// nothing is saved until "Save words and render again" is pressed.
const ai = ref(null);
const fixing = ref(false);
const fixNote = ref('');
api.ai().then((answer) => (ai.value = answer), () => {});

async function suggestFixes() {
  fixing.value = true;
  fixNote.value = '';
  try {
    const { fixes } = await api.fixWords(props.name);
    for (const fix of fixes) {
      if (words.value[fix.index]) words.value[fix.index].text = fix.to;
    }
    fixNote.value = fixes.length === 0
      ? 'No likely mistakes were found.'
      : `${fixes.length} ${fixes.length === 1 ? 'word was' : 'words were'} changed and marked. Check them, then save.`;
  } catch (e) {
    error.value = e.message;
  }
  fixing.value = false;
}
const original = (i) => clip.value.transcript.words[i]?.text;

async function load() {
  try {
    clip.value = await api.clip(props.name);
    checks.value = clip.value.meta.checks;
    words.value = (clip.value.transcript?.words ?? []).map((word) => ({ ...word }));
    postText.value = clip.value.postText ?? '';
    error.value = '';
  } catch (e) {
    error.value = e.message;
  }
}
load();

const meta = computed(() => clip.value.meta);
const brief = computed(() => meta.value.brief);
const toDo = computed(() => {
  if (!brief.value) return [];
  const list = [...brief.value.manualChecks];
  if (brief.value.platforms.length > 0) list.unshift(`Post to: ${brief.value.platforms.join(', ')}`);
  return list;
});
const wordsChanged = computed(() =>
  words.value.some((word, i) => word.text !== clip.value.transcript.words[i]?.text),
);
const postChanged = computed(() => postText.value !== (clip.value.postText ?? ''));

async function copy(text, what) {
  await navigator.clipboard.writeText(text);
  note.value = `Copied ${what}.`;
  setTimeout(() => (note.value = ''), 2000);
}
// post.txt is the title, a blank line, then the description and hashtags.
const postTitle = computed(() => postText.value.split('\n')[0]);
const postRest = computed(() => postText.value.split('\n').slice(1).join('\n').trim());

async function savePost() {
  try {
    // The server checks the clip again as it saves, so the reload shows the new result.
    await api.savePost(props.name, postText.value);
    await load();
    emit('changed');
  } catch (e) {
    error.value = e.message;
  }
}

// Save the corrected words (empty ones are dropped), then render again.
async function saveWords() {
  try {
    const kept = words.value.filter((word) => word.text.trim() !== '').map((word) => ({ ...word, text: word.text.trim() }));
    await api.saveTranscript(props.name, { ...clip.value.transcript, words: kept });
    await render();
  } catch (e) {
    error.value = e.message;
  }
}

async function render() {
  try {
    await track(await api.render(props.name));
    if (!onScreen) return;
    await load();
    emit('changed');
  } catch (e) {
    error.value = e.message;
  }
}
</script>

<template>
  <p v-if="error" class="error" role="alert">{{ error }}</p>

  <div v-if="clip" class="clip">
    <div class="player">
      <video
        v-if="clip.version" :key="clip.version" :src="api.clipUrl(name, clip.version)" controls playsinline
      />
      <p v-else class="notice">This clip has not been rendered yet.</p>
    </div>

    <div class="stack">
      <section class="panel">
        <h2>{{ name }}</h2>
        <p class="muted">
          From {{ meta.source.split('/').pop() }}, {{ clock(meta.start) }}–{{ clock(meta.end) }}, layout {{ meta.layout }}.
          <span v-if="meta.output">
            {{ meta.output.seconds.toFixed(1) }} s,
            {{ meta.captions ? `${meta.output.captionGroups} caption lines` : 'no captions' }}.
          </span>
        </p>
        <p v-if="meta.hook" class="muted">Hook: “{{ meta.hook }}”</p>
        <div class="row">
          <button class="fixed" :disabled="job.running" @click="render">Render again</button>
          <span v-if="renderJob" role="status">{{ describe(renderJob) }}</span>
        </div>
      </section>

      <section v-if="brief" class="panel">
        <h2>Checks against “{{ brief.id }}”</h2>
        <ul class="plain">
          <li v-for="check in checks" :key="check.rule">
            <span :class="check.pass ? 'pass' : 'fail'">{{ check.pass ? 'Pass' : 'Fail' }}</span>
            {{ check.rule }}<span v-if="!check.pass">: {{ check.detail }}</span>
          </li>
        </ul>
        <template v-if="toDo.length > 0">
          <h3>To do by hand</h3>
          <ul class="plain">
            <li v-for="item in toDo" :key="item"><label class="todo"><input type="checkbox" /> {{ item }}</label></li>
          </ul>
        </template>
      </section>

      <section v-if="clip.postText !== null" class="panel">
        <h2>Post text</h2>
        <textarea v-model="postText" rows="6" aria-label="Post text" />
        <div class="row actions">
          <button class="fixed" @click="copy(postTitle, 'the title')">Copy title</button>
          <button class="fixed" @click="copy(postRest, 'the description and hashtags')">Copy description and hashtags</button>
          <button class="fixed" :disabled="!postChanged" @click="savePost">{{ brief ? 'Save and check again' : 'Save' }}</button>
          <span role="status" class="muted">{{ note }}</span>
        </div>
      </section>

      <section v-if="clip.transcript" class="panel">
        <h2>Captions</h2>
        <p class="muted">Fix any word the transcriber got wrong, then save. Clear a word to remove it.</p>
        <div class="words">
          <input
            v-for="(word, i) in words" :key="i" v-model="word.text" type="text" class="word"
            :class="{ changed: word.text !== original(i) }"
            :style="{ width: `${Math.max(2, word.text.length) + 2}ch` }"
            :title="word.text !== original(i) ? `Was: ${original(i)}` : `${clock(word.start)}–${clock(word.end)}`"
            :aria-label="`Word ${i + 1}`"
          />
        </div>
        <div class="row actions">
          <button class="fixed primary" :disabled="!wordsChanged || job.running" @click="saveWords">
            Save words and render again
          </button>
          <button v-if="ai?.configured" class="fixed" :disabled="fixing || job.running" @click="suggestFixes">
            {{ fixing ? 'Asking…' : 'Suggest fixes' }}
          </button>
          <span role="status" class="muted">{{ fixNote }}</span>
        </div>
        <p v-if="ai?.configured" class="muted hint">
          “Suggest fixes” sends these words to {{ ai.service }} and marks what it would change. Hover a marked word to see
          the original.
        </p>
      </section>
      <p v-else class="muted">This clip has no captions.</p>
    </div>
  </div>
</template>

<style scoped>
.clip { display: grid; grid-template-columns: minmax(220px, 320px) 1fr; gap: 20px; align-items: start; }
.player video { width: 100%; aspect-ratio: 9 / 16; background: #000; border-radius: 8px; display: block; }
.plain { list-style: none; margin: 0 0 10px; padding: 0; }
.plain li { padding: 2px 0; }
.todo { color: var(--text); font-size: 15px; }
.actions { margin-top: 10px; align-items: center; }
.words { display: flex; flex-wrap: wrap; gap: 4px; }
.word { width: auto; padding: 3px 5px; font-size: 14px; }
.word.changed { border-color: #e8a020; background: var(--warn-bg); }
.hint { margin-top: 8px; font-size: 13px; }
@media (max-width: 800px) { .clip { grid-template-columns: 1fr; } }
</style>
