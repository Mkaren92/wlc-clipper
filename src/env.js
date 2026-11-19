import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Read settings such as OPENAI_API_KEY from the `.env` file in the project
 * folder, if there is one. Values already set in the environment win.
 *
 * Only the two entry points call this (src/cli.js and server/index.js).
 * Nothing imported by the tests does, so a test run can never pick up a real
 * key and spend money.
 */
export function loadEnv() {
  const file = fileURLToPath(new URL('../.env', import.meta.url));
  if (existsSync(file)) process.loadEnvFile(file);
}
