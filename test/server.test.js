// Starts the dashboard's server on a free port with temporary folders.
// Needs ffmpeg, but neither Python nor the built web pages.
import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { run } from '../src/run.js';

let dir;
let server;
let base;
let jobs;

const fakeTranscriber = {
  name: 'fake',
  isInstalled: async () => true,
  transcribe: async () => ({
    language: 'en',
    words: [
      { text: 'He', start: 0.3, end: 0.5 },
      { text: 'did', start: 0.5, end: 0.7 },
      { text: 'not.', start: 0.7, end: 0.95 },
    ],
  }),
};

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'clipper-server-'));
  for (const name of ['in', 'out', 'briefs']) await mkdir(path.join(dir, name));
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    path.join(dir, 'in', 'game.mp4'),
  ]);
  await writeFile(path.join(dir, 'in', 'notes.txt'), 'not a video');
  await writeFile(path.join(dir, 'in', '.hidden.mp4'), 'hidden');
  await writeFile(path.join(dir, 'secret.mp4'), 'outside the videos folder');
  await writeFile(
    path.join(dir, 'briefs', 'demo.json'),
    JSON.stringify({ id: 'demo', maxSeconds: 10, hashtags: { required: ['#demo'] }, manualChecks: ['Pin a comment'] }),
  );
  await writeFile(path.join(dir, 'briefs', 'broken.json'), '{ "id": "broken", "maxSecond": 1 }');

  const built = createApp({
    inDir: path.join(dir, 'in'),
    outDir: path.join(dir, 'out'),
    briefsDir: path.join(dir, 'briefs'),
    toolVersion: 'test',
    transcriber: fakeTranscriber,
  });
  jobs = built.jobs;
  server = built.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
}, 60_000);

