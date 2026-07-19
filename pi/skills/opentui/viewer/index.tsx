/** @jsxImportSource @opentui/solid */
import { createCliRenderer } from '@opentui/core';
import { render } from '@opentui/solid';
import { resolve } from 'node:path';
import { App } from './app/App';

const usage = 'Usage: bun index.tsx --repo PATH\n       bun index.tsx --help';

function arg(name: string) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(usage);
  process.exit(0);
}

const repoPath = arg('--repo') ?? resolve('.');
const repo = resolve(repoPath);

const renderer = await createCliRenderer({ targetFps: 30, exitOnCtrlC: false, useKittyKeyboard: {}, exitSignals: [] });
(globalThis as any).__renderer = renderer;

const cleanup = () => renderer.destroy();
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('SIGHUP', cleanup);

await render(() => <App repo={repo} />, renderer);
await new Promise<void>(done => renderer.once('destroy', done));
