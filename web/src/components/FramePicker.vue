<script setup>
// The source video with the chosen layout drawn over it. The windows come
// from the server (src/layout.js), in source pixels; this component only
// draws them and lets two of them be dragged.
import { BLUR_MIN_SIZE, camPanelHeight, facecamGameWindow } from '../../../src/layout.js';
import { computed, ref } from 'vue';

const props = defineProps({
  src: { type: String, required: true },
  info: { type: Object, required: true }, // from /api/videos/:name
  layout: { type: String, required: true },
  now: { type: Number, default: 0 }, // where the video is, to show which blur boxes are on
});
const cropX = defineModel('cropX', { type: Number }); // left edge of the center window
const cam = defineModel('cam', { type: Object }); // webcam rectangle for facecam
// The webcam box's shape while resizing: width divided by height, or null to leave it free.
const camShape = defineModel('camShape', { type: Number, default: null });
// The facecam's content box: the part of the video shown under the webcam, chosen apart from it.
const game = defineModel('game', { type: Object });
// Blur boxes: { x, y, width, height, from, to, style }, in source pixels and the video's own seconds.
const blurs = defineModel('blurs', { type: Array, default: () => [] });
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

/** Move a box (the webcam's or the content's) by dragging it, inside the frame. */
function moveBox(event, box) {
  const from = { ...box.value };
  drag(event, (dx, dy) => {
    box.value = {
      ...from,
      x: clamp(Math.round(from.x + dx), 0, props.info.width - from.width),
      y: clamp(Math.round(from.y + dy), 0, props.info.height - from.height),
    };
  });
}
const moveCam = (event) => moveBox(event, cam);
const moveGame = (event) => moveBox(event, game);
// The content box takes any shape; resizing it never touches the webcam box, nor the other way round.
function resizeGame(event) {
  const from = { ...game.value };
  drag(event, (dx, dy) => {
    game.value = { ...from, width: clamp(Math.round(from.width + dx), 80, props.info.width - from.x), height: clamp(Math.round(from.height + dy), 80, props.info.height - from.y) };
  });
}

// The webcam box takes any shape, since webcams are not all 16:9; with a shape chosen
// it keeps that shape. The top panel of the clip follows it (camPanelHeight).
function resizeCam(event) {
  const from = { ...cam.value };
  const roomX = props.info.width - from.x;
  const roomY = props.info.height - from.y;
  drag(event, (dx, dy) => {
    const aspect = camShape.value;
    if (aspect) {
      const width = clamp(Math.round(from.width + dx), 60, Math.floor(Math.min(roomX, roomY * aspect)));
      cam.value = { ...from, width, height: Math.round(width / aspect) };
    } else {
      cam.value = { ...from, width: clamp(Math.round(from.width + dx), 60, roomX), height: clamp(Math.round(from.height + dy), 60, roomY) };
    }
  });
}
// A blur box is moved and resized like the others; it is replaced as a whole so the page sees the change.
function changeBlur(i, change) {
  const copy = [...blurs.value];
  copy[i] = { ...copy[i], ...change };
  blurs.value = copy;
}
function moveBlur(event, i) {
  const from = { ...blurs.value[i] };
  drag(event, (dx, dy) => changeBlur(i, {
    x: clamp(Math.round(from.x + dx), 0, props.info.width - from.width),
    y: clamp(Math.round(from.y + dy), 0, props.info.height - from.height),
  }));
}
function resizeBlur(event, i) {
  const from = { ...blurs.value[i] };
  drag(event, (dx, dy) => changeBlur(i, {
    width: clamp(Math.round(from.width + dx), BLUR_MIN_SIZE, props.info.width - from.x),
    height: clamp(Math.round(from.height + dy), BLUR_MIN_SIZE, props.info.height - from.y),
  }));
}
const blurOn = (box) => props.now >= box.from && props.now < box.to;

// Without a content box (a clip set up before there was one), the middle of the gameplay, by the engine's own sums.
const gameBox = computed(() => game.value ?? facecamGameWindow(windows.value.area, camPanelHeight(cam.value)));
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
      <div v-if="game" class="window game" :style="place(game)" @pointerdown="moveGame">
        <span class="tag">Content: drag to move</span>
        <span class="handle game-handle" title="Drag to resize" @pointerdown.stop="resizeGame" />
      </div>
      <div v-else class="window outline" :style="place(gameBox)"><span class="tag">Bottom panel</span></div>
      <div class="window cam" :style="place(cam)" @pointerdown="moveCam">
        <span class="tag">Top panel: drag to move</span>
        <span class="handle" title="Drag to resize" @pointerdown.stop="resizeCam" />
      </div>
    </template>

    <!-- blur boxes: solid while the video is inside their time, dashed outside it -->
    <div
      v-for="(box, i) in blurs" :key="i" class="window blurbox" :class="{ black: box.style === 'black', off: !blurOn(box) }"
      :style="place(box)" @pointerdown="moveBlur($event, i)"
    >
      <span class="tag">{{ box.style === 'black' ? 'Black' : 'Blur' }} {{ i + 1 }}</span>
      <span class="handle blur-handle" title="Drag to resize" @pointerdown.stop="resizeBlur($event, i)" />
    </div>
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
/* The content box: a second colour beside the webcam's yellow, fixed so it shows on any footage. */
.window.game { border-color: rgb(80, 200, 255); cursor: move; background: rgba(80, 200, 255, 0.1); }
.handle.game-handle { background: rgb(80, 200, 255); }
/* Blur boxes: pink, so they show beside the webcam's yellow and the content's blue. */
.window.blurbox { border-color: rgb(255, 80, 170); cursor: move; background: rgba(255, 80, 170, 0.15); backdrop-filter: blur(10px); }
.window.blurbox.black { background: rgba(0, 0, 0, 0.9); backdrop-filter: none; }
.window.blurbox.off { border-style: dashed; background: transparent; backdrop-filter: none; }
.handle.blur-handle { background: rgb(255, 80, 170); }
</style>
