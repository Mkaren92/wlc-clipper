// What a chat message says about the moment: a reaction (laughter, hype, shock, a
// loss, "clip it"), noise (a command, a poll vote, a pasted message), or chatter.
//
// Added on 2026-11-21 after the owner's 11-hour gaming stream gave five clips that
// were polls and giveaways: the chat's biggest explosions were 62× "1", 97× "!me"
// and 77× "3", while the moment viewers pointed to in the comments (about 10:00:00)
// had "yes", "lol", "omg", "W". So the clips follow what chat says, not how much.
//
// The lists are plain words as chat writes them, matched whole by the shared
// matcher (terms.js), so stretched letters count too ("LOOOOL", "NOOO WAY"). The
// owner asked for chat's own words such as W (a win) and L (a loss).
// Pure: no Node imports.
import { compileTerms, matchTerms, normalizeText, tokenize } from './terms.js';

/** Kinds of reaction, each with the words chat uses and how much it says about a moment. */
export const REACTIONS = [
  { label: 'clip it', weight: 1.5, terms: ['clip', 'clip it', 'clip that', 'clipped', 'clipper', 'clip this'], emoji: ['🎬', '📸'] },
  { label: 'laughing', weight: 1, terms: ['lol', 'lmao', 'lmfao', 'rofl', 'haha', 'hahaha', 'xd', 'kekw', 'lul', 'omegalul', 'pepelaugh', 'icant', 'i cant', 'im dead', 'dead', 'crying', 'im crying', 'bruh'], emoji: ['😂', '🤣', '💀', '☠', '😭', '😹'] },
  { label: 'shock', weight: 0.9, terms: ['omg', 'oh my god', 'no way', 'nah', 'wtf', 'what', 'holy', 'holy shit', 'yooo', 'yo', 'bro', 'wait', 'how', 'jumpscare', 'monkas', 'wow', 'woah', 'whoa', 'ayo'], emoji: ['😱', '😳', '🤯', '😮', '😲', '👀'] },
  { label: 'hype', weight: 0.8, terms: ['w', 'dub', 'huge w', 'massive w', 'big w', 'lets go', 'let s go', 'lfg', 'pog', 'poggers', 'pogchamp', 'sheesh', 'goated', 'insane', 'cinema', 'peak', 'fire', 'clean', 'yes', 'yesss', 'goat'], emoji: ['🔥', '🐐', '🎉', '💯', '🙌'] },
  { label: 'fail', weight: 0.7, terms: ['l', 'ratio', 'rip', 'f', 'unlucky', 'sadge', 'fail', 'noooo', 'no', 'oof', 'throw', 'throwing', 'washed'], emoji: ['💔', '😬', '🤦'] },
];
const compiled = compileTerms(REACTIONS.map(({ label, terms }) => ({ label, terms })));
const weightOf = Object.fromEntries(REACTIONS.map((kind) => [kind.label, kind.weight]));
const EMOJI = REACTIONS.flatMap((kind) => kind.emoji.map((emoji) => [emoji, kind.label]));
// A plain "yes" or "no" is chat answering the streamer's question, not reacting. Stretched or
// shouted ("YESSSS", "NOOOOO", "YES!!") it is a reaction. Seen on the 11-hour stream: two of
// five moments were chat answering "yes" and "no" to a question.
const ANSWERS = new Set(['yes', 'no', 'yeah', 'yep', 'yea', 'nope', 'ok', 'okay', 'sure']);
const stretched = (raw) => /(\p{L})\1{2,}/u.test(raw) || /!{2,}/.test(raw);

/**
 * What one message is.
 *
 * @param {string} text
 * @returns {{ kind: 'noise' | 'reaction' | 'chatter', reactions: string[] }}
 *   `reactions`: the kinds it shows, strongest first
 */
export function readMessage(text) {
  const raw = String(text ?? '').trim();
  // A command to a chat bot ("!me", "!enter") or a poll vote ("1", "3", "11"): not about the moment.
  if (raw.startsWith('!')) return { kind: 'noise', reactions: [] };
  const tokens = tokenize(raw);
  if (tokens.length > 0 && tokens.every((token) => /^\d+$/.test(token))) return { kind: 'noise', reactions: [] };
  if (tokens.length > 0 && tokens.every((token) => ANSWERS.has(token)) && !stretched(raw)) return { kind: 'chatter', reactions: [] };
  const found = new Set(matchTerms(tokens, compiled).map((group) => group.label));
  for (const [emoji, label] of EMOJI) if (raw.includes(emoji)) found.add(label);
  if (found.size === 0) return { kind: tokens.length === 0 ? 'noise' : 'chatter', reactions: [] };
  // A long message is a sentence that happens to hold "what" or "no": reactions are short.
  if (tokens.length > 8 && !found.has('clip it') && !found.has('laughing')) return { kind: 'chatter', reactions: [] };
  return { kind: 'reaction', reactions: [...found].sort((a, b) => weightOf[b] - weightOf[a]) };
}

/**
 * The chat with only the messages that say something about the moment: reactions,
 * and messages with the owner's words. Commands, poll votes and pasted messages go.
 * A sentence of five words or more pasted by many people counts once; a short reaction
 * repeated by many ("lol" thirty times) is real laughter and counts every time.
 *
 * @param {Array<{ t: number, author: string, text: string }>} messages
 * @param {{ wordMatch?: (text: string) => boolean, pasteSeconds?: number }} [options]
 * @returns {Array<{ t: number, author: string, text: string, reactions: string[], weight: number }>}
 */
export function reactionStream(messages, { wordMatch = () => false, pasteSeconds = 30 } = {}) {
  const lastSeen = new Map(); // a long message's text -> when it was last counted
  const kept = [];
  for (const message of messages) {
    const read = readMessage(message.text);
    const words = wordMatch(message.text);
    if (read.kind === 'noise' || (read.kind === 'chatter' && !words)) continue;
    // Pasted: a sentence of five words or more, repeated. A short reaction ("lol that miss" from
    // thirty people) is not pasted, it is thirty people laughing.
    const key = normalizeText(message.text);
    if (tokenize(message.text).length >= 5) {
      const last = lastSeen.get(key);
      lastSeen.set(key, message.t);
      if (last !== undefined && message.t - last < pasteSeconds) continue;
    }
    const weight = Math.max(words ? 1 : 0, ...read.reactions.map((label) => weightOf[label]));
    kept.push({ ...message, reactions: read.reactions, weight });
  }
  return kept;
}

/** The kinds of reaction in a set of messages, most first: [{ label, count }]. */
export function reactionSummary(messages) {
  const counts = {};
  for (const message of messages) for (const label of message.reactions ?? []) counts[label] = (counts[label] ?? 0) + 1;
  return Object.entries(counts).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
}
