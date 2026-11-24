// Every call the pages make to the server (server/app.js).

async function request(path, { method = 'GET', body, headers = {} } = {}) {
  // A picture is sent as it is; everything else as JSON.
  const isPicture = body instanceof Blob;
  const response = await fetch(path, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': isPicture ? 'image/png' : 'application/json' }) },
    body: body === undefined ? undefined : isPicture ? body : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `The server answered ${response.status}.`);
  return data;
}

const enc = encodeURIComponent;

export const api = {
  videos: () => request('/api/videos'),
  deleteVideo: (name) => request(`/api/videos/${enc(name)}`, { method: 'DELETE' }),
  video: (name, trim = 0, cropWidth) =>
    request(`/api/videos/${enc(name)}?trim=${trim}${cropWidth ? `&cropWidth=${cropWidth}` : ''}`),
  videoUrl: (name) => `/media/in/${enc(name)}`,
  briefs: () => request('/api/briefs'),
  clips: () => request('/api/clips'),
  clip: (name) => request(`/api/clips/${enc(name)}`),
  clipUrl: (name, version) => `/media/out/${enc(name)}/clip.mp4?v=${version}`,
  check: (name) => request(`/api/clips/${enc(name)}/check`),
  deleteClip: (name) => request(`/api/clips/${enc(name)}`, { method: 'DELETE' }),
  cut: (options) => request('/api/cut', { method: 'POST', body: options }),
  // Leagues and clubs. Every change answers with the whole list.
  clubs: () => request('/api/clubs'),
  addLeague: (name) => request('/api/leagues', { method: 'POST', body: { name } }),
  renameLeague: (id, name) => request(`/api/leagues/${enc(id)}`, { method: 'PUT', body: { name } }),
  deleteLeague: (id) => request(`/api/leagues/${enc(id)}`, { method: 'DELETE' }),
  addClub: (club) => request('/api/clubs', { method: 'POST', body: club }),
  saveClub: (id, changes) => request(`/api/clubs/${enc(id)}`, { method: 'PUT', body: changes }),
  deleteClub: (id) => request(`/api/clubs/${enc(id)}`, { method: 'DELETE' }),
  matches: () => request('/api/matches'),
  createMatch: (match) => request('/api/matches', { method: 'POST', body: match }),
  saveMatch: (match) => request(`/api/matches/${enc(match.id)}`, { method: 'PUT', body: match }),
  deleteMatch: (id) => request(`/api/matches/${enc(id)}`, { method: 'DELETE' }),
  saveCardPng: (matchId, cardId, size, png, clear = false) =>
    request(`/api/matches/${enc(matchId)}/cards/${enc(cardId)}/png/${size}${clear ? '?clear=1' : ''}`, { method: 'PUT', body: png }),
  cardPngUrl: (matchId, cardId, size) => `/media/cards/${enc(matchId)}/${enc(cardId)}/${size}`,
  compilations: () => request('/api/compilations'),
  createCompilation: (timeline) => request('/api/compilations', { method: 'POST', body: timeline }),
  saveCompilation: (timeline) => request(`/api/compilations/${enc(timeline.id)}`, { method: 'PUT', body: timeline }),
  deleteCompilation: (id) => request(`/api/compilations/${enc(id)}`, { method: 'DELETE' }),
  // Two videos side by side, made into one (the Combine page).
  combinations: () => request('/api/combinations'),
  createCombination: (combination) => request('/api/combinations', { method: 'POST', body: combination }),
  saveCombination: (combination) => request(`/api/combinations/${enc(combination.id)}`, { method: 'PUT', body: combination }),
  deleteCombination: (id) => request(`/api/combinations/${enc(id)}`, { method: 'DELETE' }),
  generateCombination: (id) => request(`/api/combinations/${enc(id)}/generate`, { method: 'POST' }),
  combinedUrl: (id, version) => `/media/combinations/${enc(id)}/combined.mp4?v=${version}`,
  sounds: () => request('/api/sounds'),
  // Where a card's sound can be heard from; null for "none". `auto` is the sound "auto" stands for on that card.
  soundUrl(choice, auto) {
    const sound = choice === 'auto' ? auto : choice;
    return sound.startsWith('file:') ? `/media/sounds/file/${enc(sound.slice(5))}` : null;
  },
  generate: (id) => request(`/api/compilations/${enc(id)}/generate`, { method: 'POST' }),
  finalUrl: (id, version) => `/media/compilations/${enc(id)}/final.mp4?v=${version}`,
  videoInfo: (library, name) => request(`/api/library/${library}/${enc(name)}`),
  // Copies a file chosen in the browser into the videos folder.
  async upload(file) {
    const response = await fetch(`/api/uploads/${enc(file.name)}`, { method: 'PUT', body: file });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error ?? `The server answered ${response.status}.`);
    return data;
  },
  // Sync with a private GitHub repository.
  sync: () => request('/api/sync'),
  syncLook: (address) => request('/api/sync/look', { method: 'POST', body: { address } }),
  syncConnect: (address, wins) => request('/api/sync/connect', { method: 'POST', body: { address, wins } }),
  syncNow: () => request('/api/sync/now', { method: 'POST' }),
  syncOff: () => request('/api/sync', { method: 'DELETE' }),
  sources: () => request('/api/sources'),
  // `version` is the mark the list came with; the server refuses the save when the list has changed since.
  saveSources: (sources, version) => request('/api/sources', { method: 'PUT', body: sources, headers: version ? { 'X-List-Version': version } : {} }),
  // Changes to one saved channel, which leave every other channel as it is on the server.
  setSourceClubs: (id, clubs) => request(`/api/sources/${enc(id)}/clubs`, { method: 'PUT', body: { clubs } }),
  deleteSource: (id) => request(`/api/sources/${enc(id)}`, { method: 'DELETE' }),
  // Which channels are live: the last answer, and asking YouTube again.
  live: () => request('/api/sources/live'),
  checkLive: () => request('/api/sources/live', { method: 'POST' }),
  syncSource: (source) => request('/api/sources/sync', { method: 'POST', body: source }),
  fetchPictures: () => request('/api/sources/pictures', { method: 'POST' }),
  sourcePictureUrl: (id, version) => `/media/source-pictures/${enc(id)}?v=${version}`,
  fetchVideo: (options) => request('/api/fetch', { method: 'POST', body: options }),
  parts: () => request('/api/parts'),
  partUrl: (name) => `/media/parts/${enc(name)}`,
  savePart: (options) => request('/api/parts', { method: 'POST', body: options }),
  deletePart: (name) => request(`/api/parts/${enc(name)}`, { method: 'DELETE' }),
  // Puts a part among the videos, so clips can be cut from it. Answers { video, linked, already }.
  partToVideo: (name) => request(`/api/parts/${enc(name)}/to-videos`, { method: 'POST' }),
  ai: () => request('/api/ai'),
  suggest: (options) => request('/api/suggest', { method: 'POST', body: options }),
  suggestHook: (options) => request('/api/suggest-hook', { method: 'POST', body: options }),
  // Overlay images: PNG files in the overlays folder, named, never given as paths.
  overlays: () => request('/api/overlays'),
  // A video's chat, for suggested moments. Detection runs in the page; these bring a chat in and keep it.
  chat: (video) => request(`/api/chat/${enc(video)}`),
  keptTranscript: (video, lang) => request(`/api/transcript/${enc(video)}?lang=${enc(lang)}`),
  fetchChat: (video, options) => request(`/api/chat/${enc(video)}/fetch`, { method: 'POST', body: options }),
  // A chat file goes as it is, as text: it can be larger than an ordinary request.
  importChat: async (video, name, text, offset) => {
    const response = await fetch(`/api/chat/${enc(video)}/import?name=${enc(name)}${Number.isFinite(offset) ? `&offset=${offset}` : ''}`, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: text });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error ?? `The server answered ${response.status}.`);
    return data;
  },
  // A Twitch stream's chat file, for clips from that stream's chat. The file is sent as it is.
  importStreamChat: async (url, name, file) => {
    const response = await fetch(`/api/stream-chat?url=${enc(url)}&name=${enc(name)}`, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: file });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error ?? `The server answered ${response.status}.`);
    return data;
  },
  setChatOffset: (video, offset) => request(`/api/chat/${enc(video)}/offset`, { method: 'PUT', body: { offset } }),
  deleteChat: (video) => request(`/api/chat/${enc(video)}`, { method: 'DELETE' }),
  checkChat: (video, options) => request(`/api/chat/${enc(video)}/check`, { method: 'POST', body: options }),
  clipsFromChat: (options) => request('/api/chat-clips', { method: 'POST', body: options }),
  fixWords: (name) => request(`/api/clips/${enc(name)}/fix-words`, { method: 'POST' }),
  render: (name) => request(`/api/clips/${enc(name)}/render`, { method: 'POST' }),
  jobs: () => request('/api/jobs'),
  stopJob: (id) => request(`/api/jobs/${enc(id)}/stop`, { method: 'POST' }),
  saveTranscript: (name, transcript) => request(`/api/clips/${enc(name)}/transcript`, { method: 'PUT', body: transcript }),
  savePost: (name, text) => request(`/api/clips/${enc(name)}/post`, { method: 'PUT', body: { text } }),
};
