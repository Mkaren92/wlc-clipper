// A small web server on this machine that ffmpeg reads a YouTube stream
// through, so that a fetched part comes down at the speed of the connection.
//
// ffmpeg asks for a stream with one open-ended request ("from byte X to the
// end"), and YouTube sends such a request at little more than playback
// speed. A request for a fixed slice is sent at full speed. Measured on
// 2026-11-21 on the owner's 100 Mbit/s line: 0.44 MB/s open-ended, 22 to
// 35 MB/s for one 10 MB slice, 40 MB in 0.8 s as four slices at once. So
// the relay answers ffmpeg's request by asking YouTube for slices, a few
// at a time, and passes them on in order. ffmpeg itself works as before:
// it reads the index, jumps to the start and stops at the end, so only the
// asked part (plus the stream's index) is ever fetched.
//
// It listens on 127.0.0.1 only, on a port chosen by the system, serves only
// the stream addresses it was started with, and is closed when the fetch ends.
import http from 'node:http';

const SLICE = 10 * 1024 * 1024;
const AHEAD = 4;
const SLICE_TIMEOUT = 60_000;
const ATTEMPTS = 3;
// The headers the downloader would send with the stream, passed on as they are. Only these names.
const PASSED_HEADERS = ['user-agent', 'accept', 'accept-language', 'sec-fetch-mode'];

/**
 * Accept only a YouTube stream address: https on a googlevideo.com host.
 *
 * @param {string} text
 * @returns {string}
 */
export function checkStreamUrl(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('The downloader gave an address that is not a YouTube stream.');
  }
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.googlevideo\.com$/i.test(url.hostname)) {
    throw new Error('The downloader gave an address that is not a YouTube stream.');
  }
  return url.href;
}

/**
 * Start the relay for the given stream addresses.
 *
 * @param {string[]} streams   YouTube stream addresses, as the downloader gives them
 * @param {object} [options]   replaced in tests
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.slice]
 * @param {number} [options.ahead]
 * @param {Record<string, string>} [options.headers]   what the downloader sends with the stream (see PASSED_HEADERS)
 * @param {number} [options.retryDelay]   milliseconds before a slice is asked for again
 * @returns {Promise<{ urls: string[], close: () => Promise<void> }>}
 *   `urls[i]` is where ffmpeg reads `streams[i]`
 */
export async function startRangeRelay(streams, { fetchImpl = fetch, slice = SLICE, ahead = AHEAD, headers = {}, retryDelay = 500 } = {}) {
  const targets = streams.map(checkStreamUrl);
  const passed = Object.fromEntries(Object.entries(headers).filter(([name, value]) => PASSED_HEADERS.includes(name.toLowerCase()) && typeof value === 'string'));

  /** One slice, asked for again after a failure, up to ATTEMPTS times: one refused request must not end the fetch. */
  async function getSlice(target, from, to, signal) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await getSliceOnce(target, from, to, signal);
      } catch (error) {
        if (signal.aborted || error.final || attempt >= ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, retryDelay * attempt));
      }
    }
  }

  /** One slice, `from` to `to` inclusive. A redirect is followed only to another stream address. */
  async function getSliceOnce(target, from, to, signal) {
    let url = target;
    for (let hop = 0; hop < 4; hop++) {
      const response = await fetchImpl(url, {
        headers: { ...passed, Range: `bytes=${from}-${to}` },
        redirect: 'manual',
        signal: AbortSignal.any([signal, AbortSignal.timeout(SLICE_TIMEOUT)]),
      });
      if (response.status >= 300 && response.status < 400) {
        try {
          url = checkStreamUrl(new URL(response.headers.get('location') ?? '', url).href);
        } catch (error) {
          error.final = true; // a redirect away from YouTube is refused, not tried again
          throw error;
        }
        continue;
      }
      if (response.status !== 206) throw new Error(`YouTube answered ${response.status}.`);
      const total = Number(/\/(\d+)$/.exec(response.headers.get('content-range') ?? '')?.[1]);
      const body = Buffer.from(await response.arrayBuffer());
      if (!Number.isFinite(total)) throw new Error('YouTube did not say how long the stream is.');
      // The last slice may be shorter, never any other.
      if (body.length !== Math.min(to, total - 1) - from + 1) throw new Error('YouTube sent a slice of the wrong size.');
      return { body, total };
    }
    throw new Error('YouTube redirected too many times.');
  }

  async function serve(req, res) {
    const index = /^\/(\d+)$/.exec(req.url ?? '')?.[1];
    const target = index === undefined ? undefined : targets[Number(index)];
    if (!target || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404).end();
      return;
    }
    const asked = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? 'bytes=0-');
    if (!asked) {
      res.writeHead(416).end();
      return;
    }
    const from = Number(asked[1]);
    const wanted = asked[2] ? Number(asked[2]) : Infinity;

    // ffmpeg closes the connection when it has what it needs, or when it is stopped.
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    const signal = controller.signal;

    // The first slice also says how long the stream is.
    const first = await getSlice(target, from, Math.min(from + slice - 1, wanted), signal);
    const last = Math.min(wanted, first.total - 1);
    res.writeHead(206, {
      'Content-Type': 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${from}-${last}/${first.total}`,
      'Content-Length': String(last - from + 1),
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    // The next few slices are asked for while the one before is passed on.
    const queue = [];
    let next = from + first.body.length;
    const fill = () => {
      while (queue.length < ahead && next <= last) {
        const pending = getSlice(target, next, Math.min(next + slice - 1, last), signal);
        pending.catch(() => {}); // a slice no longer wanted after a stop fails quietly
        queue.push(pending);
        next = Math.min(next + slice - 1, last) + 1;
      }
    };
    fill();
    await write(res, first.body);
    while (queue.length > 0 && !signal.aborted) {
      const { body } = await queue.shift();
      fill();
      await write(res, body);
    }
    res.end();
  }

  const server = http.createServer((req, res) => {
    serve(req, res).catch(() => {
      // A failed slice ends the connection early, and ffmpeg reports the read error.
      res.destroy();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());

  return {
    urls: targets.map((_, i) => `http://127.0.0.1:${port}/${i}`),
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

/** Write and wait until the reader has taken it, or has gone. */
function write(res, chunk) {
  if (res.write(chunk)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });
}
