<script setup>
// One finished clip: watch it, see how it did against its brief, copy the
// post text, and fix caption words.
import { computed, onUnmounted, ref } from 'vue';
import { api } from '../api.js';
import { clock } from '../format.js';
import { describe, isActive, jobs, track } from '../jobs.js';
import Icon from './Icon.vue';

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
const failed = computed(() => checks.value.filter((check) => !check.pass).length);
const toDo = computed(() => {
  if (!brief.value) return [];
  const list = [...brief.value.manualChecks];
  if (brief.value.platforms.length > 0) list.unshift(`Post to: ${brief.value.platforms.join(', ')}`);
  return list;
});
const changedWords = computed(() => words.value.filter((word, i) => word.text !== clip.value.transcript.words[i]?.text).length);
const wordsChanged = computed(() => changedWords.value > 0);
const postChanged = computed(() => postText.value !== (clip.value.postText ?? ''));

async function copy(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    note.value = `Copied ${what}.`;
  } catch {
    note.value = 'The browser did not allow copying. Select the text and copy it by hand.';
  }
  setTimeout(() => (note.value = ''), 2500);
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
    const started = await api.render(props.name);
    await track(started);
    if (!onScreen) return;
    // The new render is on this screen already, so the side column need not announce it.
    jobs.dismissed.push(started.id);
    await load();
    emit('changed');
  } catch (e) {
    error.value = e.message;
  }
}
</script>

<template>
  <p v-if="error" class="error" role="alert">{{ error }}</p>

  <div v-if="clip">
    <header class="page-head">
      <h1>{{ name }}</h1>
      <p class="facts">
        <span class="chip">{{ meta.source.split('/').pop() }} · {{ clock(meta.start) }}–{{ clock(meta.end) }}</span>
        <span class="chip">{{ meta.layout }} layout</span>
        <template v-if="meta.output">
          <span class="chip">{{ meta.output.seconds.toFixed(1) }} s</span>
          <span class="chip">{{ meta.captions ? `${meta.output.captionGroups} caption lines` : 'no captions' }}</span>
        </template>
        <span v-if="brief && failed === 0" class="chip good"><Icon name="check" /> all {{ checks.length }} checks passed</span>
        <span v-else-if="brief" class="chip bad"><Icon name="alert" /> {{ failed }} of {{ checks.length }} checks failed</span>
      </p>
      <p v-if="meta.hook">Hook: “{{ meta.hook }}”</p>
      <p v-if="meta.tag">Channel tag: {{ meta.tag.toUpperCase() }}</p>
    </header>

    <div class="clip">
      <section class="panel player" aria-label="The clip">
        <video
          v-if="clip.version" :key="clip.version" :src="api.clipUrl(name, clip.version)" controls playsinline
        />
        <p v-else class="notice">This clip has not been rendered yet.</p>
        <div class="actions">
          <a v-if="clip.version" class="button primary" :href="api.clipUrl(name, clip.version)" :download="`${name}.mp4`">
            <Icon name="download" /> Download
          </a>
          <button :disabled="job.running" @click="render"><Icon name="refresh" /> Render again</button>
        </div>
        <p v-if="renderJob" class="running" role="status"><span class="spinner" aria-hidden="true" /> {{ describe(renderJob) }}</p>
        <p class="hint">The file is <code>out/{{ name }}/clip.mp4</code>.</p>
      </section>

      <div class="stack">
        <section v-if="brief" class="panel">
          <h2>Checks against “{{ brief.id }}”</h2>
          <ul class="checks">
            <li v-for="check in checks" :key="check.rule" :class="check.pass ? 'passed' : 'failed'">
              <Icon :name="check.pass ? 'check' : 'cross'" />
              <span>
                <strong>{{ check.rule }}</strong>
                <span class="sr">{{ check.pass ? ' passed' : ' failed' }}</span>
                <span v-if="!check.pass" class="why">{{ check.detail }}</span>
              </span>
            </li>
          </ul>
          <template v-if="toDo.length > 0">
            <h3>To do by hand</h3>
            <ul class="todo">
              <li v-for="item in toDo" :key="item"><label class="check"><input type="checkbox" /> {{ item }}</label></li>
            </ul>
          </template>
        </section>

        <section v-if="clip.postText !== null" class="panel">
          <h2>Post text</h2>
          <textarea v-model="postText" rows="6" aria-label="Post text" />
          <p class="hint">The first line is the title. The rest is the description and hashtags.</p>
          <div class="row middle actions">
            <button class="fixed" @click="copy(postTitle, 'the title')"><Icon name="copy" /> Copy title</button>
            <button class="fixed" @click="copy(postRest, 'the description and hashtags')"><Icon name="copy" /> Copy description and hashtags</button>
            <button class="fixed" :class="{ primary: postChanged }" :disabled="!postChanged" @click="savePost">{{ brief ? 'Save and check again' : 'Save' }}</button>
            <span role="status" class="muted">{{ note }}</span>
          </div>
        </section>

        <section v-if="clip.transcript" class="panel">
          <h2>Captions</h2>
          <p class="hint first">Fix any word the transcriber got wrong, then save. Clear a word to remove it.</p>
          <div class="words">
            <input
              v-for="(word, i) in words" :key="i" v-model="word.text" type="text" class="word"
              :class="{ changed: word.text !== original(i) }"
              :style="{ width: `${Math.max(2, word.text.length) + 3}ch` }"
              :title="word.text !== original(i) ? `Was: ${original(i)}` : `${clock(word.start)}–${clock(word.end)}`"
              :aria-label="`Word ${i + 1}`"
            />
          </div>
          <div class="row middle actions">
            <button class="fixed primary" :disabled="!wordsChanged || job.running" @click="saveWords">
              Save words and render again
            </button>
            <button v-if="ai?.configured" class="fixed" :disabled="fixing || job.running" @click="suggestFixes">
              <Icon name="spark" /> {{ fixing ? 'Asking…' : 'Suggest fixes' }}
            </button>
            <span v-if="wordsChanged" class="chip warn">{{ changedWords }} changed, not saved</span>
            <span role="status" class="muted">{{ fixNote }}</span>
          </div>
          <p v-if="ai?.configured" class="hint">
            “Suggest fixes” sends these words to {{ ai.service }} and marks what it would change. Hover a marked word to see
            the original.
          </p>
        </section>
        <p v-else class="empty">This clip has no captions.</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.facts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.clip { display: grid; grid-template-columns: minmax(240px, 340px) minmax(0, 1fr); gap: var(--gap); align-items: start; }
