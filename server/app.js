import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { z } from 'zod';
import { loadBrief } from '../src/brief/schema.js';
import { checkClip, cut, readClip, recheck, rerender, savePostText, saveTranscript } from '../src/cut.js';
import { describeLayouts, LAYOUTS } from '../src/layout.js';
import { probe } from '../src/probe.js';
import { parseTime } from '../src/time.js';
import { createJobs } from './jobs.js';

const VIDEO_TYPES = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi']);
const CLIP_NAME = /^clip-\d+$/;

/** An error whose message is meant for the person using the dashboard. */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// A time may arrive as seconds or as text such as "1:30".
const time = z.union([z.number().nonnegative(), z.string().min(1)]).transform((value, ctx) => {
  if (typeof value === 'number') return value;
  try {
    return parseTime(value);
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: error.message });
    return z.NEVER;
  }
});
const pixels = z.number().int().nonnegative();
const optionalText = z.string().trim().optional().transform((text) => text || undefined);

const cutRequest = z.strictObject({
  video: z.string().min(1),
  start: time,
  end: time,
  layout: z.enum(LAYOUTS).default('center'),
  cropX: pixels.optional(),
  cam: z.strictObject({ x: pixels, y: pixels, width: pixels, height: pixels }).optional(),
  trim: pixels.default(0),
  hook: optionalText,
  captions: z.boolean().default(true),
  lang: z.string().trim().min(2).max(10).default('en'),
  brief: optionalText,
  title: optionalText,
  description: optionalText,
});

/**
 * Build the dashboard's web server. It exposes the same engine as the
 * command line (src/) over HTTP, for a browser on this machine only.
 *
 * The browser names things; it never sends paths. A video is a file name in
 * `inDir`, a clip a folder name in `outDir`, a brief a file name in `briefsDir`.
 *
 * @param {object} options
 * @param {string} options.inDir       source videos
 * @param {string} options.outDir      clip folders
 * @param {string} options.briefsDir   brief files
 * @param {string} [options.webDir]    built dashboard pages, if they exist
 * @param {string} options.toolVersion
 * @param {import('../src/transcribe/index.js').Transcriber} [options.transcriber]   replaced in tests
 */
