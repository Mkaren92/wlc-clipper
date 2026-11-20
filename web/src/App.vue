<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { api } from './api.js';
import ClipView from './components/ClipView.vue';
import Icon from './components/Icon.vue';
import NewClip from './components/NewClip.vue';
import TrashButton from './components/TrashButton.vue';
import CardMaker from './pages/CardMaker.vue';
import Combiner from './pages/Combiner.vue';
import CompilationBuilder from './pages/CompilationBuilder.vue';
import Sources from './pages/Sources.vue';
import { clock, fileSize } from './format.js';
import { describe, isActive, jobs, refresh as refreshJobs, visibleJobs } from './jobs.js';
import { applyPalette, PALETTES, savedPalette } from './theme.js';

const videos = ref([]);
const clips = ref([]);
const parts = ref([]);
const briefs = ref([]);
const error = ref('');
const loaded = ref(false);

// Which page is open. Kept in the address after #, so a reload stays on it.
const PAGES = [
  { id: 'clips', name: 'Clips', icon: 'scissors' },
  { id: 'cards', name: 'Cards', icon: 'card', title: 'Match cards', about: 'Still cards shown between reaction clips: a goal, a red card, the final score. Saved per match, and used on the Compilations page.' },
  { id: 'combine', name: 'Combine', icon: 'split', title: 'Combine two videos', about: 'Put a reaction and the thing reacted to side by side, line them up by eye, and make one video of the two to use in a compilation.' },
  { id: 'compilations', name: 'Compilations', icon: 'layers', title: 'Compilations', about: 'Put videos and cards in order and make one video out of them, with credits and a description file.' },
  { id: 'sources', name: 'Sources', icon: 'link', title: 'Sources', about: 'The channels that have agreed to let you use their videos, and the place to fetch part of a video from one of them.' },
];
const isPage = (id) => PAGES.some((known) => known.id === id);
const page = ref(isPage(location.hash.slice(1)) ? location.hash.slice(1) : 'clips');
const current = computed(() => PAGES.find((known) => known.id === page.value));
function go(id) {
  page.value = id;
  location.hash = id;
}
// Follow the address when it changes without a reload: a link, or Back and Forward.
const onHash = () => {
  if (isPage(location.hash.slice(1))) page.value = location.hash.slice(1);
};
window.addEventListener('hashchange', onHash);

// What the main area shows: a video to cut from, or a finished clip.
const view = ref({ kind: 'none' });

// The browser tab says where you are.
watch([page, view], () => {
  const where = page.value === 'clips' ? view.value.name ?? 'Clips' : current.value.name;
  document.title = `${where} · WLC Clipper`;
}, { immediate: true });

// The colours. The choice is remembered on this computer.
const palette = ref(savedPalette());
watch(palette, (id) => applyPalette(id));

async function refresh() {
  try {
    [videos.value, clips.value, briefs.value, parts.value] = await Promise.all([api.videos(), api.clips(), api.briefs(), api.parts()]);
    error.value = '';
  } catch (e) {
    error.value = e.message;
  }
  loaded.value = true;
}

// Deleting asks once, in place, because it cannot be undone. Escape takes the question away.
const confirming = ref('');
const onKey = (event) => {
  if (event.key === 'Escape') confirming.value = '';
};
window.addEventListener('keydown', onKey);
onUnmounted(() => {
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('hashchange', onHash);
});

const firstVideo = () => (videos.value.length > 0 ? { kind: 'video', name: videos.value[0].name } : { kind: 'none' });

async function deleteClip(name) {
  try {
    await api.deleteClip(name);
    confirming.value = '';
    // If the deleted clip was on screen, go back to a source video.
    if (view.value.kind === 'clip' && view.value.name === name) view.value = firstVideo();
    await refresh();
  } catch (e) {
    confirming.value = '';
    error.value = e.message;
  }
}

async function deleteVideo(name) {
  try {
    await api.deleteVideo(name);
    confirming.value = '';
    await refresh();
    // If the deleted video was on screen, show another one.
    if (view.value.kind === 'video' && view.value.name === name) view.value = firstVideo();
  } catch (e) {
    confirming.value = '';
    error.value = e.message;
  }
}
// How many clips were cut from a video: they lose the ability to be rendered again when it goes.
const clipsFrom = (name) => clips.value.filter((clip) => clip.source === name).length;

