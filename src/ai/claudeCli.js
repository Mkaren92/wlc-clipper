import os from 'node:os';
import { z } from 'zod';
import { run } from '../run.js';

/** @typedef {import('./client.js').Ai} Ai */

// A model alias the command line understands; it follows the current Sonnet.
const DEFAULT_MODEL = 'sonnet';
const HELP =
  'Claude Code was not found. Install it and log in by running "claude" once, or use OpenAI: put CLIPPER_AI=openai and OPENAI_API_KEY=... in a file named .env in the project folder.';
const FAILED = 'Claude Code could not answer. Check that "claude" works in a terminal and that you are logged in.';

/**
 * Claude, through the Claude Code command line in its script mode
 * (`claude -p`). It uses the login Claude Code already has on this machine,
 * so no API key is needed. The model can be changed with CLIPPER_CLAUDE_MODEL.
 *
 * @param {Record<string, string | undefined>} env
 * @param {boolean} installed   whether the `claude` program was found
 * @returns {Ai}
 */
export function claudeCli(env, installed) {
  const model = env.CLIPPER_CLAUDE_MODEL || DEFAULT_MODEL;

  async function ask({ system, user, schema }) {
    if (!installed) throw new Error(HELP);
    // The command line refuses a schema that names its own dialect, which
    // zod adds as "$schema"; the rest is accepted as it is.
    const { $schema, ...jsonSchema } = z.toJSONSchema(schema);
    const args = [
      '-p',
      '--output-format', 'json',
      '--json-schema', JSON.stringify(jsonSchema),
      // It is asked a question and nothing more: no tools to read or change
      // files, no connected services, and no record of the exchange kept.
      '--tools', '',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--model', model,
      '--system-prompt', system,
    ];
    let answer;
    try {
      // Run from the system's temporary folder, so it does not pick up this
      // project's CLAUDE.md. The transcript goes in through standard input.
      // 5 minutes: a 3-hour video's transcript is about 15,000 words (suggestions take up to 3 hours since 2026-11-23).
      const { stdout } = await run('claude', args, { cwd: os.tmpdir(), input: user, timeout: 300_000 });
      answer = JSON.parse(stdout);
    } catch {
      throw new Error(FAILED);
    }
    if (answer.is_error || answer.structured_output === undefined || answer.structured_output === null) {
      throw new Error(FAILED);
    }
    const usage = answer.usage ?? {};
    return {
      data: answer.structured_output,
      usage: {
        input: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
        output: usage.output_tokens ?? 0,
      },
    };
  }

  return { service: 'Claude Code', model, help: HELP, isConfigured: () => installed, ask };
}
