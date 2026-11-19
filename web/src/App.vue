<script setup>
import { onMounted, ref, watch } from 'vue';
import { api } from './api.js';
import ClipView from './components/ClipView.vue';
import NewClip from './components/NewClip.vue';
import TrashButton from './components/TrashButton.vue';
import CardMaker from './pages/CardMaker.vue';
import CompilationBuilder from './pages/CompilationBuilder.vue';
import { clock, fileSize } from './format.js';
import { describe, isActive, jobs, refresh as refreshJobs, visibleJobs } from './jobs.js';

const videos = ref([]);
const clips = ref([]);
const parts = ref([]);
const briefs = ref([]);
const error = ref('');
// Which page is open. Kept in the address after #, so a reload stays on it.
const PAGES = [['clips', 'Clips'], ['cards', 'Cards'], ['compilations', 'Compilations']];
const page = ref(PAGES.some(([id]) => id === location.hash.slice(1)) ? location.hash.slice(1) : 'clips');
function go(id) {
  page.value = id;
  location.hash = id;
}
// Follow the address when it changes without a reload: a link, or Back and Forward.
window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  if (PAGES.some(([known]) => known === id)) page.value = id;
});
// What the main area shows: a video to cut from, or a finished clip.
const view = ref({ kind: 'none' });

async function refresh() {
  try {
    [videos.value, clips.value, briefs.value, parts.value] = await Promise.all([api.videos(), api.clips(), api.briefs(), api.parts()]);
    error.value = '';
  } catch (e) {
    error.value = e.message;
  }
}

// Deleting asks once, in place, because it cannot be undone.
const confirming = ref('');

async function deleteClip(name) {
  try {
    await api.deleteClip(name);
    confirming.value = '';
    // If the deleted clip was on screen, go back to its source video.
    if (view.value.kind === 'clip' && view.value.name === name) {
      view.value = videos.value.length > 0 ? { kind: 'video', name: videos.value[0].name } : { kind: 'none' };
    }
    await refresh();
  } catch (e) {
    error.value = e.message;
  }
}

async function deletePart(name) {
  try {
    await api.deletePart(name);
    confirming.value = '';
    if (view.value.kind === 'part' && view.value.name === name) {
      view.value = videos.value.length > 0 ? { kind: 'video', name: videos.value[0].name } : { kind: 'none' };
    }
    await refresh();
  } catch (e) {
    error.value = e.message;
  }
}

async function openClip(name) {
  await refresh();
  view.value = { kind: 'clip', name };
}

// A job that finishes may have made or changed a clip, so the list is read again.
watch(() => jobs.list.filter((job) => !isActive(job)).length, refresh);

// Where a finished job's notice leads.
function openJob(job) {
  jobs.dismissed.push(job.id);
  if (job.kind === 'compile') return go('compilations');
  if (job.kind === 'suggest') view.value = { kind: 'video', name: job.label };
  else if (job.kind === 'part') view.value = { kind: 'part', name: job.result.name };
  else openClip(job.kind === 'cut' ? job.result.clip : job.label);
}

onMounted(async () => {
  refreshJobs();
  await refresh();
  if (videos.value.length > 0) view.value = { kind: 'video', name: videos.value[0].name };
});
</script>

