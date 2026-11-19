// Starts the dashboard: npm run dashboard
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../src/env.js';
import { createApp } from './app.js';

loadEnv();

const root = fileURLToPath(new URL('..', import.meta.url));
// Relative paths in briefs (an end-card image) are looked up from here.
process.chdir(root);

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const port = Number(process.env.CLIPPER_PORT ?? 4517);
const webDir = path.join(root, 'web', 'dist');

const { app } = createApp({
  inDir: path.join(root, 'in'),
  outDir: path.join(root, 'out'),
  briefsDir: path.join(root, 'briefs'),
  partsDir: path.join(root, 'parts'),
  dataDir: path.join(root, 'data'),
  webDir: existsSync(webDir) ? webDir : undefined,
  toolVersion: pkg.version,
});

// 127.0.0.1 keeps the dashboard off the network: only this machine can reach it.
// Express hands a failure to start (such as a port in use) to this callback.
app.listen(port, '127.0.0.1', (error) => {
  if (error?.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Choose another: CLIPPER_PORT=4600 npm run dashboard`);
    process.exit(1);
  }
  if (error) {
    console.error(error.message);
    process.exit(1);
  }
  console.log(`WLC Clipper dashboard: http://127.0.0.1:${port}`);
  console.log('Press Ctrl+C to stop.');
});
