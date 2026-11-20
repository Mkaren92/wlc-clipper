<script setup>
// The owner's leagues and clubs: add, rename, recolour, give a logo, delete.
// Every change is saved at once, and the server answers with the whole list.
import { computed, ref, watch } from 'vue';
import { api } from '../api.js';
import { iconFromFile } from '../cardPng.js';
import Icon from './Icon.vue';
import TrashButton from './TrashButton.vue';

const props = defineProps({ library: { type: Object, required: true } }); // { leagues, clubs }
const emit = defineEmits(['changed']);

const leagueId = ref('');
// Keep a league chosen: the first one to begin with, and another when the chosen one is deleted.
watch(() => props.library.leagues, (leagues) => {
  if (!leagues.some((known) => known.id === leagueId.value)) leagueId.value = leagues[0]?.id ?? '';
}, { immediate: true });
const league = computed(() => props.library.leagues.find((known) => known.id === leagueId.value) ?? null);
const clubs = computed(() => props.library.clubs.filter((club) => club.league === leagueId.value));
const countIn = (id) => props.library.clubs.filter((club) => club.league === id).length;

const error = ref('');
const note = ref('');
const confirming = ref('');
const newLeague = ref('');
const newClub = ref({ name: '', colour: '#5b6475' });

/** Make one change on the server and show the list it answers with. */
async function change(work, done) {
  error.value = '';
  note.value = '';
  try {
    const library = await work();
    emit('changed', library);
    note.value = done;
    return library;
  } catch (e) {
    error.value = e.message;
    return null;
  }
}

async function addLeague() {
  const name = newLeague.value.trim();
  if (!name) return;
  const library = await change(() => api.addLeague(name), `Added the league ${name}.`);
  if (!library) return;
  newLeague.value = '';
  leagueId.value = library.leagues.at(-1).id;
}
const renameLeague = (name) => name.trim() && name.trim() !== league.value.name && change(() => api.renameLeague(leagueId.value, name.trim()), 'League renamed.');
async function deleteLeague() {
  confirming.value = '';
  await change(() => api.deleteLeague(leagueId.value), 'League deleted.');
}

async function addClub() {
  const name = newClub.value.name.trim();
  if (!name || !league.value) return;
  const added = await change(() => api.addClub({ name, league: leagueId.value, colour: newClub.value.colour }), `Added ${name}.`);
  if (added) newClub.value = { name: '', colour: '#5b6475' };
}
const saveClub = (club, changes) => change(() => api.saveClub(club.id, changes), `${club.name} saved.`);
function rename(club, name) {
  if (name.trim() && name.trim() !== club.name) saveClub(club, { name: name.trim() });
}
async function setLogo(club, file) {
  if (!file) return;
  try {
    await saveClub(club, { icon: await iconFromFile(file) });
  } catch (e) {
    error.value = e.message;
  }
}
async function deleteClub(club) {
  confirming.value = '';
  await change(() => api.deleteClub(club.id), `${club.name} deleted.`);
}
</script>