async function deletePart(name) {
  try {
    await api.deletePart(name);
    confirming.value = '';
    if (view.value.kind === 'part' && view.value.name === name) view.value = firstVideo();
    await refresh();
  } catch (e) {
    confirming.value = '';
    error.value = e.message;
  }
}

async function openClip(name) {
  await refresh();
  view.value = { kind: 'clip', name };
}

// A job that finishes may have made or changed a clip, so the lists are read again.
watch(() => jobs.list.filter((job) => !isActive(job)).length, refresh);

// Where a finished job's notice leads.
function openJob(job) {
  jobs.dismissed.push(job.id);
  if (job.kind === 'compile') return go('compilations');
  if (job.kind === 'combine') return go('combine');
  if (job.kind === 'pictures' || job.kind === 'channel') return go('sources');
  go('clips');
  if (job.kind === 'fetch') return refresh().then(() => (view.value = { kind: 'video', name: job.result.name }));
  if (job.kind === 'suggest') view.value = { kind: 'video', name: job.label };
  else if (job.kind === 'part') view.value = { kind: 'part', name: job.result.name };
  else openClip(job.kind === 'cut' ? job.result.clip : job.label);
}

onMounted(async () => {
  refreshJobs();
  await refresh();
  view.value = firstVideo();
});
</script>

