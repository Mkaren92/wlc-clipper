<script setup>
// The small line drawings used on buttons and in lists. They are drawn in the
// colour of the text around them, and are decoration: a button with only an
// icon carries its own aria-label.
defineProps({ name: { type: String, required: true } });

const PATHS = {
  play: 'M7 4.5v15l12-7.5z',
  pause: 'M7 4.5v15M17 4.5v15',
  scissors: 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12',
  film: 'M4 4h16v16H4zM8 4v16M16 4v16M4 9h4M4 15h4M16 9h4M16 15h4',
  card: 'M3 6h18v12H3zM7 10h6M7 14h3',
  layers: 'M12 3 2.5 8 12 13l9.5-5zM2.5 12.5 12 17.5l9.5-5M2.5 17l9.5 5 9.5-5',
  link: 'M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2M14 10a4.5 4.5 0 0 0-6.4 0l-3 3A4.5 4.5 0 0 0 11 19.4l1.2-1.2',
  download: 'M12 4v11M7 11l5 5 5-5M4.5 20h15',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  check: 'M4.5 12.5 10 18 19.5 6.5',
  cross: 'M6 6l12 12M18 6 6 18',
  alert: 'M12 3.5 2.5 20h19zM12 10v4.5M12 17.2v.3',
  plus: 'M12 5v14M5 12h14',
  split: 'M3 5h18v14H3zM12 5v14',
  sync: 'M20 11a8 8 0 0 0-14.6-4.4L4 8M4 4v4h4M4 13a8 8 0 0 0 14.6 4.4L20 16M20 20v-4h-4',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  refresh: 'M20 5v5h-5M4 19v-5h5M19.4 10A8 8 0 0 0 5.6 7.2L4 9M4.6 14a8 8 0 0 0 13.8 2.8L20 15',
  spark: 'M12 3v6M12 15v6M3 12h6M15 12h6M6 6l3 3M15 15l3 3M18 6l-3 3M9 15l-3 3',
  palette: 'M12 3a9 9 0 1 0 0 18c1.4 0 2-1 2-2 0-1.6-1-1.8-1-3 0-1 .8-2 2-2h2.5A3.5 3.5 0 0 0 21 10.5C21 6.4 17 3 12 3zM7.5 12h.01M9.5 8h.01M14.5 7.5h.01',
  video: 'M3.5 6h12v12h-12zM15.5 10.5l5-3v9l-5-3',
  piece: 'M4 7h16M4 12h16M4 17h9',
  start: 'M6 4v16M10 12l9-6v12z',
  end: 'M18 4v16M14 12 5 6v12z',
};
</script>

<template>
  <svg
    class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
  >
    <path :d="PATHS[name]" />
  </svg>
</template>
