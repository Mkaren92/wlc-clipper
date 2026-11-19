<script setup>
// Make the still cards shown between reaction clips: goal, red card, full time.
// The preview and the exported PNG come from the same template functions
// (src/cards/templates.js), so they always match.
import { computed, onMounted, ref } from 'vue';
import { CARD_SIZES, GOAL_TYPES, goalType, minuteLabel, RED_TYPES } from '../../../src/cards/config.js';
import { renderCard } from '../../../src/cards/templates.js';
import { api } from '../api.js';
import { cardPng, download, loadCardFont } from '../cardPng.js';
import TrashButton from '../components/TrashButton.vue';

const matches = ref([]);
const match = ref(null); // the match being edited: a copy, saved with the Save button
const cardId = ref('');
const size = ref('landscape');
const note = ref('');
const error = ref('');
const saving = ref(false);
const confirming = ref('');

const card = computed(() => match.value?.cards.find((c) => c.id === cardId.value) ?? null);
const svg = computed(() => (card.value ? renderCard({ match: match.value, card: card.value, size: size.value }) : ''));
const frame = computed(() => CARD_SIZES[size.value]);
const CARD_NAMES = { goal: 'Goal', red: 'Red card', fulltime: 'Full time' };

async function load() {
  try {
    matches.value = await api.matches();
    error.value = '';
  } catch (e) {
    error.value = e.message;
  }
}
onMounted(async () => {
  await Promise.all([load(), loadCardFont().catch(() => {})]);
  if (matches.value.length > 0) open(matches.value[0]);
});

