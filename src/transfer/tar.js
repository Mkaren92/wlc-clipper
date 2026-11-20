// Writing and reading a tar file: the one file the owner's data travels in.
//
// A tar file is a row of 512-byte blocks: a header block for each file, then
// the file's bytes padded to a whole block, and two empty blocks at the end.
// It is written here by hand, without the `tar` program and without a
// package, for two reasons: the bytes can go straight from disk to the
// browser with nothing kept in between, and on the way back in this code
// alone decides what a file in it is allowed to be.
//
// The format is "ustar". A name too long for its 100-byte field is written
// the way GNU tar does: an extra entry of type "L" whose content is the name
// of the entry after it. The `tar` program on Linux, macOS and Windows reads
// the result.
import { createReadStream } from 'node:fs';

const BLOCK = 512;
// A size field holds eleven octal digits: just under 8 GiB.
const LARGEST = 8 * 1024 ** 3 - 1;

const padding = (size) => (BLOCK - (size % BLOCK)) % BLOCK;
const octal = (value, width) => `${Math.floor(value).toString(8).padStart(width - 1, '0')}\0`;

/** One header block. */
function header(name, size, mtimeMs, type) {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, 'utf8');
  block.write(octal(0o644, 8), 100, 'latin1');
  block.write(octal(0, 8), 108, 'latin1'); // owner and group are not recorded
  block.write(octal(0, 8), 116, 'latin1');
  block.write(octal(size, 12), 124, 'latin1');
  block.write(octal(Math.max(0, mtimeMs) / 1000, 12), 136, 'latin1');
  block.write('        ', 148, 'latin1'); // the checksum is counted with spaces in its own place
  block.write(type, 156, 'latin1');
  block.write('ustar\0', 257, 'latin1');
  block.write('00', 263, 'latin1');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return block;
}

/** The blocks that announce one file: its header, with its name sent ahead when that does not fit. */
function headersFor({ name, size, mtimeMs = 0 }) {
  if (size > LARGEST) throw new Error(`"${name}" is larger than 8 GB, which this file format cannot hold.`);
  const bytes = Buffer.from(name, 'utf8');
  if (bytes.length <= 100) return [header(name, size, mtimeMs, '0')];
  const longName = Buffer.concat([bytes, Buffer.alloc(1)]);
  return [header('././@LongLink', longName.length, 0, 'L'), longName, Buffer.alloc(padding(longName.length)), header(bytes.subarray(0, 100).toString('latin1'), size, mtimeMs, '0')];
}

/**
 * How many bytes the tar file for these entries is, so a download can say its length up front.
 *
 * @param {{ name: string, size: number }[]} entries
 */
export function tarSize(entries) {
  let total = 2 * BLOCK;
  for (const entry of entries) {
    for (const block of headersFor(entry)) total += block.length;
    total += entry.size + padding(entry.size);
  }
  return total;
}

/**
 * The tar file for these entries, piece by piece. Each entry is either a file
 * on disk (`file`) or bytes already in hand (`content`).
 *
 * @param {{ name: string, size: number, mtimeMs?: number, file?: string, content?: Buffer }[]} entries
 * @returns {AsyncGenerator<Buffer>}
 */
export async function* tarStream(entries) {
  for (const entry of entries) {
    yield* headersFor(entry);
    let sent = 0;
    if (entry.content) {
      sent = entry.content.length;
      yield entry.content;
    } else {
      for await (const chunk of createReadStream(entry.file, { end: Math.max(entry.size - 1, 0) })) {
        if (entry.size === 0) break;
        sent += chunk.length;
        yield chunk;
      }
    }
    // A file that shrank while it was being read would leave every file after it misplaced.
    if (sent !== entry.size) throw new Error(`"${entry.name}" changed while it was being read.`);
    if (padding(entry.size)) yield Buffer.alloc(padding(entry.size));
  }
  yield Buffer.alloc(2 * BLOCK);
}

/** Bytes from a stream, a fixed number at a time. */
class Bytes {
  constructor(stream) {
    this.chunks = stream[Symbol.asyncIterator]();
    this.held = Buffer.alloc(0);
  }

