// Every call the pages make to the server (server/app.js).

async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
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
  cut: (options) => request('/api/cut', { method: 'POST', body: options }),
  render: (name) => request(`/api/clips/${enc(name)}/render`, { method: 'POST' }),
  job: (id) => request(`/api/jobs/${enc(id)}`),
  saveTranscript: (name, transcript) => request(`/api/clips/${enc(name)}/transcript`, { method: 'PUT', body: transcript }),
  savePost: (name, text) => request(`/api/clips/${enc(name)}/post`, { method: 'PUT', body: { text } }),
};
