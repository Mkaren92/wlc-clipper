import { existsSync } from 'node:fs';
import path from 'node:path';
import { claudeCli } from './claudeCli.js';
import { openAi } from './openai.js';

/**
 * What the AI features need from a language-model service. Tests pass a
 * stand-in with the same members.
 *
 * @typedef {object} Ai
 * @property {string} service   name shown to the person, such as "OpenAI"
 * @property {string} model
 * @property {string} help      what to do when it is not set up
 * @property {() => boolean} isConfigured   whether it can be used right now
 * @property {(request: { system: string, user: string, schema: import('zod').ZodType, schemaName: string })
 *   => Promise<{ data: any, usage: { input: number, output: number } }>} ask
 *   Send one question and get back an answer shaped like `schema`.
 */

/**
 * Pick the AI service.
 *
 * CLIPPER_AI in `.env` chooses it: "claude" runs the Claude Code command
 * line with the login it already has, "openai" uses OPENAI_API_KEY. With no
 * choice made, Claude is used when its command line is installed, and
 * OpenAI otherwise.
 *
 * @param {{ env?: Record<string, string | undefined>, hasClaude?: boolean }} [options]   replaced in tests
 * @returns {Ai}
 */
export function getAi({ env = process.env, hasClaude = onPath('claude', env) } = {}) {
  const choice = (env.CLIPPER_AI ?? '').trim().toLowerCase();
  if (choice === 'openai') return openAi(env);
  if (choice === 'claude') return claudeCli(env, hasClaude);
  if (choice !== '') throw new Error(`CLIPPER_AI in .env must be "claude" or "openai", not "${choice}".`);
  return hasClaude ? claudeCli(env, true) : openAi(env);
}

/** Whether a program can be found in the folders of PATH. */
function onPath(program, env) {
  return (env.PATH ?? '').split(path.delimiter).some((dir) => dir && existsSync(path.join(dir, program)));
}
