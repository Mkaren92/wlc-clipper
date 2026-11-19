// Starts the dashboard's server on a free port with temporary folders.
// Needs ffmpeg, but neither Python nor the built web pages.
import http from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

const fakeAi = {
  service: 'Fake', model: 'fake-1', help: 'Set it up.', isConfigured: () => true,
  ask: async () => ({
    data: { moments: [{ start: 0.3, end: 0.95, hook: 'Look at this', title: 'T', description: 'D', reason: 'R', score: 0.8 }] },
    usage: { input: 10, output: 5 },
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
    partsDir: path.join(dir, 'parts'),
    dataDir: path.join(dir, 'data'),
    toolVersion: 'test',
    transcriber: fakeTranscriber,
    ai: fakeAi,
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

describe('parts', () => {
  it('saves a part as it is, lists it, plays it and deletes it', async () => {
    expect((await api('/api/parts')).data).toEqual([]);
    const bad = await api('/api/parts', { method: 'POST', body: { video: 'game.mp4', start: 2, end: 1, hook: 'x' } });
    expect(bad.status).toBe(400);

    const started = await api('/api/parts', { method: 'POST', body: { video: 'game.mp4', start: '0:01', end: 2.5 } });
    expect(started.status).toBe(202);
    const done = await finished(started.data.id);
    expect(done).toMatchObject({ status: 'done', kind: 'part', result: { name: 'game_0m01s-0m02.5s.mp4', width: 1920, height: 1080, fps: 30 } });
    // Nothing about where the file is on disk goes to the page.
    expect(done.result.file).toBeUndefined();

    expect((await api('/api/parts')).data.map((part) => part.name)).toEqual(['game_0m01s-0m02.5s.mp4']);
    const media = await fetch(`${base}/media/parts/game_0m01s-0m02.5s.mp4`, { headers: { Range: 'bytes=0-9' } });
    expect(media.status).toBe(206);
    await media.arrayBuffer();
    // Parts are kept apart from clips.
    expect((await api('/api/clips')).data).toEqual([]);

    expect((await api('/api/parts/..%2Fin%2Fgame.mp4', { method: 'DELETE' })).status).toBe(404);
    expect((await api('/media/parts/..%2Fsecret.mp4')).status).toBe(404);
    expect((await api('/api/parts/game_0m01s-0m02.5s.mp4', { method: 'DELETE' })).status).toBe(200);
    expect((await api('/api/parts')).data).toEqual([]);
    expect((await api('/api/videos')).data.map((video) => video.name)).toEqual(['game.mp4']);
  }, 120_000);
});

describe('matches and cards', () => {
  const details = { home: 'FC Barcelona', away: 'Manchester United', competition: 'Champions League', date: '', colours: { home: '#a50044', away: '#da291c' } };
  const goal = { id: 'g1', type: 'goal', team: 'home', scorer: 'Lewandowski', assist: '', minute: 12, added: null, goalType: 'penalty', homeScore: 1, awayScore: 0 };

  it('creates, lists, changes and deletes a match', async () => {
    const made = await api('/api/matches', { method: 'POST', body: { ...details, cards: [goal] } });
    expect(made.status).toBe(201);
    expect(made.data.id).toBe('fc-barcelona-vs-manchester-united');
    expect((await api('/api/matches')).data.map((m) => m.id)).toEqual(['fc-barcelona-vs-manchester-united']);

    const changed = await api(`/api/matches/${made.data.id}`, { method: 'PUT', body: { ...made.data, home: 'Barça' } });
    expect(changed.data.home).toBe('Barça');
    // The id in the address wins over one in the body.
    const forged = await api(`/api/matches/${made.data.id}`, { method: 'PUT', body: { ...made.data, id: 'other' } });
    expect(forged.data.id).toBe(made.data.id);

    expect((await api(`/api/matches/${made.data.id}`, { method: 'PUT', body: { ...made.data, colours: { home: 'red', away: '#000000' } } })).status).toBe(400);
    expect((await api('/api/matches/no-such-match', { method: 'PUT', body: made.data })).status).toBe(404);
    expect((await api('/api/matches/..%2Fx', { method: 'DELETE' })).status).toBe(404);
    expect((await api('/api/matches', { method: 'POST', body: details, headers: { Origin: 'https://example.com' } })).status).toBe(403);
  });

  it('stores a card picture and serves it back, and refuses anything else', async () => {
    const id = 'fc-barcelona-vs-manchester-united';
    const file = path.join(dir, 'card.png');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=navy:s=1920x1080', '-frames:v', '1', file]);
    const png = await readFile(file);
    const put = (address, body, type = 'image/png') => fetch(base + address, { method: 'PUT', headers: { 'Content-Type': type }, body });

    expect((await put(`/api/matches/${id}/cards/g1/png/landscape`, png)).status).toBe(200);
    expect((await put(`/api/matches/${id}/cards/g1/png/portrait`, png)).status).toBe(400);
    expect((await put(`/api/matches/${id}/cards/g1/png/landscape`, 'hello', 'text/plain')).status).toBe(400);
    expect((await put(`/api/matches/${id}/cards/nope/png/landscape`, png)).status).toBe(404);

    const served = await fetch(`${base}/media/cards/${id}/g1/landscape`);
    expect([served.status, served.headers.get('content-type')]).toEqual([200, 'image/png']);
    expect((await served.arrayBuffer()).byteLength).toBe(png.length);
    expect((await fetch(`${base}/media/cards/${id}/g1/portrait`)).status).toBe(404);
    expect((await fetch(`${base}/media/cards/${id}/..%2Fmatch.json/landscape`)).status).toBe(404);

    expect((await api(`/api/matches/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await api('/api/matches')).data).toEqual([]);
  }, 60_000);
});

describe('compilations', () => {
  it('saves a timeline, renders it as a job with a state per item, and serves the result', async () => {
    const made = await api('/api/compilations', { method: 'POST', body: { name: 'Goal reactions' } });
    expect([made.status, made.data.id, made.data.final]).toEqual([201, 'goal-reactions', null]);

    const items = [
      { id: 'a', kind: 'video', library: 'in', name: 'game.mp4', start: 0, end: 1, credit: 'Ana' },
      { id: 'b', kind: 'video', library: 'in', name: 'game.mp4', start: 1, end: 2, credit: '' },
    ];
    expect((await api('/api/compilations/goal-reactions', { method: 'PUT', body: { ...made.data, items: [{ id: 'x', kind: 'video', library: 'etc', name: 'passwd' }] } })).status).toBe(400);
    // The page sends back everything it was given, including what the server added.
    const saved = await api('/api/compilations/goal-reactions', { method: 'PUT', body: { ...made.data, items } });
    expect(saved.data.items).toHaveLength(2);

    expect((await api('/api/library/in/game.mp4')).data).toMatchObject({ width: 1920, height: 1080, duration: 4 });
    expect((await api('/api/library/in/..%2Fsecret.mp4')).status).toBe(404);
    expect((await api('/api/library/etc/passwd')).status).toBe(404);

    const started = await api('/api/compilations/goal-reactions/generate', { method: 'POST' });
    expect(started.status).toBe(202);
    const done = await finished(started.data.id);
    expect(done).toMatchObject({ status: 'done', kind: 'compile', detail: { items: ['done', 'done'] } });
    expect(Math.abs(done.result.seconds - 2)).toBeLessThan(0.2);

    const after = (await api('/api/compilations/goal-reactions')).data;
    expect(after.final.size).toBeGreaterThan(1000);
    expect(after.description).toBe('Credits:\n- Ana\n\nChapters:\n0:00 Start\n');
    const media = await fetch(`${base}/media/compilations/goal-reactions/final.mp4?v=${after.final.version}`, { headers: { Range: 'bytes=0-9' } });
    expect(media.status).toBe(206);
    await media.arrayBuffer();

    expect((await api('/api/compilations/goal-reactions', { method: 'DELETE' })).status).toBe(200);
    expect((await api('/api/compilations')).data).toEqual([]);
    expect((await api('/api/compilations/..%2Fmatches', { method: 'DELETE' })).status).toBe(404);
  }, 180_000);

  it('copies a chosen video file into the videos folder, once', async () => {
    const bytes = await readFile(path.join(dir, 'in', 'game.mp4'));
    const put = (name, body) => fetch(`${base}/api/uploads/${encodeURIComponent(name)}`, { method: 'PUT', body });
    const first = await put('second clip.mp4', bytes);
    expect([first.status, await first.json()]).toEqual([201, { name: 'second clip.mp4', copied: true }]);
    const again = await put('second clip.mp4', bytes);
    expect(await again.json()).toEqual({ name: 'second clip.mp4', copied: false });
    expect((await put('second clip.mp4', bytes.subarray(0, 1000))).status).toBe(409);
    expect((await put('notes.txt', bytes)).status).toBe(400);
    // A name that tries to leave the folder is refused, and nothing is written.
    expect((await put('../outside.mp4', bytes)).status).toBe(400);
    await expect(stat(path.join(dir, 'outside.mp4'))).rejects.toThrow(/ENOENT/);
    expect((await readdir(path.join(dir, 'in'))).sort()).toEqual(['.hidden.mp4', 'game.mp4', 'notes.txt', 'second clip.mp4']);
    await rm(path.join(dir, 'in', 'second clip.mp4'));
  }, 60_000);
});

describe('AI suggestions', () => {
  it('says which service is set up', async () => {
    expect((await api('/api/ai')).data).toEqual({ configured: true, service: 'Fake', model: 'fake-1', help: 'Set it up.' });
  });

  it('proposes moments as a background job, without cutting anything', async () => {
    const bad = await api('/api/suggest', { method: 'POST', body: { video: 'game.mp4', count: 99 } });
    expect(bad.status).toBe(400);
    const { status, data } = await api('/api/suggest', { method: 'POST', body: { video: 'game.mp4', brief: 'demo.json' } });
    expect(status).toBe(202);
    const done = await finished(data.id);
    // The brief allows at most 10 s and has no minimum, so the short moment is kept.
    expect(done).toMatchObject({ status: 'done', result: { model: 'fake-1', fromCache: false } });
    expect(done.result.moments).toHaveLength(0);
    expect((await api('/api/clips')).data).toEqual([]);
  }, 60_000);
});

describe('cutting', () => {
  it('explains a request it cannot use', async () => {
    const bad = await api('/api/cut', { method: 'POST', body: { video: 'game.mp4', start: '1:xx', end: 2 } });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toMatch(/is not a time/);
    expect((await api('/api/cut', { method: 'POST', body: { video: 'nope.mp4', start: 0, end: 1 } })).status).toBe(404);
  });

  it('cuts two clips one after the other, then shows, edits, re-renders and checks one', async () => {
    const request = { video: 'game.mp4', start: '0:01', end: 3, layout: 'center', cropX: 100, hook: 'Watch this', hookSeconds: 0, brief: 'demo.json' };
    const first = await api('/api/cut', { method: 'POST', body: request });
    const second = await api('/api/cut', { method: 'POST', body: { ...request, layout: 'blur', cropX: undefined } });
    expect([first.status, second.status]).toEqual([202, 202]);
    expect(second.data.status).toBe('queued');

    // A transcript cannot be saved while a clip is being made.
    const early = await api('/api/clips/watch-this/transcript', { method: 'PUT', body: { words: [] } });
    expect(early.status).toBe(409);

    // Both show up in the list of jobs, which is what a reloaded page reads.
    const listed = (await api('/api/jobs')).data.filter((job) => job.kind === 'cut');
    expect(listed.map((job) => job.label)).toEqual(['game.mp4 0:01.00–0:03.00', 'game.mp4 0:01.00–0:03.00']);

    const done = await finished(first.data.id);
    expect(done).toMatchObject({ status: 'done', error: null, result: { clip: 'watch-this', warnings: [] } });
    expect(done.result.checks.map((check) => [check.rule, check.pass])).toEqual([
      ['Length', true], ['Required hashtags', true], ['Format', true],
    ]);
    expect((await finished(second.data.id)).result.clip).toBe('watch-this-2');

    const list = (await api('/api/clips')).data;
    expect(list.map((clip) => clip.name)).toEqual(['watch-this-2', 'watch-this']);
    expect(list[1]).toMatchObject({ source: 'game.mp4', start: 1, end: 3, layout: 'center', brief: 'demo', failedChecks: 0, rendered: true });

    const clip = (await api('/api/clips/watch-this')).data;
    expect(clip.meta).toMatchObject({ cropX: 100, hook: 'Watch this', hookSeconds: 0, captions: true });
    const negative = await api('/api/cut', { method: 'POST', body: { ...request, hookSeconds: -2 } });
    expect(negative.status).toBe(400);
    expect(clip.postText).toBe('Watch this\n\n\n\n#demo\n');
    expect(clip.transcript.words).toHaveLength(3);

    const media = await fetch(`${base}/media/out/watch-this/clip.mp4?v=${clip.version}`);
    expect(media.status).toBe(200);
    expect(media.headers.get('cache-control')).toBe('no-store');
    await media.arrayBuffer();

    // Fix a word, render again, and the subtitle file follows.
    const bad = await api('/api/clips/watch-this/transcript', { method: 'PUT', body: { words: [{ text: 'x' }] } });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toMatch(/word 1 must look like/);
    clip.transcript.words[2].text = 'NEVER.';
    expect((await api('/api/clips/watch-this/transcript', { method: 'PUT', body: clip.transcript })).status).toBe(200);
    const render = await api('/api/clips/watch-this/render', { method: 'POST' });
    expect((await finished(render.data.id)).status).toBe('done');
    const ass = await readFile(path.join(dir, 'out', 'watch-this', 'work', 'captions.ass'), 'utf8');
    expect(ass).toContain(',,HE DID NEVER');
    expect((await api('/api/clips/watch-this')).data.version).toBeGreaterThanOrEqual(clip.version);

    // Edit the post text, and the check reads it.
    const saved = await api('/api/clips/watch-this/post', { method: 'PUT', body: { text: 'Watch this\n\n#other' } });
    expect(saved.status).toBe(200);
    expect(saved.data.checks.find((c) => c.rule === 'Required hashtags').pass).toBe(false);
    // The saved results follow the edit, in the clip itself and in the list.
    expect((await api('/api/clips/watch-this')).data.meta.checks.filter((c) => !c.pass)).toHaveLength(1);
    expect((await api('/api/clips')).data.find((c) => c.name === 'watch-this').failedChecks).toBe(1);
    const check = (await api('/api/clips/watch-this/check')).data;
    expect(check.checks.find((c) => c.rule === 'Required hashtags')).toMatchObject({ pass: false });
    expect(check.brief).toEqual({ id: 'demo', platforms: [], manualChecks: ['Pin a comment'] });
  }, 180_000);

  it('deletes a clip with its folder, and only a real clip folder', async () => {
    const clipDir = path.join(dir, 'out', 'watch-this-2');
    expect((await readdir(clipDir)).sort()).toEqual(['clip.mp4', 'post.txt', 'work']);

    // Another site cannot delete, and a name cannot reach outside the clips folder.
    expect((await api('/api/clips/watch-this-2', { method: 'DELETE', headers: { Origin: 'https://example.com' } })).status).toBe(403);
    expect((await api('/api/clips/..%2Fin', { method: 'DELETE' })).status).toBe(404);
    expect((await readdir(path.join(dir, 'in'))).length).toBeGreaterThan(0);

    // A folder with a clip's name but no clip in it is left alone.
    await mkdir(path.join(dir, 'out', 'clip-777'));
    await writeFile(path.join(dir, 'out', 'clip-777', 'keep.txt'), 'not a clip');
    expect((await api('/api/clips/clip-777', { method: 'DELETE' })).status).toBe(404);
    expect(await readdir(path.join(dir, 'out', 'clip-777'))).toEqual(['keep.txt']);

    expect((await api('/api/clips/watch-this-2', { method: 'DELETE' })).status).toBe(200);
    await expect(readdir(clipDir)).rejects.toThrow(/ENOENT/);
    expect((await api('/api/clips')).data.map((clip) => clip.name)).toEqual(['watch-this']);
    expect((await api('/api/clips/watch-this-2', { method: 'DELETE' })).status).toBe(404);
  });

  it('does not delete while a clip is being made', async () => {
    const { data } = await api('/api/cut', { method: 'POST', body: { video: 'game.mp4', start: 0, end: 1, captions: false } });
    expect((await api('/api/clips/watch-this', { method: 'DELETE' })).status).toBe(409);
    await finished(data.id);
    expect((await api('/api/clips/watch-this')).status).toBe(200);
  }, 60_000);

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