export function createApp({ inDir, outDir, briefsDir, webDir, toolVersion, transcriber }) {
  const app = express();
  const jobs = createJobs();

  app.disable('x-powered-by');
  app.use(onlyThisMachine);
  app.use(express.json({ limit: '2mb' }));

  // --- Source videos -------------------------------------------------------

  app.get('/api/videos', async (req, res) => {
    const names = (await listDir(inDir)).filter((name) => isPlainName(name) && VIDEO_TYPES.has(extension(name)));
    const videos = await Promise.all(
      names.map(async (name) => {
        const info = await stat(path.join(inDir, name));
        return { name, size: info.size, modified: info.mtimeMs };
      }),
    );
    res.json(videos.sort((a, b) => a.name.localeCompare(b.name)));
  });

  // Facts about one video, and where each layout's window falls on it.
  app.get('/api/videos/:name', async (req, res) => {
    const file = await videoPath(req.params.name);
    const trim = Number(req.query.trim ?? 0);
    if (!Number.isInteger(trim) || trim < 0) throw new HttpError(400, 'trim must be a whole number of pixels.');
    const { path: _path, ...info } = await probe(file);
    res.json({ name: req.params.name, ...info, layouts: describeLayouts(info, trim) });
  });

  app.get('/media/in/:name', async (req, res) => {
    await videoPath(req.params.name);
    res.sendFile(req.params.name, { root: inDir });
  });

  // --- Briefs --------------------------------------------------------------

  app.get('/api/briefs', async (req, res) => {
    const files = (await listDir(briefsDir)).filter((name) => isPlainName(name) && name.endsWith('.json')).sort();
    res.json(
      await Promise.all(
        files.map(async (file) => {
          try {
            return { file, ok: true, brief: (await loadBrief(path.join(briefsDir, file))).brief };
          } catch (error) {
            return { file, ok: false, error: error.message };
          }
        }),
      ),
    );
  });

  // --- Clips ---------------------------------------------------------------

  app.get('/api/clips', async (req, res) => {
    const names = (await listDir(outDir)).filter((name) => CLIP_NAME.test(name));
    const clips = await Promise.all(
      names.map(async (name) => {
        try {
          const { meta } = await readClip(path.join(outDir, name));
          return {
            name,
            source: path.basename(meta.source),
            start: meta.start,
            end: meta.end,
            layout: meta.layout,
            hook: meta.hook,
            seconds: meta.output?.seconds ?? null,
            brief: meta.brief?.id ?? null,
            failedChecks: meta.checks.filter((check) => !check.pass).length,
            rendered: meta.output !== null,
            createdAt: meta.createdAt,
          };
        } catch {
          return null; // not a clip folder, or one that is still being written
        }
      }),
    );
    res.json(clips.filter(Boolean).sort((a, b) => clipNumber(b.name) - clipNumber(a.name)));
  });

  app.get('/api/clips/:name', async (req, res) => {
    const clipDir = clipPath(req.params.name);
    const { meta, postText, transcript } = await readClip(clipDir).catch((error) => {
      throw new HttpError(404, error.message);
    });
    // The clip keeps its address when it is rendered again, so the page asks
    // for it with this number attached to get the new picture.
    const version = await stat(path.join(clipDir, 'clip.mp4')).then((s) => Math.round(s.mtimeMs), () => null);
    res.json({ name: req.params.name, meta, postText, transcript, version });
  });

  app.get('/media/out/:name/clip.mp4', (req, res) => {
    clipPath(req.params.name);
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(req.params.name, 'clip.mp4'), { root: outDir, cacheControl: false });
  });

  app.get('/api/clips/:name/check', async (req, res) => {
    const briefFile = req.query.brief ? briefPath(String(req.query.brief)) : undefined;
    const { checks, brief } = await checkClip(clipPath(req.params.name), briefFile);
    res.json({ checks, brief: { id: brief.id, platforms: brief.platforms, manualChecks: brief.manualChecks } });
  });

  app.put('/api/clips/:name/transcript', async (req, res) => {
    notWhileBusy();
    await saveTranscript(clipPath(req.params.name), req.body);
    res.json({ ok: true });
  });

  app.put('/api/clips/:name/post', async (req, res) => {
    if (typeof req.body?.text !== 'string') throw new HttpError(400, 'Send { "text": "..." }.');
    notWhileBusy();
    await savePostText(clipPath(req.params.name), req.body.text);
    // The saved results follow the edit, so the clip list shows the right count.
    res.json({ ok: true, checks: await recheck(clipPath(req.params.name)) });
  });

  // --- Jobs: cutting and re-rendering --------------------------------------

  app.post('/api/cut', async (req, res) => {
    const parsed = cutRequest.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error));
    const { video, brief, ...options } = parsed.data;
    const source = await videoPath(video);
    const briefFile = brief ? briefPath(brief) : undefined;

    const job = jobs.add('cut', `${video} ${options.start}-${options.end}`, async (onStep) =>
      summary(await cut({ ...options, source, briefFile, outDir, toolVersion, transcriber, onStep })),
    );
    res.status(202).json(job);
  });

  app.post('/api/clips/:name/render', async (req, res) => {
    const clipDir = clipPath(req.params.name);
    await readClip(clipDir).catch((error) => {
      throw new HttpError(404, error.message);
    });
    const job = jobs.add('render', req.params.name, async (onStep) => summary(await rerender(clipDir, { onStep })));
    res.status(202).json(job);
  });

  app.get('/api/jobs/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) throw new HttpError(404, 'No such job. Jobs are forgotten when the dashboard restarts.');
    res.json(job);
  });

  // --- The pages themselves -------------------------------------------------

  app.use('/api', (req, res) => res.status(404).json({ error: 'No such address.' }));
  if (webDir) app.use(express.static(webDir));
  app.get('/', (req, res) => {
    res.status(503).type('text').send('The dashboard pages are not built yet. Run: npm run build');
  });

  // Errors from the engine are written for people, so they are passed on as they are.
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.status ?? 400).json({ error: error.message });
  });

  // --- Helpers ---------------------------------------------------------------

  async function videoPath(name) {
    if (!isPlainName(name) || !VIDEO_TYPES.has(extension(name))) throw new HttpError(404, 'No such video.');
    const file = path.join(inDir, name);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw new HttpError(404, 'No such video.');
    return file;
  }

  function clipPath(name) {
    if (!CLIP_NAME.test(name)) throw new HttpError(404, 'No such clip.');
    return path.join(outDir, name);
  }

  function briefPath(name) {
    if (!isPlainName(name) || !name.endsWith('.json')) throw new HttpError(404, 'No such brief.');
    return path.join(briefsDir, name);
  }

  function notWhileBusy() {
    if (jobs.busy()) throw new HttpError(409, 'A clip is being made right now. Try again when it has finished.');
  }

  return { app, jobs };
}

/**
 * Refuse anything that is not this machine's own browser talking to this
 * server. Without it, a web page open in another tab could ask the dashboard
 * to cut or re-render clips: the browser would send the request, and only
 * these two headers show where it came from.
 */
function onlyThisMachine(req, res, next) {
  const port = req.socket.localPort;
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const origin = req.headers.origin;
  if (!hosts.includes(req.headers.host) || (origin && !hosts.map((host) => `http://${host}`).includes(origin))) {
    res.status(403).json({ error: 'The dashboard only answers its own page on this machine.' });
    return;
  }
  next();
}

/** What a finished job hands back to the page. */
function summary({ clipDir, meta, warnings, checks }) {
  return { clip: path.basename(clipDir), output: meta.output, warnings, checks };
}

/** A bare file name: no folders, not hidden. */
function isPlainName(name) {
  return typeof name === 'string' && name.length > 0 && name === path.basename(name) && !name.startsWith('.') && !name.includes('\\');
}

function extension(name) {
  return path.extname(name).toLowerCase();
}

function clipNumber(name) {
  return Number(name.slice('clip-'.length));
}

async function listDir(dir) {
  return readdir(dir).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
}