  /** The next `count` bytes, or null when the stream ended exactly here. */
  async take(count) {
    while (this.held.length < count) {
      const { value, done } = await this.chunks.next();
      if (done) {
        if (this.held.length === 0) return null;
        throw new Error('The file ends in the middle of something. It may not have been downloaded completely.');
      }
      this.held = this.held.length ? Buffer.concat([this.held, value]) : value;
    }
    const out = this.held.subarray(0, count);
    this.held = this.held.subarray(count);
    return out;
  }

  /** Hand the next `count` bytes to `write` as they come, without holding them all. */
  async pass(count, write) {
    let left = count;
    while (left > 0) {
      if (this.held.length === 0) {
        const { value, done } = await this.chunks.next();
        if (done) throw new Error('The file ends in the middle of something. It may not have been downloaded completely.');
        this.held = value;
      }
      const piece = this.held.subarray(0, Math.min(left, this.held.length));
      this.held = this.held.subarray(piece.length);
      left -= piece.length;
      await write(piece);
    }
  }
}

const text = (block, from, length) => {
  const field = block.subarray(from, from + length);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? length : end).toString('utf8');
};

/**
 * Whether a name inside a tar file is a plain path that stays where it is put:
 * no leading slash, no "..", no hidden names, nothing odd.
 */
export function isSafePath(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 1000 || /[\\\0]/.test(name) || name.startsWith('/')) return false;
  return name.split('/').every((part) => part.length > 0 && part.length <= 255 && !part.startsWith('.'));
}

/**
 * Read a tar file from a stream. For every plain file in it, `open(name, size)`
 * is asked what to do: it answers with a function that takes the file's bytes
 * piece by piece, or with null to pass the file over.
 *
 * Only plain files and folders are accepted. A link, a device or a name that
 * could land outside its folder stops the whole read with an error, as does a
 * file that ends early: nothing from such a file is to be trusted.
 *
 * @param {AsyncIterable<Buffer>} stream
 * @param {(name: string, size: number) => Promise<null | { write: (piece: Buffer) => Promise<void>, close: () => Promise<void> }>} open
 */
export async function readTar(stream, open) {
  const bytes = new Bytes(stream);
  let nameAhead = null;
  for (;;) {
    const block = await bytes.take(BLOCK);
    if (block === null) throw new Error('The file ends before its end mark. It may not have been downloaded completely.');
    if (block.every((byte) => byte === 0)) return; // the end mark

    let sum = 0;
    for (let at = 0; at < BLOCK; at++) sum += at >= 148 && at < 156 ? 32 : block[at];
    if (sum !== parseInt(text(block, 148, 8).trim() || 'x', 8)) throw new Error('This is not a data file made by this tool, or it is damaged.');

    const size = parseInt(text(block, 124, 12).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw new Error('This is not a data file made by this tool, or it is damaged.');
    const type = String.fromCharCode(block[156] || 48);
    const prefix = text(block, 257, 5) === 'ustar' ? text(block, 345, 155) : '';
    const name = nameAhead ?? (prefix ? `${prefix}/${text(block, 0, 100)}` : text(block, 0, 100));
    nameAhead = null;

    if (type === 'L') {
      // The name of the entry that follows, when it is too long for the header.
      if (size > 4096) throw new Error('This is not a data file made by this tool, or it is damaged.');
      nameAhead = (await bytes.take(size))?.toString('utf8').replace(/\0+$/, '') ?? '';
      await bytes.take(padding(size));
      continue;
    }
    if (type === 'x' || type === 'g') {
      // Notes other tar programs add. Passed over.
      await bytes.pass(size + padding(size), async () => {});
      continue;
    }
    if (type === '5') continue; // a folder: made when a file in it is written
    if (type !== '0') throw new Error(`The file holds "${name}", which is not a plain file. Nothing was loaded.`);
    if (!isSafePath(name)) throw new Error(`The file holds something with a name that cannot be used: "${name.slice(0, 80)}". Nothing was loaded.`);

    const taker = await open(name, size);
    try {
      await bytes.pass(size, taker ? taker.write : async () => {});
    } finally {
      await taker?.close();
    }
    if (padding(size)) await bytes.take(padding(size));
  }
}
