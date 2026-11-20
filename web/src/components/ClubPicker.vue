<script setup>
// The club a streamer supports, chosen from the owner's list of clubs. Shown
// as a small logo; clicking it opens a list to choose from.
//
// One club is the rule (`max` 1): choosing another takes the first one's
// place, and choosing the same one again takes it off. A streamer who was
// given several clubs when that was allowed still shows all of them, and
// keeps them until a choice is made here.
import { computed, onUnmounted, ref, watch } from 'vue';
import Icon from './Icon.vue';

const props = defineProps({
  modelValue: { type: Array, required: true }, // the chosen clubs, by name
  clubs: { type: Array, required: true }, // every club once: { name, colour, icon }
  max: { type: Number, default: 1 },
  label: { type: String, default: 'this channel' },
});
const emit = defineEmits(['update:modelValue']);

const open = ref(false);
const search = ref('');
const root = ref(null);
const box = ref(null);

const byName = computed(() => new Map(props.clubs.map((club) => [club.name, club])));
// A club that was chosen and later deleted from the list is still shown, by its name alone.
const chosen = computed(() => props.modelValue.map((name) => byName.value.get(name) ?? { name, colour: '', icon: '' }));
const full = computed(() => props.modelValue.length >= props.max);
const found = computed(() => {
  const wanted = search.value.trim().toLowerCase();
  return wanted ? props.clubs.filter((club) => club.name.toLowerCase().includes(wanted)) : props.clubs;
});
const isChosen = (name) => props.modelValue.includes(name);

const single = computed(() => props.max === 1);
function toggle(name) {
  if (single.value) {
    // One club: this one takes the place of whatever was chosen, or comes off if it was the only one.
    emit('update:modelValue', isChosen(name) && props.modelValue.length === 1 ? [] : [name]);
    open.value = false;
    return;
  }
  if (isChosen(name)) emit('update:modelValue', props.modelValue.filter((known) => known !== name));
  else if (!full.value) emit('update:modelValue', [...props.modelValue, name]);
}

// The list closes on a click anywhere else, and on Escape.
const outside = (event) => {
  if (root.value && !root.value.contains(event.target)) open.value = false;
};
const escape = (event) => {
  if (event.key === 'Escape') open.value = false;
};
watch(open, (isOpen) => {
  if (isOpen) {
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    search.value = '';
    setTimeout(() => box.value?.focus());
  } else {
    document.removeEventListener('mousedown', outside);
    document.removeEventListener('keydown', escape);
  }
});
onUnmounted(() => {
  document.removeEventListener('mousedown', outside);
  document.removeEventListener('keydown', escape);
});
</script>

<template>
  <div ref="root" class="picker">
    <button class="quiet chosen" :aria-expanded="open" :aria-label="`Club ${label} supports: ${modelValue.join(', ') || 'none chosen'}. Change`" :title="modelValue.join(', ') || 'Choose the club this streamer supports'" @click="open = !open">
      <!-- A club's own colour and logo, as the owner set them: data, not part of the page's colours. -->
      <span v-for="club in chosen" :key="club.name" class="thumb" :style="club.icon || !club.colour ? {} : { background: club.colour }">
        <img v-if="club.icon" :src="club.icon" alt="" />
        <span v-else aria-hidden="true">{{ club.name.charAt(0).toUpperCase() }}</span>
      </span>
      <span v-if="chosen.length === 0" class="none"><Icon name="plus" /> Club</span>
    </button>

    <div v-if="open" class="list panel" role="dialog" :aria-label="`Clubs ${label} supports`">
      <label :for="`club-search-${label}`" class="sr">Find a club</label>
      <input :id="`club-search-${label}`" ref="box" v-model="search" type="text" placeholder="Find a club…" />
      <p v-if="!single" class="hint">{{ modelValue.length }} of {{ max }} chosen{{ full ? '. Untick one to choose another.' : '' }}</p>
      <p v-else-if="modelValue.length > 1" class="notice">This streamer has {{ modelValue.length }} clubs from before: {{ modelValue.join(', ') }}. Choosing one keeps only that one. Press “Done” to leave them as they are.</p>
      <p v-else class="hint">{{ modelValue.length === 1 ? `Chosen: ${modelValue[0]}. Choose another to change it, or the same one to take it off.` : 'Choose one club.' }}</p>
      <div class="clubs">
        <button
          v-for="club in found" :key="club.name" class="club" :class="{ on: isChosen(club.name) }"
          :aria-pressed="isChosen(club.name)" :disabled="!single && full && !isChosen(club.name)" @click="toggle(club.name)"
        >
          <span class="thumb" :style="club.icon ? {} : { background: club.colour }">
            <img v-if="club.icon" :src="club.icon" alt="" />
            <span v-else aria-hidden="true">{{ club.name.charAt(0).toUpperCase() }}</span>
          </span>
          <span class="name">{{ club.name }}</span>
          <Icon v-if="isChosen(club.name)" name="check" />
        </button>
        <p v-if="found.length === 0" class="muted">No club with that name. Add clubs on the Cards page, under “Leagues and clubs”.</p>
      </div>
      <!-- Chosen clubs that are no longer in the list can still be taken off here. -->
      <div v-if="chosen.some((club) => !byName.has(club.name))" class="gone">
        <button v-for="club in chosen.filter((one) => !byName.has(one.name))" :key="club.name" class="small" @click="toggle(club.name)">Remove {{ club.name }} (no longer in your clubs)</button>
      </div>
      <button class="small done" @click="open = false">Done</button>
    </div>
  </div>
</template>

<style scoped>
.picker { position: relative; }
.chosen { display: flex; align-items: center; gap: 4px; min-height: 36px; width: 100%; padding: 2px 6px; justify-content: flex-start; }
.none { display: inline-flex; align-items: center; gap: 4px; color: var(--muted); font-size: 13px; font-weight: 550; }
.thumb {
  display: grid; place-items: center; width: 28px; height: 28px; flex: none; border-radius: 6px; overflow: hidden;
  background: var(--text); color: white; font-weight: 700; font-size: 13px;
  /* A letter has to read on whatever colour the club has. */
  text-shadow: 0 0 3px black, 0 0 1px black;
}
.thumb img { width: 100%; height: 100%; object-fit: contain; }
.list {
  position: absolute; z-index: 6; top: calc(100% + 4px); right: 0; width: 320px; padding: 12px;
  box-shadow: 0 8px 24px var(--shadow);
}
.list .hint { margin: 6px 0 8px; }
.list .notice { margin: 8px 0; font-size: 13px; }
.clubs { max-height: 280px; overflow-y: auto; display: grid; gap: 2px; }
.club {
  justify-content: flex-start; gap: 8px; min-height: 36px; padding: 4px 8px; border-color: transparent;
  background: transparent; color: var(--text); font-weight: 400; text-align: left;
}
.club .name { flex: 1; }
.club.on { background: var(--accent-tint); border-color: var(--accent); font-weight: 650; }
.club .icon { color: var(--accent); }
.gone { margin-top: 8px; display: grid; gap: 4px; }
.done { margin-top: 10px; width: 100%; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
</style>
