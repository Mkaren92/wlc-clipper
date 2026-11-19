import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';

export const DEFAULT_MODEL = 'gpt-6.2-sol';

/** @typedef {import('./client.js').Ai} Ai */

const HELP = 'No OpenAI key is set. Put a line OPENAI_API_KEY=... in a file named .env in the project folder.';

/**
 * OpenAI, with the key from OPENAI_API_KEY. The model can be changed with
 * CLIPPER_AI_MODEL.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Ai}
 */
export function openAi(env) {
  const model = env.CLIPPER_AI_MODEL || DEFAULT_MODEL;
  const isConfigured = () => Boolean(env.OPENAI_API_KEY);

  async function ask({ system, user, schema, schemaName }) {
    if (!isConfigured()) throw new Error(HELP);
    const client = new OpenAI({ apiKey: env.OPENAI_API_KEY, timeout: 90_000, maxRetries: 1 });
    let response;
    try {
      response = await client.responses.parse({
        model,
        input: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        text: { format: zodTextFormat(schema, schemaName) },
      });
    } catch (error) {
      throw new Error(explain(error, model));
    }
    if (response.status !== 'completed' || !response.output_parsed) {
      throw new Error('OpenAI did not return a usable answer. Try again.');
    }
    return {
      data: response.output_parsed,
      usage: { input: response.usage?.input_tokens ?? 0, output: response.usage?.output_tokens ?? 0 },
    };
  }

  return { service: 'OpenAI', model, help: HELP, isConfigured, ask };
}

/**
 * A message for the person, written here and not taken from the service:
 * its own error text can repeat part of the key.
 */
function explain(error, model) {
  const status = error instanceof OpenAI.APIError ? error.status : undefined;
  if (status === 401) return 'OpenAI rejected the key in .env. Check that it is complete and still active.';
  if (status === 403) return 'OpenAI refused the request: this key is not allowed to use the service or the model.';
  if (status === 404) return `OpenAI does not know the model "${model}". Set CLIPPER_AI_MODEL in .env to a model your account can use.`;
  if (status === 429) return 'OpenAI turned the request down: the account is out of credit or sending too fast.';
  if (status) return `OpenAI answered with an error (status ${status}). Try again later.`;
  return 'Could not reach OpenAI. Check the internet connection and try again.';
}