afterAll(async () => {
  await jobs.idle();
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

async function api(pathname, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(base + pathname, {
    method,
    headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: response.status, data, headers: response.headers };
}

/** fetch() will not send a made-up Host header, so this uses http directly. */
function statusWithHost(host) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    http.get({ host: '127.0.0.1', port, path: '/api/videos', headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
}

async function finished(jobId) {
  for (;;) {
    const { data } = await api(`/api/jobs/${jobId}`);
    if (data.status === 'done' || data.status === 'failed') return data;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('videos', () => {
  it('lists only video files in the videos folder', async () => {
    const { data } = await api('/api/videos');
    expect(data.map((video) => video.name)).toEqual(['game.mp4']);
  });

  it('describes a video and where each layout falls on it', async () => {
    const { data } = await api('/api/videos/game.mp4?trim=10');
    expect(data).toMatchObject({ name: 'game.mp4', width: 1920, height: 1080, fps: 30, audioStreams: 1 });
    expect(data.path).toBeUndefined();
    expect(data.layouts.center).toEqual({ x: 662, y: 10, width: 596, height: 1060, minX: 10, maxX: 1314 });
    expect(data.layouts.area).toEqual({ x: 10, y: 10, width: 1900, height: 1060 });
  });

  it('rejects a trim that is too large', async () => {
    const { status, data } = await api('/api/videos/game.mp4?trim=500');
    expect(status).toBe(400);
    expect(data.error).toMatch(/at most 54 pixels/);
  });

  it('serves part of a video, so the player can seek', async () => {
    const response = await fetch(`${base}/media/in/game.mp4`, { headers: { Range: 'bytes=0-99' } });
    expect(response.status).toBe(206);
    expect((await response.arrayBuffer()).byteLength).toBe(100);
  });

  it.each([
    '/api/videos/..%2Fsecret.mp4',
    '/media/in/..%2Fsecret.mp4',
    '/media/in/%2Fetc%2Fpasswd',
    '/api/videos/.hidden.mp4',
    '/api/videos/notes.txt',
    '/api/clips/..%2Fin',
    '/media/out/..%2Fin/clip.mp4',
  ])('finds nothing outside its folders: %s', async (pathname) => {
    expect((await api(pathname)).status).toBe(404);
  });
});

describe('who may ask', () => {
  it('refuses a request sent by another web page', async () => {
    const { status } = await api('/api/cut', {
      method: 'POST', body: { video: 'game.mp4', start: 0, end: 1 }, headers: { Origin: 'https://example.com' },
    });
    expect(status).toBe(403);
    expect((await api('/api/clips')).data).toEqual([]);
  });

  it('refuses a request addressed to another host name', async () => {
    expect(await statusWithHost('evil.example:80')).toBe(403);
    expect(await statusWithHost(`localhost:${server.address().port}`)).toBe(200);
  });
});

describe('briefs', () => {
  it('lists briefs, and says what is wrong with a broken one', async () => {
    const { data } = await api('/api/briefs');
    expect(data.map((b) => [b.file, b.ok])).toEqual([['broken.json', false], ['demo.json', true]]);
    expect(data[0].error).toMatch(/Unrecognized key: "maxSecond"/);
    expect(data[1].brief.hashtags.required).toEqual(['#demo']);
  });
});

describe('cutting', () => {
  it('explains a request it cannot use', async () => {
    const bad = await api('/api/cut', { method: 'POST', body: { video: 'game.mp4', start: '1:xx', end: 2 } });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toMatch(/is not a time/);
    expect((await api('/api/cut', { method: 'POST', body: { video: 'nope.mp4', start: 0, end: 1 } })).status).toBe(404);
  });

  it('cuts two clips one after the other, then shows, edits, re-renders and checks one', async () => {
    const request = { video: 'game.mp4', start: '0:01', end: 3, layout: 'center', cropX: 100, hook: 'Watch this', brief: 'demo.json' };
    const first = await api('/api/cut', { method: 'POST', body: request });
    const second = await api('/api/cut', { method: 'POST', body: { ...request, layout: 'blur', cropX: undefined } });
    expect([first.status, second.status]).toEqual([202, 202]);
    expect(second.data.status).toBe('queued');

    // A transcript cannot be saved while a clip is being made.
    const early = await api('/api/clips/clip-001/transcript', { method: 'PUT', body: { words: [] } });
    expect(early.status).toBe(409);

    const done = await finished(first.data.id);
    expect(done).toMatchObject({ status: 'done', error: null, result: { clip: 'clip-001', warnings: [] } });
    expect(done.result.checks.map((check) => [check.rule, check.pass])).toEqual([
      ['Length', true], ['Required hashtags', true], ['Format', true],
    ]);
    expect((await finished(second.data.id)).result.clip).toBe('clip-002');

    const list = (await api('/api/clips')).data;
    expect(list.map((clip) => clip.name)).toEqual(['clip-002', 'clip-001']);
    expect(list[1]).toMatchObject({ source: 'game.mp4', start: 1, end: 3, layout: 'center', brief: 'demo', failedChecks: 0, rendered: true });

    const clip = (await api('/api/clips/clip-001')).data;
    expect(clip.meta).toMatchObject({ cropX: 100, hook: 'Watch this', captions: true });
    expect(clip.postText).toBe('Watch this\n\n\n\n#demo\n');
    expect(clip.transcript.words).toHaveLength(3);

    const media = await fetch(`${base}/media/out/clip-001/clip.mp4?v=${clip.version}`);
    expect(media.status).toBe(200);
    expect(media.headers.get('cache-control')).toBe('no-store');
    await media.arrayBuffer();

    // Fix a word, render again, and the subtitle file follows.
    const bad = await api('/api/clips/clip-001/transcript', { method: 'PUT', body: { words: [{ text: 'x' }] } });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toMatch(/word 1 must look like/);
    clip.transcript.words[2].text = 'NEVER.';
    expect((await api('/api/clips/clip-001/transcript', { method: 'PUT', body: clip.transcript })).status).toBe(200);
    const render = await api('/api/clips/clip-001/render', { method: 'POST' });
    expect((await finished(render.data.id)).status).toBe('done');
    const ass = await readFile(path.join(dir, 'out', 'clip-001', 'work', 'captions.ass'), 'utf8');
    expect(ass).toContain(',,HE DID NEVER');
    expect((await api('/api/clips/clip-001')).data.version).toBeGreaterThanOrEqual(clip.version);

    // Edit the post text, and the check reads it.
    const saved = await api('/api/clips/clip-001/post', { method: 'PUT', body: { text: 'Watch this\n\n#other' } });
    expect(saved.status).toBe(200);
    expect(saved.data.checks.find((c) => c.rule === 'Required hashtags').pass).toBe(false);
    // The saved results follow the edit, in the clip itself and in the list.
    expect((await api('/api/clips/clip-001')).data.meta.checks.filter((c) => !c.pass)).toHaveLength(1);
    expect((await api('/api/clips')).data.find((c) => c.name === 'clip-001').failedChecks).toBe(1);
    const check = (await api('/api/clips/clip-001/check')).data;
    expect(check.checks.find((c) => c.rule === 'Required hashtags')).toMatchObject({ pass: false });
    expect(check.brief).toEqual({ id: 'demo', platforms: [], manualChecks: ['Pin a comment'] });
  }, 180_000);

  it('reports a job that fails, with the reason', async () => {
    const { data } = await api('/api/cut', { method: 'POST', body: { video: 'game.mp4', start: 0, end: 60 } });
    expect(await finished(data.id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/only 0:04\.00 long/) });
  });

  it('answers unknown clips, jobs and addresses with 404', async () => {
    expect((await api('/api/clips/clip-999')).status).toBe(404);
    expect((await api('/api/clips/clip-999/render', { method: 'POST' })).status).toBe(404);
    expect((await api('/api/jobs/999')).status).toBe(404);
    expect((await api('/api/nothing')).status).toBe(404);
  });
});
