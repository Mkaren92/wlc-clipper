<script setup>
// The source video with the chosen layout drawn over it. The windows come
// from the server (src/layout.js), in source pixels; this component only
// draws them and lets two of them be dragged.
import { computed, ref } from 'vue';

const props = defineProps({
  src: { type: String, required: true },
  info: { type: Object, required: true }, // from /api/videos/:name
  layout: { type: String, required: true },
});
const cropX = defineModel('cropX', { type: Number }); // left edge of the center window
const cam = defineModel('cam', { type: Object }); // webcam rectangle for facecam
defineEmits(['time', 'duration', 'playing', 'unplayable']);

const frame = ref(null);
const video = ref(null);
defineExpose({ video });

const windows = computed(() => props.info.layouts);

/** Turn a rectangle in source pixels into CSS percentages of the frame. */
function place(box) {
  return {
    left: `${(box.x / props.info.width) * 100}%`,
    top: `${(box.y / props.info.height) * 100}%`,
    width: `${(box.width / props.info.width) * 100}%`,
    height: `${(box.height / props.info.height) * 100}%`,
  };
}

const centerBox = computed(() => ({ ...windows.value.center, x: cropX.value ?? windows.value.center.x }));
const canSlide = computed(() => windows.value.center.minX !== null);

/**
 * Follow the pointer while it is held down, reporting how far it has moved
 * in source pixels since the drag began.
 */
function drag(event, onMove) {
  event.preventDefault();
  const scale = props.info.width / frame.value.clientWidth;
  const startX = event.clientX;
  const startY = event.clientY;
  const move = (e) => onMove((e.clientX - startX) * scale, (e.clientY - startY) * scale);
  const stop = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', stop);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', stop);
}

const clamp = (n, low, high) => Math.min(Math.max(n, low), high);

function slideCenter(event) {
  if (!canSlide.value) return;
  const from = centerBox.value.x;
  const { minX, maxX } = windows.value.center;
  drag(event, (dx) => (cropX.value = clamp(Math.round(from + dx), minX, maxX)));
}

function moveCam(event) {
  const from = { ...cam.value };
  drag(event, (dx, dy) => {
    cam.value = {
      ...from,
      x: clamp(Math.round(from.x + dx), 0, props.info.width - from.width),
      y: clamp(Math.round(from.y + dy), 0, props.info.height - from.height),
    };
  });
}

// The webcam box keeps the shape of the panel it fills.
function resizeCam(event) {
  const from = { ...cam.value };
  const aspect = windows.value.camAspect;
  drag(event, (dx) => {
    const maxWidth = Math.min(props.info.width - from.x, (props.info.height - from.y) * aspect);
    const width = clamp(Math.round(from.width + dx), 80, Math.floor(maxWidth));
    cam.value = { ...from, width, height: Math.round(width / aspect) };
  });
}
</script>

<template>
  <!--
    The picture is kept inside the screen with room for the player's buttons
    and the bar at the bottom: its width is held to what that height allows.
  -->
  <div
    ref="frame" class="frame"
    :style="{ aspectRatio: `${info.width} / ${info.height}`, maxWidth: `calc(max(200px, 100vh - 400px) * ${info.width / info.height})` }"
  >
    <video
      ref="video" :src="src" preload="metadata" playsinline
      @timeupdate="$emit('time', video.currentTime)"
      @loadedmetadata="$emit('duration', video.duration)"
      @play="$emit('playing', true)" @pause="$emit('playing', false)"
      @error="$emit('unplayable')"
    />

    <!-- center: everything outside the crop is dimmed -->
    <div
      v-if="layout === 'center'" class="window dim" :class="{ slide: canSlide }"
      :style="place(centerBox)" @pointerdown="slideCenter"
    >
      <span class="tag">{{ canSlide ? 'Drag to move the crop' : 'Crop' }}</span>
    </div>

    <!-- blur: the whole frame is kept; show only what the trim removes -->
    <div v-if="layout === 'blur'" class="window outline" :style="place(windows.area)">
      <span class="tag">Whole frame is kept</span>
    </div>

    <!-- facecam: the gameplay window is fixed, the webcam box is yours to place -->
    <template v-if="layout === 'facecam' && cam">
      <div class="window outline" :style="place(windows.game)"><span class="tag">Bottom panel</span></div>
      <div class="window cam" :style="place(cam)" @pointerdown="moveCam">
        <span class="tag">Top panel: drag to move</span>
        <span class="handle" title="Drag to resize" @pointerdown.stop="resizeCam" />
      </div>
    </template>
  </div>
</template>

<style scoped>
/*
 * The colours here are fixed and do not follow the palette. These marks lie
 * over the video, so they have to show on any footage: white and yellow lines
 * with a dark surround, whatever colours the rest of the page has.
 */
.frame { position: relative; width: 100%; margin: 0 auto; background: black; border-radius: var(--radius); overflow: hidden; user-select: none; }
video { display: block; width: 100%; height: 100%; }
.window { position: absolute; border: 2px solid white; touch-action: none; }
.window.dim { box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.6); }
.window.slide { cursor: ew-resize; }
.window.outline { border-style: dashed; border-color: rgba(255, 255, 255, 0.8); pointer-events: none; }
.window.cam { border-color: rgb(255, 213, 74); cursor: move; background: rgba(255, 213, 74, 0.12); }
.tag {
  position: absolute; left: 6px; top: 6px; font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 4px;
  background: rgba(0, 0, 0, 0.75); color: white; pointer-events: none; white-space: nowrap;
}
.handle {
  position: absolute; right: -9px; bottom: -9px; width: 20px; height: 20px; border-radius: 50%;
  background: rgb(255, 213, 74); border: 2px solid black; cursor: nwse-resize;
}
</style>