<template>
  <div class="layout">
    <aside>
      <h1>WLC Clipper</h1>
      <nav aria-label="Pages">
        <button v-for="[id, name] in PAGES" :key="id" class="small" :class="{ primary: page === id }" @click="go(id)">{{ name }}</button>
      </nav>

      <template v-if="page === 'clips'">
      <section>
        <h3>Videos</h3>
        <p v-if="videos.length === 0" class="muted">No videos yet. Put video files in the <code>in</code> folder, then reload.</p>
        <button
          v-for="video in videos" :key="video.name" class="item"
          :class="{ current: view.kind === 'video' && view.name === video.name }"
          @click="view = { kind: 'video', name: video.name }"
        >
          <span class="name">{{ video.name }}</span>
          <span class="muted">{{ fileSize(video.size) }}</span>
        </button>
      </section>

      <section>
        <h3>Clips</h3>
        <p v-if="clips.length === 0" class="muted">Clips you cut appear here.</p>
        <div v-for="clip in clips" :key="clip.name" class="clip-row">
          <button
            class="item" :class="{ current: view.kind === 'clip' && view.name === clip.name }"
            @click="view = { kind: 'clip', name: clip.name }"
          >
            <span class="name">{{ clip.name }}</span>
            <span class="muted">
              {{ clip.source }} · {{ clock(clip.start) }}–{{ clock(clip.end) }}
              <span v-if="clip.failedChecks > 0" class="fail"> · {{ clip.failedChecks }} failed</span>
            </span>
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
        <h3>Parts</h3>
        <p v-if="parts.length === 0" class="muted">Parts saved as they are, at the original size, appear here.</p>
        <div v-for="part in parts" :key="part.name" class="clip-row">
          <button
            class="item" :class="{ current: view.kind === 'part' && view.name === part.name }"
            @click="view = { kind: 'part', name: part.name }"
          >
            <span class="name">{{ part.name }}</span>
            <span class="muted">{{ fileSize(part.size) }}</span>
          </button>
          <TrashButton v-if="confirming !== `part:${part.name}`" :label="`Delete ${part.name}`" @click="confirming = `part:${part.name}`" />
          <div v-else class="confirm" role="alertdialog" :aria-label="`Delete ${part.name}?`">
            <span>Delete {{ part.name }}? This cannot be undone.</span>
            <button class="small danger" @click="deletePart(part.name)">Delete</button>
            <button class="small" @click="confirming = ''">Cancel</button>
          </div>
        </div>
      </section>
      </template>
    </aside>

    <main :class="page">
      <ul v-if="visibleJobs().length > 0" class="jobs" aria-live="polite">
        <li v-for="job in visibleJobs()" :key="job.id" :class="job.status">
          <span v-if="isActive(job)" class="spinner" aria-hidden="true" />
          <span class="text">{{ describe(job) }}</span>
          <button v-if="job.status === 'done'" class="small" @click="openJob(job)">
            {{ job.kind === 'suggest' ? 'Show' : 'Open' }}
          </button>
          <button v-if="!isActive(job)" class="small" @click="jobs.dismissed.push(job.id)">Close</button>
        </li>
      </ul>
      <CardMaker v-if="page === 'cards'" />
      <CompilationBuilder v-else-if="page === 'compilations'" />
      <template v-else>
      <p v-if="error" class="error">{{ error }}</p>
      <NewClip v-if="view.kind === 'video'" :key="view.name" :video="view.name" :briefs="briefs" @done="openClip" />
      <ClipView v-else-if="view.kind === 'clip'" :key="view.name" :name="view.name" @changed="refresh" />
      <section v-else-if="view.kind === 'part'" :key="view.name" class="panel part">
        <h2>{{ view.name }}</h2>
        <p class="muted">A part saved as it is, at the original size. The file is in the <code>parts</code> folder.</p>
        <video :src="api.partUrl(view.name)" controls playsinline />
      </section>
      <p v-else-if="!error" class="muted">Choose a video on the left to start.</p>
      </template>
    </main>
  </div>
</template>

<style scoped>
.layout { display: grid; grid-template-columns: 270px 1fr; min-height: 100vh; }
aside { border-right: 1px solid var(--line); padding: 16px; background: var(--panel); }
aside section { margin-top: 20px; }
main { padding: 20px; max-width: 1500px; }
main.clips { max-width: 1100px; }
nav { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 12px; }
.item {
  display: flex; flex-direction: column; align-items: flex-start; width: 100%; text-align: left;
  margin-bottom: 4px; border-color: transparent; background: transparent; font-size: 13px;
}
.item .name { font-size: 14px; font-weight: 600; word-break: break-all; }
.item.current { border-color: var(--accent); }
.clip-row { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; }
.clip-row .item { flex: 1; width: auto; min-width: 0; }
.confirm {
  flex: 1 1 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 13px;
  padding: 6px 8px; margin-bottom: 6px; border: 1px solid var(--bad); border-radius: 6px;
}
.confirm span { flex: 1 1 100%; }
.danger { background: var(--bad); border-color: var(--bad); color: #fff; font-weight: 600; }
.part video { width: 100%; max-height: 70vh; background: #000; border-radius: 8px; display: block; }
.jobs { list-style: none; margin: 0 0 16px; padding: 0; position: sticky; top: 8px; z-index: 5; }
.jobs li {
  display: flex; align-items: center; gap: 10px; padding: 8px 12px; margin-bottom: 6px;
  background: var(--panel); border: 1px solid var(--accent); border-radius: 8px;
}
.jobs li.done { border-color: var(--good); }
.jobs li.failed { border-color: var(--bad); }
.jobs .text { flex: 1; white-space: pre-wrap; }
.spinner {
  width: 14px; height: 14px; border-radius: 50%; flex: none;
  border: 2px solid var(--line); border-top-color: var(--accent); animation: spin 0.9s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }

@media (max-width: 800px) {
  .layout { grid-template-columns: 1fr; }
  aside { border-right: 0; border-bottom: 1px solid var(--line); }
}
</style>
