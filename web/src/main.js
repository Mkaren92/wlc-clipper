import { createApp } from 'vue';
import App from './App.vue';
import './style.css';
import { applyPalette } from './theme.js';

// The colours go on the page before anything is drawn.
applyPalette();
createApp(App).mount('#app');
