<script setup>
// Make the still cards shown between reaction clips: goal, red card, full time.
// The preview and the exported PNG come from the same template functions
// (src/cards/templates.js), so they always match.
import { computed, onMounted, ref } from 'vue';
import { CARD_SIZES, GOAL_TYPES, goalType, minuteLabel, RED_TYPES } from '../../../src/cards/config.js';
import { movingLogo, movingLogoPicture, renderCard } from '../../../src/cards/templates.js';
import { api } from '../api.js';
import { cardPng, download, iconFromFile, loadCardFont } from '../cardPng.js';
import ClubLibrary from '../components/ClubLibrary.vue';
import Icon from '../components/Icon.vue';
import TrashButton from '../components/TrashButton.vue';

// Which side of the page is open: the matches and their cards, or the list of leagues and clubs.
const mode = ref('matches');
const library = ref({ leagues: [], clubs: [] });
const pickLeague = ref('');
const clubsToPick = computed(() => library.value.clubs.filter((club) => club.league === pickLeague.value));

const matches = ref([]);
const match = ref(null); // the match being edited: a copy, saved with the Save button
const cardId = ref('');
const size = ref('landscape');
const note = ref('');
const error = ref('');
const saving = ref(false);
const confirming = ref('');

// What the open match looked like when it was last saved or opened, to tell when it has changes.
const savedText = ref('');
const unsaved = computed(() => match.value !== null && JSON.stringify(match.value) !== savedText.value);

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
  await Promise.all([load(), loadCardFont().catch(() => {}), api.clubs().then((answer) => (library.value = answer), () => {})]);
  pickLeague.value = library.value.leagues[0]?.id ?? '';
  if (matches.value.length > 0) open(matches.value[0]);
});