<template>
  <div class="stack">
    <section class="panel">
      <h2>Leagues</h2>
      <p class="hint first">
        Your leagues and their clubs. Choosing a club for a match fills in its name, colour and logo. A league can be
        anything that groups teams, such as “Countries” for national teams.
      </p>
      <div class="leagues" role="group" aria-label="Leagues">
        <button
          v-for="known in library.leagues" :key="known.id" :class="{ primary: known.id === leagueId }"
          :aria-pressed="known.id === leagueId" @click="leagueId = known.id; confirming = ''"
        >
          {{ known.name }} <span class="chip">{{ countIn(known.id) }}</span>
        </button>
      </div>
      <div class="row add">
        <div><label for="new-league">New league</label><input id="new-league" v-model="newLeague" type="text" maxlength="60" @keyup.enter="addLeague" /></div>
        <button class="fixed" :disabled="!newLeague.trim()" @click="addLeague"><Icon name="plus" /> Add the league</button>
      </div>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
    </section>

    <section v-if="league" class="panel">
      <div class="row">
        <div><label for="league-name">League name</label><input id="league-name" :value="league.name" type="text" maxlength="60" @change="renameLeague($event.target.value)" /></div>
        <TrashButton v-if="confirming !== 'league'" class="fixed" :label="`Delete the league ${league.name}`" @click="confirming = 'league'" />
      </div>
      <div v-if="confirming === 'league'" class="confirm" role="alertdialog">
        <span>Delete {{ league.name }} and its {{ clubs.length }} {{ clubs.length === 1 ? 'club' : 'clubs' }}? This cannot be undone. Matches already made keep their teams.</span>
        <button class="small danger" @click="deleteLeague">Delete</button>
        <button class="small" @click="confirming = ''">Cancel</button>
      </div>

      <h3 class="clubs-title">Clubs <span class="chip mark">{{ clubs.length }}</span></h3>
      <p v-if="clubs.length === 0" class="empty">No clubs in this league yet. Add the first one below.</p>
      <div v-for="club in clubs" :key="club.id" class="club">
        <!-- The club's own colour and logo, as the owner set them: data, not part of the page's colours. -->
        <span class="thumb" :style="club.icon ? {} : { background: club.colour }">
          <img v-if="club.icon" :src="club.icon" :alt="`Logo of ${club.name}`" />
          <span v-else aria-hidden="true">{{ club.name.charAt(0).toUpperCase() }}</span>
        </span>
        <div class="name"><label :for="`club-name-${club.id}`">Name</label><input :id="`club-name-${club.id}`" :value="club.name" type="text" maxlength="80" @change="rename(club, $event.target.value)" /></div>
        <div class="fixed"><label :for="`club-colour-${club.id}`">Colour</label><input :id="`club-colour-${club.id}`" :value="club.colour" type="color" @change="saveClub(club, { colour: $event.target.value })" /></div>
        <div class="logo">
          <label :for="`club-logo-${club.id}`">Logo</label>
          <input :id="`club-logo-${club.id}`" type="file" accept="image/*" @change="setLogo(club, $event.target.files[0]); $event.target.value = ''" />
        </div>
        <button v-if="club.icon" class="fixed small" @click="saveClub(club, { icon: '' })">Remove logo</button>
        <TrashButton v-if="confirming !== club.id" class="fixed" :label="`Delete ${club.name}`" @click="confirming = club.id" />
        <div v-else class="confirm" role="alertdialog">
          <span>Delete {{ club.name }}? This cannot be undone.</span>
          <button class="small danger" @click="deleteClub(club)">Delete</button>
          <button class="small" @click="confirming = ''">Cancel</button>
        </div>
      </div>

      <div class="row add">
        <div><label for="new-club">New club in {{ league.name }}</label><input id="new-club" v-model="newClub.name" type="text" maxlength="80" @keyup.enter="addClub" /></div>
        <div class="fixed"><label for="new-club-colour">Colour</label><input id="new-club-colour" v-model="newClub.colour" type="color" /></div>
        <button class="fixed" :disabled="!newClub.name.trim()" @click="addClub"><Icon name="plus" /> Add the club</button>
      </div>
      <p class="hint">
        Changes are saved as you make them. A logo is a picture from your own computer; the tool fetches none. The
        clubs each league started with were written from memory of the 2025–26 season, so check them.
      </p>
      <p role="status" class="muted note">{{ note }}</p>
    </section>
  </div>
</template>

<style scoped>
.first { margin: 0 0 12px; }
.leagues { display: flex; flex-wrap: wrap; gap: 8px; }
.leagues .chip { margin-left: 2px; }
.add { margin-top: 14px; }
.clubs-title { display: flex; align-items: center; gap: 8px; margin: 18px 0 4px; }
.club {
  display: flex; flex-wrap: wrap; align-items: end; gap: 10px; padding: 10px 0; border-top: 1px solid var(--line);
}
.club .name { flex: 2 1 180px; }
.club .logo { flex: 1 1 220px; min-width: 0; }
.club .confirm { flex: 1 1 100%; margin: 0; }
.thumb {
  display: grid; place-items: center; width: 44px; height: 44px; flex: none; border-radius: var(--radius);
  background: var(--text); color: white; font-weight: 700; font-size: 20px; overflow: hidden;
  /* A letter has to read on whatever colour the club has. */
  text-shadow: 0 0 3px black, 0 0 1px black;
}
.thumb img { width: 100%; height: 100%; object-fit: contain; }
.note { min-height: 1.5em; margin: 8px 0 0; }
</style>
