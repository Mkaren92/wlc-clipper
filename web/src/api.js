// Every call the pages make to the server (server/app.js).

async function request(path, { method = 'GET', body } = {}) {
  // A picture is sent as it is; everything else as JSON.
  const isPicture = body instanceof Blob;
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': isPicture ? 'image/png' : 'application/json' },
    body: body === undefined ? undefined : isPicture ? body : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `The server answered ${response.status}.`);
  return data;
}

const enc = encodeURIComponent;

export const api = {
  videos: () => request('/api/videos'),
  video: (name, trim = 0) => request(`/api/videos/${enc(name)}?trim=${trim}`),
  videoUrl: (name) => `/media/in/${enc(name)}`,
  briefs: () => request('/api/briefs'),
  clips: () => request('/api/clips'),
  clip: (name) => request(`/api/clips/${enc(name)}`),
  clipUrl: (name, version) => `/media/out/${enc(name)}/clip.mp4?v=${version}`,
  check: (name) => request(`/api/clips/${enc(name)}/check`),
  deleteClip: (name) => request(`/api/clips/${enc(name)}`, { method: 'DELETE' }),
  cut: (options) => request('/api/cut', { method: 'POST', body: options }),
  matches: () => request('/api/matches'),
  createMatch: (match) => request('/api/matches', { method: 'POST', body: match }),
  saveMatch: (match) => request(`/api/matches/${enc(match.id)}`, { method: 'PUT', body: match }),
  deleteMatch: (id) => request(`/api/matches/${enc(id)}`, { method: 'DELETE' }),
  saveCardPng: (matchId, cardId, size, png) => request(`/api/matches/${enc(matchId)}/cards/${enc(cardId)}/png/${size}`, { method: 'PUT', body: png }),
  cardPngUrl: (matchId, cardId, size) => `/media/cards/${enc(matchId)}/${enc(cardId)}/${size}`,
  compilations: () => request('/api/compilations'),
  createCompilation: (timeline) => request('/api/compilations', { method: 'POST', body: timeline }),
  saveCompilation: (timeline) => request(`/api/compilations/${enc(timeline.id)}`, { method: 'PUT', body: timeline }),
  deleteCompilation: (id) => request(`/api/compilations/${enc(id)}`, { method: 'DELETE' }),
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
  parts: () => request('/api/parts'),
  partUrl: (name) => `/media/parts/${enc(name)}`,
  savePart: (options) => request('/api/parts', { method: 'POST', body: options }),
  deletePart: (name) => request(`/api/parts/${enc(name)}`, { method: 'DELETE' }),
  ai: () => request('/api/ai'),
  suggest: (options) => request('/api/suggest', { method: 'POST', body: options }),
  fixWords: (name) => request(`/api/clips/${enc(name)}/fix-words`, { method: 'POST' }),
  render: (name) => request(`/api/clips/${enc(name)}/render`, { method: 'POST' }),
  jobs: () => request('/api/jobs'),
  saveTranscript: (name, transcript) => request(`/api/clips/${enc(name)}/transcript`, { method: 'PUT', body: transcript }),
  savePost: (name, text) => request(`/api/clips/${enc(name)}/post`, { method: 'PUT', body: { text } }),
};