.player { position: sticky; top: 16px; }
/* A clip is tall. It is held to the height of the screen, so the buttons under it stay in view. */
.player video {
  width: 100%; max-width: calc(max(240px, 100vh - 330px) * 9 / 16); margin: 0 auto;
  aspect-ratio: 9 / 16; background: black; border-radius: var(--radius); display: block;
}
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; align-items: center; }
/* A link that is a button: the download. */
a.button {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 36px; padding: 6px 14px;
  border-radius: var(--radius); background: var(--accent); color: var(--accent-text); font-weight: 650; text-decoration: none;
}
a.button:hover { background: var(--accent-hover); color: var(--accent-text); }
.running { display: flex; align-items: center; gap: 8px; margin: 10px 0 0; }

.checks, .todo { list-style: none; margin: 0; padding: 0; }
.checks li { display: flex; gap: 10px; align-items: flex-start; padding: 7px 10px; border-radius: var(--radius); }
.checks li + li { margin-top: 4px; }
.checks .icon { margin-top: 3px; }
.checks .passed { background: var(--good-bg); }
.checks .passed .icon { color: var(--good); }
.checks .failed { background: var(--bad-bg); }
.checks .failed .icon { color: var(--bad); }
.why { display: block; color: var(--bad); }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
h3 { margin-top: 16px; }
.todo li { padding: 3px 0; }

.first { margin: 0 0 10px; }
.words { display: flex; flex-wrap: wrap; gap: 5px; }
.word { width: auto; min-height: 30px; padding: 2px 6px; font-size: 14px; }
.word.changed { border-color: var(--warn); background: var(--warn-bg); box-shadow: inset 0 0 0 1px var(--warn); }
@media (max-width: 800px) { .clip { grid-template-columns: 1fr; } .player { position: static; } }
</style>
