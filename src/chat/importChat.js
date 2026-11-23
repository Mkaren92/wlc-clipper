// Chat replays turned into the one shape everything downstream uses:
//   { messages: [{ t, author, text }] }, t in seconds from the start of the video.
//
// Two importers: YouTube's chat replay as yt-dlp writes it (.live_chat.json), and
// a chat log file the owner provides (JSON or CSV). Detection never knows which
// one a chat came from.
//
// The YouTube format was read from a real file on 2026-11-21 (yt-dlp 2026.10.21),
// not from memory: one JSON object per line, each with
// `replayChatItemAction.videoOffsetTimeMsec` (milliseconds, as text) and a list of
// actions; a message is `addChatItemAction.item.liveChatTextMessageRenderer` (or
// `liveChatPaidMessageRenderer` for a Super Chat), its text in `message.runs`, each
// run `{ text }` or `{ emoji: { emojiId, shortcuts, isCustomEmoji } }`, its sender in
// `authorExternalChannelId`. Messages sent before the stream began carry offset 0
// and a shown time such as "-58:51"; they are skipped, or they would pile up at 0:00.
//
// Authors are kept only as a short one-way id, enough to count how many different
// people wrote, never a name.
import { createHash } from 'node:crypto';
import { parseTime } from '../time.js';

/** @typedef {{ t: number, author: string, text: string }} ChatMessage */

// Long enough for a three-hour stream's chat with room to spare; a bigger file is refused.
export const MAX_CHAT_MESSAGES = 500_000;
const MAX_TEXT = 300;

/** A short id for a sender, the same for the same sender within and across chats. */
export function authorId(value) {
  return createHash('sha256').update(`wlc-chat:${value}`).digest('hex').slice(0, 12);
}

/**
 * Parse yt-dlp's .live_chat.json.
 *
 * @param {string} text
 * @returns {ChatMessage[]}
 */
export function parseYouTubeLiveChat(text) {
  const messages = [];
  let rows = 0;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error('The chat replay is not in the expected format: a line is not JSON.');
    }
    rows += 1;
    const replay = row?.replayChatItemAction;
    if (!replay) continue;
    const t = Number(replay.videoOffsetTimeMsec) / 1000;
    if (!Number.isFinite(t) || t < 0) continue;
    for (const action of replay.actions ?? []) {
      const item = action?.addChatItemAction?.item;
      const renderer = item?.liveChatTextMessageRenderer ?? item?.liveChatPaidMessageRenderer;
      if (!renderer) continue;
      // Sent before the stream started: shown as "-58:51", stored at offset 0.
      if (String(renderer.timestampText?.simpleText ?? '').trim().startsWith('-')) continue;
      const body = runsText(renderer.message?.runs);
      if (!body) continue;
      const who = renderer.authorExternalChannelId ?? renderer.authorName?.simpleText ?? '';
      messages.push({ t: round(t), author: authorId(who || 'unknown'), text: body });
      if (messages.length > MAX_CHAT_MESSAGES) throw new Error(`The chat has more than ${MAX_CHAT_MESSAGES} messages, which is more than this tool takes.`);
    }
  }
  if (rows === 0) throw new Error('The chat replay file is empty.');
  return messages.sort((a, b) => a.t - b.t);
}

/** A message's text: plain runs as they are, an emoji as its character, a channel's own emote by its name. */
function runsText(runs) {
  if (!Array.isArray(runs)) return '';
  const parts = [];
  for (const run of runs) {
    if (typeof run?.text === 'string') parts.push(run.text);
    else if (run?.emoji) {
      const custom = run.emoji.isCustomEmoji || String(run.emoji.emojiId ?? '').length > 8;
      parts.push(custom ? String(run.emoji.shortcuts?.[0] ?? '') : String(run.emoji.emojiId ?? ''));
    }
  }
  return oneLine(parts.join(''));
}

/**
 * Parse a chat log file the owner provides.
 *
 * JSON: either the tool's own shape `{ messages: [{ t, author, text }] }`, or a plain
 * list of messages. CSV: a header row naming a time column (t, time, seconds, offset
 * or timestamp), a text column (text or message) and optionally an author column
 * (author, user, name or username). Times are seconds or mm:ss / hh:mm:ss. A
 * yt-dlp .live_chat.json is recognised too, and so is a Twitch chat saved as JSON by
 * TwitchDownloader (an object with a `comments` list).
 *
 * @param {string} text
 * @param {string} fileName   only its ending is looked at
 * @returns {ChatMessage[]}
 */