<template>
  <div class="layout">
    <aside>
      <div class="brand">
        <span class="logo" aria-hidden="true"><Icon name="scissors" /></span>
        <h1>WLC Clipper</h1>
      </div>

      <nav aria-label="Pages">
        <button
          v-for="p in PAGES" :key="p.id" :class="{ current: page === p.id }"
          :aria-current="page === p.id ? 'page' : undefined" @click="go(p.id)"
        >
          <Icon :name="p.icon" /> {{ p.name }}
        </button>
      </nav>

      <!-- Work going on, and work just finished. It is here on every page. -->
      <section v-if="visibleJobs().length > 0" class="activity" aria-live="polite">
        <h3>Activity</h3>
        <ul>
          <li v-for="job in visibleJobs()" :key="job.id" :class="job.status">
            <span v-if="isActive(job)" class="spinner" aria-hidden="true" />
            <Icon v-else :name="job.status === 'done' ? 'check' : 'alert'" />
            <span class="text">{{ describe(job) }}</span>
            <span v-if="!isActive(job)" class="buttons">
              <button v-if="job.status === 'done'" class="small primary" @click="openJob(job)">
                {{ job.kind === 'suggest' ? 'Show' : 'Open' }}
              </button>
              <button class="small" @click="jobs.dismissed.push(job.id)">Close</button>
            </span>
          </li>
        </ul>
      </section>

      <div v-if="page === 'clips'" class="lists">
        <section>
          <h3>Videos <span class="count">{{ videos.length }}</span></h3>
          <p v-if="loaded && videos.length === 0" class="empty">
            No videos yet. Put files in the <code>in</code> folder and reload, or fetch one on the Sources page.
          </p>
          <div v-for="video in videos" :key="video.name" class="item-row">
            <button
              class="item" :class="{ current: view.kind === 'video' && view.name === video.name }"
              :aria-current="view.kind === 'video' && view.name === video.name ? 'true' : undefined"
              @click="view = { kind: 'video', name: video.name }"
            >
              <span class="name">{{ video.name }}</span>
              <span class="detail">{{ fileSize(video.size) }}</span>
            </button>
            <TrashButton v-if="confirming !== `video:${video.name}`" :label="`Delete ${video.name}`" @click="confirming = `video:${video.name}`" />
            <div v-else class="confirm" role="alertdialog" :aria-label="`Delete ${video.name}?`">
              <span>
                Delete {{ video.name }} from your videos? This cannot be undone.
                <template v-if="clipsFrom(video.name) > 0">
                  {{ clipsFrom(video.name) === 1 ? '1 clip was cut from it. It stays' : `${clipsFrom(video.name)} clips were cut from it. They stay` }},
                  but can no longer be rendered again or have caption words fixed.
                </template>
              </span>
              <button class="small danger" @click="deleteVideo(video.name)">Delete</button>
              <button class="small" @click="confirming = ''">Cancel</button>
            </div>
          </div>
        </section>

        <section>
          <h3>Clips <span class="count">{{ clips.length }}</span></h3>
          <p v-if="loaded && clips.length === 0" class="empty">Clips you cut appear here.</p>
          <div v-for="clip in clips" :key="clip.name" class="item-row">
            <button
              class="item" :class="{ current: view.kind === 'clip' && view.name === clip.name }"
              :aria-current="view.kind === 'clip' && view.name === clip.name ? 'true' : undefined"
              @click="view = { kind: 'clip', name: clip.name }"
            >
              <span class="name">{{ clip.name }}</span>
              <span class="detail">{{ clip.source }} · {{ clock(clip.start) }}–{{ clock(clip.end) }}</span>
              <span v-if="clip.failedChecks > 0" class="chip bad">{{ clip.failedChecks }} failed</span>
            </button>
            <TrashButton v-if="confirming !== clip.name" :label="`Delete ${clip.name}`" @click="confirming = clip.name" />
            <div v-else class="confirm" role="alertdialog" :aria-label="`Delete ${clip.name}?`">
              <span>Delete {{ clip.name }} and its files? This cannot be undone.</span>
              <button class="small danger" @click="deleteClip(clip.name)">Delete</button>
              <button class="small" @click="confirming = ''">Cancel</button>
            </div>
          </div>
        </section>

        <section>
          <h3>Parts <span class="count">{{ parts.length }}</span></h3>
          <p v-if="loaded && parts.length === 0" class="empty">Parts saved as they are, at the original size, appear here.</p>
          <div v-for="part in parts" :key="part.name" class="item-row">
            <button
              class="item" :class="{ current: view.kind === 'part' && view.name === part.name }"
              :aria-current="view.kind === 'part' && view.name === part.name ? 'true' : undefined"
              @click="view = { kind: 'part', name: part.name }"
            >
              <span class="name">{{ part.name }}</span>
              <span class="detail">{{ fileSize(part.size) }}</span>
            </button>
            <TrashButton v-if="confirming !== `part:${part.name}`" :label="`Delete ${part.name}`" @click="confirming = `part:${part.name}`" />
            <div v-else class="confirm" role="alertdialog" :aria-label="`Delete ${part.name}?`">
              <span>Delete {{ part.name }}? This cannot be undone.</span>
              <button class="small danger" @click="deletePart(part.name)">Delete</button>
              <button class="small" @click="confirming = ''">Cancel</button>
            </div>
          </div>
        </section>
      </div>

      <div class="foot">
        <label for="palette"><Icon name="palette" /> Colours</label>
        <select id="palette" v-model="palette">
          <option v-for="(set, id) in PALETTES" :key="id" :value="id">{{ set.name }}</option>
        </select>
      </div>
    </aside>

    <main :class="page">
      <header v-if="current.title" class="page-head">
        <h1>{{ current.title }}</h1>
        <p>{{ current.about }}</p>
      </header>

      <CardMaker v-if="page === 'cards'" />
      <Combiner v-else-if="page === 'combine'" />
      <CompilationBuilder v-else-if="page === 'compilations'" />
      <Sources v-else-if="page === 'sources'" />
      <template v-else>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <NewClip v-if="view.kind === 'video'" :key="view.name" :video="view.name" :briefs="briefs" @done="openClip" />
        <ClipView v-else-if="view.kind === 'clip'" :key="view.name" :name="view.name" @changed="refresh" />
        <section v-else-if="view.kind === 'part'" :key="view.name" class="part">
          <header class="page-head">
            <h1>{{ view.name }}</h1>
            <p>A part saved as it is, at the original size. The file is in the <code>parts</code> folder.</p>
          </header>
          <div class="panel">
            <video :src="api.partUrl(view.name)" controls playsinline />
            <p class="hint"><a :href="api.partUrl(view.name)" :download="view.name">Download this part</a></p>
          </div>
        </section>
        <section v-else-if="loaded && !error" class="panel welcome">
          <span class="logo big" aria-hidden="true"><Icon name="film" /></span>
          <h2>Start with a video</h2>
          <p class="muted">
            Put a video file in the project's <code>in</code> folder and reload this page. If a channel has agreed to
            let you use its videos, you can also fetch part of one from YouTube.
          </p>
          <button class="primary" @click="go('sources')"><Icon name="link" /> Open Sources</button>
        </section>
      </template>
    </main>
  </div>
</template>

<style scoped>
.layout { display: grid; grid-template-columns: 290px minmax(0, 1fr); min-height: 100vh; }

