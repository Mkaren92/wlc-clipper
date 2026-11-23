// How a clip feels, for the hook's request: where the voice is much louder than
// usual, and how chat reacted. Asked for on 2026-11-22: the hooks only read the
// words spoken ("I have a feeling it's just reading the streamer's text"), while a
// good hook is about the feeling ("Keerk loses his mind after completing the mission").
//
// Only what is worked out here leaves the machine: times and decibels for the sound,
// and counts of each kind of reaction for chat. Never the sound, never a chat message's
// words or who wrote it.
import { VOICE_BAND } from '../captions/onsets.js';
import { readVoiceLevels } from '../captions/onsets.js';
import { reactionStream, reactionSummary } from '../chat/reactions.js';
import { run } from '../run.js';

// Levels are read in steps of half a second: a shout lasts longer than that.
export const LOUD_STEP = 0.5;
// A step is loud when it is this much above the clip's usual level (its median).
export const LOUDER_DB = 8;
// Steps quieter than this are silence and do not count towards the usual level.
const SILENCE_DB = -60;
// Chat writes a few seconds after the moment it reacts to (the same delay pick.js allows).
export const CHAT_DELAY = 5;
// Chat's busiest stretch is told in windows of this many seconds.
const CHAT_WINDOW = 5;

/**
 * The level of the voice's band every LOUD_STEP seconds.
 *
 * @param {string} audioFile   16 kHz mono WAV
 * @returns {Promise<{ t: number, db: number }[]>}
 */
export async function findLoudness(audioFile) {
  const samples = Math.round(16000 * LOUD_STEP);
  const filter = `aresample=16000,${VOICE_BAND},asetnsamples=n=${samples}:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level`;
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', audioFile, '-af', filter, '-f', 'null', '-']);
  return readVoiceLevels(stderr);
}

/**
 * The stretches that are much louder than the clip usually is: shouting, a scream,
 * laughing, or a loud moment of the game. Neighbouring loud steps are one stretch.
 *
 * @param {{ t: number, db: number }[]} levels   from findLoudness
 * @returns {{ start: number, end: number, louder: number }[]}  `louder`: dB above usual, at the stretch's loudest
 */
export function loudParts(levels) {
  const sounding = levels.filter((level) => level.db > SILENCE_DB).map((level) => level.db).sort((a, b) => a - b);
  if (sounding.length < 4) return [];
  const usual = sounding[Math.floor(sounding.length / 2)];
  const parts = [];
  for (const level of levels) {
    const above = level.db - usual;
    if (above < LOUDER_DB) continue;
    const last = parts.at(-1);
    if (last && level.t - last.end < LOUD_STEP + 1e-6) {
      last.end = level.t + LOUD_STEP;
      last.louder = Math.max(last.louder, above);
    } else {
      parts.push({ start: level.t, end: level.t + LOUD_STEP, louder: above });
    }
  }
  return parts.map((part) => ({ start: round(part.start), end: round(part.end), louder: Math.round(part.louder) }));
}

/**
 * How chat reacted to the clip: counts of each kind of reaction, and where most of
 * them came, on the clip's clock. Commands, poll votes and plain chatter are left
 * out by readMessage, and a pasted sentence counts once.
 *
 * @param {{ t: number, text: string }[]} messages   on the video's clock
 * @param {number} start   the clip's start in the video
 * @param {number} end
 * @returns {{ messages: number, reactions: { label: string, count: number }[], busiest: { start: number, end: number } | null }}
 *   `messages`: how many messages reacted (one can show two kinds)
 */
export function chatMood(messages, start, end) {
  // Chat reacts late, so its messages are read up to CHAT_DELAY after the clip and moved back by that much.
  const inside = messages
    .filter((message) => message.t >= start && message.t <= end + CHAT_DELAY)
    .map((message) => ({ t: Math.max(0, message.t - CHAT_DELAY - start), text: message.text }));
  const reacting = reactionStream(inside).filter((message) => message.reactions.length > 0);
  const reactions = reactionSummary(reacting);
  if (reacting.length === 0) return { messages: 0, reactions, busiest: null };
  const windows = new Map();
  for (const message of reacting) {
    const at = Math.min(Math.floor(message.t / CHAT_WINDOW) * CHAT_WINDOW, Math.max(0, end - start - CHAT_WINDOW));
    windows.set(at, (windows.get(at) ?? 0) + 1);
  }
  const [at] = [...windows].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  return { messages: reacting.length, reactions, busiest: { start: at, end: Math.min(at + CHAT_WINDOW, end - start) } };
}

/**
 * The lines about sound and chat that go after the transcript, or none.
 *
 * @param {{ loud?: { start: number, end: number, louder: number }[], chat?: ReturnType<typeof chatMood> | null }} mood
 * @returns {string[]}
 */
export function moodLines({ loud = [], chat = null }) {
  const lines = [];
  if (loud.length > 0) {
    lines.push('', 'Sound: where the voice is much louder than usual in this clip (times in seconds):');
    for (const part of loud) lines.push(`[${part.start.toFixed(1)}-${part.end.toFixed(1)}] ${part.louder} dB louder than usual`);
  }
  if (chat && chat.reactions.length > 0) {
    lines.push('', `Chat's reactions to this clip (messages counted by kind): ${chat.reactions.map((one) => `${one.label} ${one.count}`).join(', ')}.`);
    if (chat.busiest) lines.push(`Most of them came at [${chat.busiest.start.toFixed(1)}-${chat.busiest.end.toFixed(1)}].`);
  }
  return lines;
}

function round(n) {
  return Math.round(n * 100) / 100;
}