const copy = (value) => JSON.parse(JSON.stringify(value));
const newId = () => `c${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

function open(saved) {
  match.value = copy(saved);
  savedText.value = JSON.stringify(match.value);
  cardId.value = match.value.cards[0]?.id ?? '';
  note.value = '';
}

function newMatch() {
  match.value = { id: null, home: '', away: '', competition: '', date: '', colours: { home: '#a50044', away: '#1d4ed8' }, short: { home: '', away: '' }, icons: { home: '', away: '' }, cards: [] };
  cardId.value = '';
  note.value = '';
  savedText.value = '';
}

function duplicateMatch(saved) {
  match.value = { ...copy(saved), id: null, cards: copy(saved.cards).map((c) => ({ ...c, id: newId() + c.id.slice(-2) })) };
  cardId.value = match.value.cards[0]?.id ?? '';
  note.value = 'This is a copy. Change what you need, then save it as a new match.';
  savedText.value = '';
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
    savedText.value = JSON.stringify(match.value);
    note.value = 'Card deleted.';
  } catch (e) {
    error.value = e.message;
  }
}

// --- Club icons -------------------------------------------------------------------

async function chooseIcon(side, file) {
  if (!file) return;
  error.value = '';
  try {
    match.value.icons[side] = await iconFromFile(file);
  } catch (e) {
    error.value = e.message;
  }
}

// Choosing a club from the list fills in a side of the match: its name, its
// colour and its logo. The match keeps its own copy, so it can still be
// changed here, and changing the club later does not change this match.
function useClub(side, clubId) {
  const club = library.value.clubs.find((known) => known.id === clubId);
  if (!club) return;
  match.value[side] = club.name;
  match.value.colours[side] = club.colour;
  match.value.icons[side] = club.icon;
  const league = library.value.leagues.find((known) => known.id === club.league);
  // The league becomes the competition unless something else was typed there.
  const leagueNames = library.value.leagues.map((known) => known.name);
  if (league && (!match.value.competition || leagueNames.includes(match.value.competition))) match.value.competition = league.name;
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

/** Save the match, then draw and store the pictures of every card, in both sizes. */
async function save() {
  saving.value = true;
  error.value = '';
  note.value = '';
  try {
    const saved = match.value.id ? await api.saveMatch(match.value) : await api.createMatch(match.value);
    for (const c of saved.cards) {
      for (const [name, { width, height }] of Object.entries(CARD_SIZES)) {
        await api.saveCardPng(saved.id, c.id, name, await cardPng(renderCard({ match: saved, card: c, size: name }), width, height));
        // On a goal and a red card the logo moves in a compilation. That takes two more pieces:
        // the card without that logo, and the logo by itself. They are saved after the card's
        // own picture, which is how a compilation knows they belong to it.
        const logo = movingLogo({ card: c, size: name });
        if (logo) {
          await api.saveCardPng(saved.id, c.id, name, await cardPng(renderCard({ match: saved, card: c, size: name, still: true }), width, height), 'still');
          await api.saveCardPng(saved.id, c.id, name, await cardPng(movingLogoPicture({ match: saved, card: c, size: name }), logo.room, logo.room), 'logo');
        }
      }
    }
    const keep = cardId.value;
    await load();
    match.value = copy(saved);
    savedText.value = JSON.stringify(match.value);
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
      <div class="choices side" role="group" aria-label="What to work on">
        <button :aria-pressed="mode === 'matches'" @click="mode = 'matches'">Matches</button>
        <button :aria-pressed="mode === 'clubs'" @click="mode = 'clubs'">Leagues and clubs</button>
      </div>
      <h2>Matches</h2>
      <button class="primary" @click="newMatch(); mode = 'matches'"><Icon name="plus" /> New match</button>
      <p v-if="matches.length === 0" class="empty">No saved matches yet. Start one with “New match”.</p>
      <div v-for="saved in matches" :key="saved.id" class="entry" :class="{ current: match?.id === saved.id }">
        <button class="open" @click="open(saved); mode = 'matches'">
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

    <ClubLibrary v-if="mode === 'clubs'" class="clubs" :library="library" @changed="library = $event" />

    <div v-else-if="match" class="stack editor">
      <p v-if="error" class="error" role="alert">{{ error }}</p>

      <section class="panel">
        <h2>Match details</h2>
        <div v-if="library.clubs.length > 0" class="row from-list">
          <div>
            <label for="pick-league">League</label>
            <select id="pick-league" v-model="pickLeague">
              <option v-for="known in library.leagues" :key="known.id" :value="known.id">{{ known.name }}</option>
            </select>
          </div>
          <div v-for="side in ['home', 'away']" :key="side">
            <label :for="`pick-${side}`">{{ side === 'home' ? 'Home' : 'Away' }} club from the list</label>
            <select :id="`pick-${side}`" @change="useClub(side, $event.target.value); $event.target.value = ''">
              <option value="">Choose…</option>
              <option v-for="club in clubsToPick" :key="club.id" :value="club.id">{{ club.name }}</option>
            </select>
          </div>
        </div>
        <p v-if="library.clubs.length > 0" class="hint from-list-hint">
          Choosing a club fills in its name, colour and logo below. You can still change them for this match. Edit the
          list under “Leagues and clubs”.
        </p>
        <div class="row">
          <div><label for="home">Home team</label><input id="home" v-model="match.home" type="text" /></div>
          <div class="fixed"><label for="home-colour">Colour</label><input id="home-colour" v-model="match.colours.home" type="color" /></div>
          <div><label for="away">Away team</label><input id="away" v-model="match.away" type="text" /></div>
          <div class="fixed"><label for="away-colour">Colour</label><input id="away-colour" v-model="match.colours.away" type="color" /></div>
        </div>
        <div class="row second">
          <div><label for="home-short">{{ match.home || 'Home team' }}: short name (optional)</label><input id="home-short" v-model="match.short.home" type="text" maxlength="12" placeholder="for example BAR" autocomplete="off" /></div>
          <div><label for="away-short">{{ match.away || 'Away team' }}: short name (optional)</label><input id="away-short" v-model="match.short.away" type="text" maxlength="12" placeholder="for example RMA" autocomplete="off" /></div>
        </div>
        <p class="hint">
          The short names are for the chapter list under a compilation's video, such as “BAR 1-0 RMA”. Left empty, the
          full names are used. They are not drawn on the cards.
        </p>
        <div class="row second">
          <div><label for="competition">Competition (optional)</label><input id="competition" v-model="match.competition" type="text" /></div>
          <div><label for="date">Date (optional)</label><input id="date" v-model="match.date" type="text" /></div>
        </div>
        <div class="row second icons">
          <div v-for="side in ['home', 'away']" :key="side" class="icon-pick">
            <span class="thumb" :class="{ empty: !match.icons[side] }">
              <img v-if="match.icons[side]" :src="match.icons[side]" :alt="`Icon of the ${side} team`" />
              <span v-else aria-hidden="true">{{ (match[side] || '?').trim().charAt(0).toUpperCase() }}</span>
            </span>
            <div>
              <label :for="`icon-${side}`">{{ match[side] || (side === 'home' ? 'Home team' : 'Away team') }}: club icon (optional)</label>
              <input :id="`icon-${side}`" type="file" accept="image/*" @change="chooseIcon(side, $event.target.files[0]); $event.target.value = ''" />
              <button v-if="match.icons[side]" class="small" @click="match.icons[side] = ''">Remove the icon</button>
            </div>
          </div>
        </div>
        <p class="hint">
          An icon is a picture from your own computer; the tool fetches none. It is shown on every card. Without
          one, the card shows the team's first letter on its colour.
        </p>
      </section>

      <section class="panel">
        <h2>Cards</h2>
        <div class="row">
          <button class="fixed" @click="addCard('goal')"><Icon name="plus" /> Goal</button>
          <button class="fixed" @click="addCard('red')"><Icon name="plus" /> Red card</button>
          <button class="fixed" @click="addCard('fulltime')"><Icon name="plus" /> Full time</button>
        </div>
        <p v-if="match.cards.length === 0" class="empty">No cards yet. Add a goal, a red card or the full-time score.</p>
        <div v-for="c in match.cards" :key="c.id" class="entry" :class="{ current: c.id === cardId }">
          <button class="open" @click="cardId = c.id">
            <strong>{{ label(c) }}</strong>
            <span class="muted">{{ CARD_NAMES[c.type] }}{{ c.id === cardId ? ' · being edited below' : '' }}</span>
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

      <!-- Always in view, so a change is never left unsaved by accident. -->
      <div class="savebar">
        <span v-if="problem" class="say problem"><Icon name="alert" /> {{ problem }}</span>
        <span v-else-if="unsaved" class="say"><span class="chip warn">Changes not saved</span> {{ note }}</span>
        <span v-else role="status" class="say muted">{{ note || 'Everything is saved.' }}</span>
        <button class="primary" :disabled="saving || Boolean(problem)" @click="save">
          <span v-if="saving" class="spinner" aria-hidden="true" /> {{ saving ? 'Saving…' : 'Save match and cards' }}
        </button>
      </div>
    </div>
    <p v-else class="empty wide">Choose a match on the left, or start a new one.</p>

    <section v-if="mode === 'matches' && match && card" class="panel preview">
      <div class="row middle">
        <h2 class="fixed">Preview</h2>
        <span />
        <div class="choices" role="group" aria-label="Size of the preview">
          <button :aria-pressed="size === 'landscape'" @click="size = 'landscape'">Wide</button>
          <button :aria-pressed="size === 'portrait'" @click="size = 'portrait'">Tall</button>
        </div>
      </div>
      <!-- The template escapes every name, so this is safe to put in the page as it is. -->
      <div class="card" :class="size" :style="{ aspectRatio: `${frame.width} / ${frame.height}` }" v-html="svg" />
      <div class="row">
        <button class="fixed" @click="exportPng('landscape')"><Icon name="download" /> PNG 1920×1080</button>
        <button class="fixed" @click="exportPng('portrait')"><Icon name="download" /> PNG 1080×1920</button>
      </div>
      <p class="hint">The picture is exactly what a compilation shows. In a compilation the logo of the club that scored, or had a player sent off, leans right and left.</p>
    </section>
  </div>
</template>

<style scoped>
.maker { display: grid; grid-template-columns: 270px minmax(0, 1fr) minmax(280px, 420px); gap: var(--gap); align-items: start; }
.list .primary { width: 100%; }
.side { display: flex; margin-bottom: 14px; }
.side button { flex: 1; }
/* The list of leagues and clubs takes the room of the editor and the preview. */
.clubs { grid-column: 2 / -1; min-width: 0; }
.from-list-hint { margin: 6px 0 14px; padding-bottom: 12px; border-bottom: 1px dashed var(--line); }
.empty.wide { align-self: start; margin: 0; padding: 28px; }
.second { margin-top: 12px; }
.narrow { flex: 0 1 150px; }
.check { padding-bottom: 8px; }
.first { margin: 0 0 12px; }
.icon-pick { display: flex; align-items: center; gap: 12px; flex: 1 1 300px; }
.icon-pick button { margin-top: 6px; }
/* The icon as the owner chose it, on a dark square like the card it will sit on. */
.thumb {
  display: grid; place-items: center; width: 64px; height: 64px; flex: none; border-radius: var(--radius);
  background: var(--text); color: var(--bg); font-weight: 700; font-size: 26px; overflow: hidden;
}
.thumb img { width: 100%; height: 100%; object-fit: contain; }
.editor .hint { margin: 10px 0; }
.preview { position: sticky; top: 16px; }
.preview h2 { margin: 0; }
/* The card's own colours are the teams'. They do not follow the palette. */
.card { width: 100%; margin: 12px auto; border-radius: var(--radius); overflow: hidden; background: black; box-shadow: 0 2px 10px var(--shadow); }
.card.portrait { max-width: 250px; }
.card :deep(svg) { display: block; width: 100%; height: 100%; }
.savebar {
  position: sticky; bottom: 0; z-index: 4; display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 12px 16px;
  background: var(--panel); border: 1px solid var(--line); border-bottom: 0;
  border-radius: var(--radius-large) var(--radius-large) 0 0; box-shadow: 0 -4px 14px var(--shadow);
}
.savebar .say { flex: 1 1 200px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.savebar .problem { color: var(--warn); font-weight: 600; }
@media (max-width: 1100px) { .maker { grid-template-columns: 1fr; } .preview { position: static; } }
</style>