aside {
  position: sticky; top: 0; height: 100vh; overflow-y: auto;
  display: flex; flex-direction: column; gap: 18px; padding: 18px 14px;
  background: var(--soft); border-right: 1px solid var(--line);
}
.brand { display: flex; align-items: center; gap: 10px; padding: 0 4px; }
.brand h1 { font-size: 18px; }
.logo {
  display: grid; place-items: center; width: 34px; height: 34px; flex: none; border-radius: 10px;
  background: var(--accent); color: var(--accent-text);
}
.logo .icon { width: 19px; height: 19px; }
.logo.big { width: 56px; height: 56px; border-radius: 16px; }
.logo.big .icon { width: 28px; height: 28px; }

nav { display: flex; flex-direction: column; gap: 2px; }
nav button {
  justify-content: flex-start; gap: 10px; width: 100%; min-height: 38px; padding: 6px 10px;
  border-color: transparent; background: transparent; color: var(--text); font-weight: 550;
}
nav button:hover:not(:disabled) { background: var(--soft-strong); border-color: transparent; }
nav button.current, nav button.current:hover { background: var(--accent); color: var(--accent-text); }

h3 { display: flex; align-items: center; gap: 6px; padding: 0 4px; }
.count { font-weight: 650; letter-spacing: 0; background: var(--highlight); color: var(--highlight-text); border-radius: 999px; padding: 0 7px; }
.lists { display: flex; flex-direction: column; gap: 18px; }
.item-row { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; }
.item {
  flex: 1; min-width: 0; min-height: 0; flex-direction: column; align-items: flex-start; gap: 1px;
  padding: 6px 10px; text-align: left; font-weight: 400;
  border-color: transparent; background: transparent; color: var(--text);
}
.item:hover:not(:disabled) { background: var(--soft-strong); border-color: transparent; }
.item.current, .item.current:hover { background: var(--panel); border-color: var(--accent); box-shadow: inset 3px 0 0 var(--accent); }
.item .name { font-size: 14px; font-weight: 600; word-break: break-all; }
.item .detail { font-size: 12px; color: var(--muted); word-break: break-all; }
.item .chip { margin-top: 3px; }
.item-row .confirm { flex: 1 1 100%; margin: 2px 0 6px; background: var(--panel); }
.empty { margin: 0; text-align: left; font-size: 13px; padding: 10px 12px; }

.activity ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.activity li {
  display: flex; flex-wrap: wrap; align-items: flex-start; gap: 8px; padding: 9px 10px; font-size: 13px;
  background: var(--panel); border: 1px solid var(--accent); border-radius: var(--radius);
}
.activity li .spinner, .activity li .icon { margin-top: 3px; }
.activity li.done { border-color: var(--good); background: var(--good-bg); }
.activity li.done .icon { color: var(--good); }
.activity li.failed { border-color: var(--bad); background: var(--bad-bg); }
.activity li.failed .icon { color: var(--bad); }
.activity .text { flex: 1; min-width: 0; white-space: pre-wrap; word-break: break-word; }
.activity .buttons { flex: 1 1 100%; display: flex; gap: 6px; justify-content: flex-end; }

.foot { margin-top: auto; padding: 12px 4px 0; border-top: 1px solid var(--line); }
.foot label { display: flex; align-items: center; gap: 6px; color: var(--text); }

main { padding: 24px 28px 40px; min-width: 0; }
main.cards, main.compilations { max-width: 1600px; }
main.sources { max-width: 1250px; }
main.clips { max-width: 1500px; }
.part video { width: 100%; max-height: 70vh; background: black; border-radius: var(--radius); display: block; }
.welcome { max-width: 560px; margin: 8vh auto 0; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 10px; }
.welcome h2 { font-size: 20px; margin: 0; }

@media (max-width: 900px) {
  .layout { grid-template-columns: 1fr; }
  aside { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--line); }
  nav { flex-direction: row; flex-wrap: wrap; }
  nav button { width: auto; }
  /* The lists scroll in a box of their own, so the page itself starts near the top. */
  .lists { max-height: 250px; overflow-y: auto; padding-right: 4px; }
  .foot { display: flex; align-items: center; gap: 12px; margin-top: 0; }
  .foot label { margin: 0; flex: none; }
  main { padding: 16px 14px 32px; }
}
</style>