const copy = (value) => JSON.parse(JSON.stringify(value));
const newId = () => `c${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

function open(saved) {
  match.value = copy(saved);
  cardId.value = match.value.cards[0]?.id ?? '';
  note.value = '';
}

function newMatch() {
  match.value = { id: null, home: '', away: '', competition: '', date: '', colours: { home: '#a50044', away: '#1d4ed8' }, cards: [] };
  cardId.value = '';
  note.value = '';
}

function duplicateMatch(saved) {
  match.value = { ...copy(saved), id: null, cards: copy(saved.cards).map((c) => ({ ...c, id: newId() + c.id.slice(-2) })) };
  cardId.value = match.value.cards[0]?.id ?? '';
  note.value = 'This is a copy. Change what you need, then save it as a new match.';
}

async function removeMatch(id) {
  try {
    await api.deleteMatch(id);
    confirming.value = '';
    if (match.value?.id === id) match.value = null;
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

/** The score after the latest goal card, as a starting point for the next card. */
function latestScore() {
  const goals = match.value.cards.filter((c) => c.type === 'goal');
  const last = goals.at(-1);
  return { homeScore: last?.homeScore ?? 0, awayScore: last?.awayScore ?? 0 };
}

/**
 * Scorer lines for a full-time card, from the goal cards: one line per
 * scorer with all their minutes. Mirrors scorersFromGoals in src/cards/match.js,
 * which cannot be loaded in a browser because it reads files.
 */
function scorers() {
  const goals = match.value.cards.filter((c) => c.type === 'goal').sort((a, b) => (a.minute ?? 0) - (b.minute ?? 0) || (a.added ?? 0) - (b.added ?? 0));
  const lines = { home: new Map(), away: new Map() };
  for (const goal of goals) {
    const type = goalType(goal.goalType);
    const mark = type.id === 'penalty' ? ' (pen)' : type.id === 'own-goal' ? ' (og)' : '';
    const who = goal.scorer || 'Unknown';
    lines[goal.team].set(who, [...(lines[goal.team].get(who) ?? []), `${minuteLabel(goal.minute, goal.added)}${mark}`.trim()]);
  }
  const write = (map) => [...map].map(([who, minutes]) => `${who} ${minutes.filter(Boolean).join(', ')}`.trim());
  return { homeScorers: write(lines.home), awayScorers: write(lines.away), ...latestScore() };
}

function addCard(type) {
  const id = newId();
  const fresh = {
    goal: { id, type, team: 'home', scorer: '', assist: '', minute: null, added: null, goalType: 'open-play', ...latestScore() },
    red: { id, type, team: 'home', player: '', minute: null, added: null, redType: 'straight', showScore: false, ...latestScore() },
    fulltime: { id, type, ...scorers() },
  }[type];
  match.value.cards.push(fresh);
  cardId.value = id;
}

function duplicateCard(original) {
  const twin = { ...copy(original), id: newId() };
  match.value.cards.splice(match.value.cards.indexOf(original) + 1, 0, twin);
  cardId.value = twin.id;
}

// Deleting a card of a saved match takes effect at once: the match is saved
// without it, and the server removes the card's pictures. Other changes made
// since the last save are saved with it.
async function removeCard(target) {
  match.value.cards = match.value.cards.filter((c) => c.id !== target.id);
  if (cardId.value === target.id) cardId.value = match.value.cards[0]?.id ?? '';
  confirming.value = '';
  if (!match.value.id) return; // a match that was never saved has nothing stored to delete
  if (problem.value) {
    note.value = 'The card is removed here. Enter both team names and save to make it final.';
    return;
  }
  try {
    await api.saveMatch(match.value);
    await load();
    note.value = 'Card deleted.';
  } catch (e) {
    error.value = e.message;
  }
}

// Replaces the two lists and the score. It runs only when the button is
// pressed, so lines edited by hand are never overwritten behind your back.
function fillFromGoals() {
  Object.assign(card.value, scorers());
}

function label(c) {
  if (c.type === 'goal') return `${minuteLabel(c.minute, c.added)} ${c.scorer || 'Goal'}`.trim();
  if (c.type === 'red') return `${minuteLabel(c.minute, c.added)} ${c.player || 'Red card'}`.trim();
  return `Full time ${c.homeScore}–${c.awayScore}`;
}

// Text boxes for the scorer lists: one scorer per line.
const lines = (key) => computed({
  get: () => (card.value?.[key] ?? []).join('\n'),
  set: (text) => (card.value[key] = text.split('\n').map((line) => line.trim()).filter(Boolean)),
});
const homeLines = lines('homeScorers');
const awayLines = lines('awayScorers');
// An empty number box means "not given".
const optional = (key) => computed({
  get: () => card.value?.[key] ?? '',
  set: (value) => (card.value[key] = value === '' || value === null ? null : Math.max(0, Math.round(Number(value)))),
});
const minute = optional('minute');
const added = optional('added');

const problem = computed(() => {
  if (!match.value) return '';
  if (!match.value.home.trim() || !match.value.away.trim()) return 'Enter both team names.';
  return '';
});

/** Save the match, then draw and store both pictures of every card. */
async function save() {
  saving.value = true;
  error.value = '';
  note.value = '';
  try {
    const saved = match.value.id ? await api.saveMatch(match.value) : await api.createMatch(match.value);
    for (const c of saved.cards) {
      for (const [name, { width, height }] of Object.entries(CARD_SIZES)) {
        const png = await cardPng(renderCard({ match: saved, card: c, size: name }), width, height);
        await api.saveCardPng(saved.id, c.id, name, png);
      }
    }
    const keep = cardId.value;
    await load();
    match.value = copy(saved);
    cardId.value = saved.cards.some((c) => c.id === keep) ? keep : saved.cards[0]?.id ?? '';
    note.value = `Saved, with ${saved.cards.length} ${saved.cards.length === 1 ? 'card' : 'cards'} ready for compilations.`;
  } catch (e) {
    error.value = e.message;
  }
  saving.value = false;
}

async function exportPng(name) {
  try {
    const { width, height } = CARD_SIZES[name];
    const png = await cardPng(renderCard({ match: match.value, card: card.value, size: name }), width, height);
    const file = `${label(card.value)} ${width}x${height}`.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').toLowerCase();
    download(png, `${file || 'card'}.png`);
  } catch (e) {
    error.value = e.message;
  }
}
</script>

<template>
  <div class="maker">
    <section class="panel list">
      <h2>Matches</h2>
      <button class="primary" @click="newMatch">New match</button>
      <p v-if="matches.length === 0" class="muted empty">No saved matches yet.</p>
      <div v-for="saved in matches" :key="saved.id" class="entry" :class="{ current: match?.id === saved.id }">
        <button class="open" @click="open(saved)">
          <strong>{{ saved.home }} v {{ saved.away }}</strong>
          <span class="muted">{{ [saved.competition, saved.date].filter(Boolean).join(' · ') || 'No details' }} · {{ saved.cards.length }} cards</span>
        </button>
        <div v-if="confirming !== `match:${saved.id}`" class="row tools">
          <button class="fixed small" @click="duplicateMatch(saved)">Duplicate</button>
          <TrashButton class="fixed" :label="`Delete the match ${saved.home} v ${saved.away}`" @click="confirming = `match:${saved.id}`" />
        </div>
        <div v-else class="confirm" role="alertdialog">
          <span>Delete this match and its cards? This cannot be undone.</span>
          <button class="small danger" @click="removeMatch(saved.id)">Delete</button>
          <button class="small" @click="confirming = ''">Cancel</button>
        </div>
      </div>
    </section>

    <div v-if="match" class="stack editor">
      <p v-if="error" class="error" role="alert">{{ error }}</p>

      <section class="panel">
        <h2>Match details</h2>
        <div class="row">
          <div><label for="home">Home team</label><input id="home" v-model="match.home" type="text" /></div>
          <div class="fixed"><label for="home-colour">Colour</label><input id="home-colour" v-model="match.colours.home" type="color" /></div>
          <div><label for="away">Away team</label><input id="away" v-model="match.away" type="text" /></div>
          <div class="fixed"><label for="away-colour">Colour</label><input id="away-colour" v-model="match.colours.away" type="color" /></div>
        </div>
        <div class="row second">
          <div><label for="competition">Competition (optional)</label><input id="competition" v-model="match.competition" type="text" /></div>
          <div><label for="date">Date (optional)</label><input id="date" v-model="match.date" type="text" /></div>
        </div>
      </section>

      <section class="panel">
        <h2>Cards</h2>
        <div class="row">
          <button class="fixed" @click="addCard('goal')">Add goal</button>
          <button class="fixed" @click="addCard('red')">Add red card</button>
          <button class="fixed" @click="addCard('fulltime')">Add full time</button>
        </div>
        <p v-if="match.cards.length === 0" class="muted empty">Add a card to start.</p>
        <div v-for="c in match.cards" :key="c.id" class="entry" :class="{ current: c.id === cardId }">
          <button class="open" @click="cardId = c.id">
            <strong>{{ label(c) }}</strong>
            <span class="muted">{{ CARD_NAMES[c.type] }}</span>
          </button>
          <div v-if="confirming !== `card:${c.id}`" class="row tools">
            <button class="fixed small" @click="cardId = c.id">Edit</button>
            <button class="fixed small" @click="duplicateCard(c)">Duplicate</button>
            <TrashButton class="fixed" :label="`Delete the card ${label(c)}`" @click="confirming = `card:${c.id}`" />
          </div>
          <div v-else class="confirm" role="alertdialog">
            <span>Delete this card and its pictures? This cannot be undone.</span>
            <button class="small danger" @click="removeCard(c)">Delete</button>
            <button class="small" @click="confirming = ''">Cancel</button>
          </div>
        </div>
      </section>

      <section v-if="card" class="panel">
        <h2>{{ CARD_NAMES[card.type] }}</h2>

        <template v-if="card.type === 'goal'">
          <div class="row">
            <div>
              <label for="team">Scoring team</label>
              <select id="team" v-model="card.team">
                <option value="home">{{ match.home || 'Home' }}</option>
                <option value="away">{{ match.away || 'Away' }}</option>
              </select>
            </div>
            <div><label for="scorer">Scorer</label><input id="scorer" v-model="card.scorer" type="text" /></div>
            <div>
              <label for="goal-type">Goal type</label>
              <select id="goal-type" v-model="card.goalType">
                <option v-for="type in GOAL_TYPES" :key="type.id" :value="type.id">{{ type.label }}</option>
              </select>
            </div>
          </div>
          <div class="row second">
            <div v-if="goalType(card.goalType).assist"><label for="assist">Assist (optional)</label><input id="assist" v-model="card.assist" type="text" /></div>
            <div class="narrow"><label for="minute">Minute</label><input id="minute" v-model="minute" type="number" min="0" /></div>
            <div class="narrow"><label for="added">Added time (optional)</label><input id="added" v-model="added" type="number" min="0" /></div>
            <div class="narrow"><label for="home-score">{{ match.home || 'Home' }} score after</label><input id="home-score" v-model.number="card.homeScore" type="number" min="0" /></div>
            <div class="narrow"><label for="away-score">{{ match.away || 'Away' }} score after</label><input id="away-score" v-model.number="card.awayScore" type="number" min="0" /></div>
          </div>
        </template>

        <template v-else-if="card.type === 'red'">
          <div class="row">
            <div><label for="player">Player</label><input id="player" v-model="card.player" type="text" /></div>
            <div>
              <label for="team">Team</label>
              <select id="team" v-model="card.team">
                <option value="home">{{ match.home || 'Home' }}</option>
                <option value="away">{{ match.away || 'Away' }}</option>
              </select>
            </div>
            <div>
              <label for="red-type">Type</label>
              <select id="red-type" v-model="card.redType">
                <option v-for="type in RED_TYPES" :key="type.id" :value="type.id">{{ type.label }}</option>
              </select>
            </div>
          </div>
          <div class="row second">
            <div class="narrow"><label for="minute">Minute</label><input id="minute" v-model="minute" type="number" min="0" /></div>
            <div class="narrow"><label for="added">Added time (optional)</label><input id="added" v-model="added" type="number" min="0" /></div>
            <label class="check fixed"><input v-model="card.showScore" type="checkbox" /> Show the current score</label>
            <template v-if="card.showScore">
              <div class="narrow"><label for="home-score">{{ match.home || 'Home' }}</label><input id="home-score" v-model.number="card.homeScore" type="number" min="0" /></div>
              <div class="narrow"><label for="away-score">{{ match.away || 'Away' }}</label><input id="away-score" v-model.number="card.awayScore" type="number" min="0" /></div>
            </template>
          </div>
        </template>

        <template v-else>
          <div class="row">
            <div class="narrow"><label for="home-score">{{ match.home || 'Home' }} final score</label><input id="home-score" v-model.number="card.homeScore" type="number" min="0" /></div>
            <div class="narrow"><label for="away-score">{{ match.away || 'Away' }} final score</label><input id="away-score" v-model.number="card.awayScore" type="number" min="0" /></div>
            <button class="fixed" @click="fillFromGoals">Fill from the goal cards</button>
          </div>
          <p class="muted hint">One scorer per line. “Fill from the goal cards” replaces both lists and the score with what the goal cards say.</p>
          <div class="row">
            <div><label for="home-scorers">{{ match.home || 'Home' }} scorers</label><textarea id="home-scorers" v-model="homeLines" rows="4" /></div>
            <div><label for="away-scorers">{{ match.away || 'Away' }} scorers</label><textarea id="away-scorers" v-model="awayLines" rows="4" /></div>
          </div>
        </template>
      </section>

      <section class="panel">
        <div class="row">
          <button class="fixed primary" :disabled="saving || Boolean(problem)" @click="save">{{ saving ? 'Saving…' : 'Save match and cards' }}</button>
          <span v-if="problem" class="muted">{{ problem }}</span>
          <span v-else role="status" class="muted">{{ note }}</span>
        </div>
      </section>
    </div>
    <p v-else class="muted">Choose a match, or start a new one.</p>

    <section v-if="match && card" class="panel preview">
      <h2>Preview</h2>
      <div class="row">
        <button class="fixed small" :class="{ primary: size === 'landscape' }" @click="size = 'landscape'">1920×1080</button>
        <button class="fixed small" :class="{ primary: size === 'portrait' }" @click="size = 'portrait'">1080×1920</button>
      </div>
      <!-- The template escapes every name, so this is safe to put in the page as it is. -->
      <div class="card" :class="size" :style="{ aspectRatio: `${frame.width} / ${frame.height}` }" v-html="svg" />
      <div class="row">
        <button class="fixed" @click="exportPng('landscape')">Export PNG 1920×1080</button>
        <button class="fixed" @click="exportPng('portrait')">Export PNG 1080×1920</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.maker { display: grid; grid-template-columns: 260px minmax(0, 1fr) minmax(280px, 420px); gap: 16px; align-items: start; }
.list .primary { width: 100%; margin-bottom: 10px; }
.empty { margin: 10px 0 0; }
.entry { border: 1px solid var(--line); border-radius: 8px; padding: 8px; margin-top: 8px; }
.entry.current { border-color: var(--accent); }
.open { display: flex; flex-direction: column; align-items: flex-start; width: 100%; text-align: left; border: 0; padding: 2px; background: transparent; font-size: 13px; }
.open strong { font-size: 14px; }
.tools { margin-top: 6px; align-items: center; }
.confirm { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 13px; margin-top: 6px; }
.confirm span { flex: 1 1 100%; }
.danger { background: var(--bad); border-color: var(--bad); color: #fff; font-weight: 600; }
.second { margin-top: 10px; }
.narrow { flex: 0 1 150px; }
.check { color: var(--text); font-size: 15px; padding-bottom: 6px; }
.hint { margin: 10px 0; font-size: 13px; }
input[type='color'] { width: 56px; height: 36px; padding: 2px; }
.preview { position: sticky; top: 8px; }
.card { width: 100%; margin: 10px 0; border-radius: 6px; overflow: hidden; background: #000; }
.card.portrait { max-width: 250px; }
.card :deep(svg) { display: block; width: 100%; height: 100%; }
@media (max-width: 1100px) { .maker { grid-template-columns: 1fr; } .preview { position: static; } }
</style>