export function parseChatFile(text, fileName = '') {
  const body = String(text).replace(/^﻿/, '');
  const trimmed = body.trimStart();
  if (/\.live_chat\.json$/i.test(fileName) || trimmed.startsWith('{"clickTrackingParams"') || trimmed.startsWith('{"replayChatItemAction"')) {
    return parseYouTubeLiveChat(body);
  }
  if (/\.csv$/i.test(fileName) || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return fromRows(csvRows(body), 'CSV');
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error('The chat file is not valid JSON or CSV.');
  }
  if (Array.isArray(data?.comments)) return fromTwitchDownloader(data.comments);
  const list = Array.isArray(data) ? data : data?.messages;
  if (!Array.isArray(list)) throw new Error('The chat file must hold a list of messages, or { "messages": [...] }.');
  return fromObjects(list);
}

const TIME_KEYS = ['t', 'time', 'seconds', 'offset', 'timestamp'];
const TEXT_KEYS = ['text', 'message'];
const AUTHOR_KEYS = ['author', 'user', 'name', 'username'];

/**
 * A Twitch chat saved by TwitchDownloader as JSON (added on 2026-11-23, because Twitch
 * does not let the tool read a chat replay itself). Each of its `comments` has
 * `content_offset_seconds`, the time into the broadcast, `message.body`, the words,
 * and `commenter`, who wrote it, of which only a one-way id is kept.
 *
 * @param {unknown[]} comments
 * @returns {ChatMessage[]}
 */
function fromTwitchDownloader(comments) {
  const messages = [];
  for (const [index, comment] of comments.entries()) {
    const item = /** @type {any} */ (comment);
    const text = oneLine(item?.message?.body ?? '');
    if (!text) continue;
    const t = Number(item?.content_offset_seconds);
    if (!Number.isFinite(t)) throw new Error(`Message ${index + 1} in the Twitch chat file has no time I can read.`);
    if (t < 0) continue;
    const who = item?.commenter?._id ?? item?.commenter?.name ?? '';
    messages.push({ t: round(t), author: authorId(String(who) || `line-${index}`), text });
    if (messages.length > MAX_CHAT_MESSAGES) throw new Error(`The chat has more than ${MAX_CHAT_MESSAGES} messages, which is more than this tool takes.`);
  }
  if (messages.length === 0) throw new Error('The Twitch chat file has no messages.');
  return messages.sort((a, b) => a.t - b.t);
}

function fromObjects(list) {
  return fromRows([
    ['t', 'author', 'text'],
    ...list.map((item) => {
      const key = (names) => names.find((name) => item && Object.prototype.hasOwnProperty.call(item, name));
      return [item?.[key(TIME_KEYS)], item?.[key(AUTHOR_KEYS)] ?? '', item?.[key(TEXT_KEYS)]];
    }),
  ], 'JSON');
}

function fromRows(rows, kind) {
  if (rows.length < 2) throw new Error(`The ${kind} chat file has no messages.`);
  const header = rows[0].map((name) => String(name).trim().toLowerCase());
  const column = (names) => header.findIndex((name) => names.includes(name));
  const timeAt = column(TIME_KEYS);
  const textAt = column(TEXT_KEYS);
  const authorAt = column(AUTHOR_KEYS);
  if (timeAt < 0 || textAt < 0) throw new Error(`The ${kind} chat file needs a time column (${TIME_KEYS.join(', ')}) and a text column (${TEXT_KEYS.join(', ')}).`);
  const messages = [];
  for (const [index, row] of rows.slice(1).entries()) {
    const text = oneLine(row[textAt] ?? '');
    if (!text) continue;
    const t = timeOf(row[timeAt]);
    if (t === null) throw new Error(`Message ${index + 1} in the chat file has no time I can read: "${String(row[timeAt]).slice(0, 20)}".`);
    if (t < 0) continue;
    messages.push({ t: round(t), author: authorId(String(authorAt >= 0 ? row[authorAt] ?? '' : '') || `line-${index}`), text });
    if (messages.length > MAX_CHAT_MESSAGES) throw new Error(`The chat has more than ${MAX_CHAT_MESSAGES} messages, which is more than this tool takes.`);
  }
  if (messages.length === 0) throw new Error(`The ${kind} chat file has no messages.`);
  return messages.sort((a, b) => a.t - b.t);
}

function timeOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/^-/.test(text)) return -1;
  try {
    return parseTime(text);
  } catch {
    return null;
  }
}

/** Rows of a CSV file: commas, double quotes around a field, "" for a quote inside one. */
export function csvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      if (row.some((cell) => cell !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  row.push(field);
  if (row.some((cell) => cell !== '')) rows.push(row);
  return rows;
}

function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}
