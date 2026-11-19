<script setup>
import { onMounted, ref } from 'vue';
import { api } from './api.js';
import ClipView from './components/ClipView.vue';
import NewClip from './components/NewClip.vue';
import { clock, fileSize } from './format.js';

const videos = ref([]);
const clips = ref([]);
const briefs = ref([]);
const error = ref('');
// What the main area shows: a video to cut from, or a finished clip.
const view = ref({ kind: 'none' });

async function refresh() {
  try {
    [videos.value, clips.value, briefs.value] = await Promise.all([api.videos(), api.clips(), api.briefs()]);
    error.value = '';
  } catch (e) {
    error.value = e.message;
  }
}

async function openClip(name) {
  await refresh();
  view.value = { kind: 'clip', name };
}

onMounted(async () => {
  await refresh();
  if (videos.value.length > 0) view.value = { kind: 'video', name: videos.value[0].name };
});
</script>

<template>
  <div class="layout">
    <aside>
      <h1>WLC Clipper</h1>

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
        <button
          v-for="clip in clips" :key="clip.name" class="item"
          :class="{ current: view.kind === 'clip' && view.name === clip.name }"
          @click="view = { kind: 'clip', name: clip.name }"
        >
          <span class="name">{{ clip.name }}</span>
          <span class="muted">
            {{ clip.source }} · {{ clock(clip.start) }}–{{ clock(clip.end) }}
            <span v-if="clip.failedChecks > 0" class="fail"> · {{ clip.failedChecks }} failed</span>
          </span>
        </button>
      </section>
    </aside>

    <main>
      <p v-if="error" class="error">{{ error }}</p>
      <NewClip v-if="view.kind === 'video'" :key="view.name" :video="view.name" :briefs="briefs" @done="openClip" />
      <ClipView v-else-if="view.kind === 'clip'" :key="view.name" :name="view.name" @changed="refresh" />
      <p v-else-if="!error" class="muted">Choose a video on the left to start.</p>
    </main>
  </div>
</template>

<style scoped>
.layout { display: grid; grid-template-columns: 270px 1fr; min-height: 100vh; }
aside { border-right: 1px solid var(--line); padding: 16px; background: var(--panel); }
aside section { margin-top: 20px; }
main { padding: 20px; max-width: 1100px; }
.item {
  display: flex; flex-direction: column; align-items: flex-start; width: 100%; text-align: left;
  margin-bottom: 4px; border-color: transparent; background: transparent; font-size: 13px;
}
.item .name { font-size: 14px; font-weight: 600; word-break: break-all; }
.item.current { border-color: var(--accent); }

@media (max-width: 800px) {
  .layout { grid-template-columns: 1fr; }
  aside { border-right: 0; border-bottom: 1px solid var(--line); }
}
</style>
