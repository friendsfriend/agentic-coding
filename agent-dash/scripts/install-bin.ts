#!/usr/bin/env bun
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : undefined;
if (only && !['agent-dash', 'otel-tui'].includes(only)) throw new Error(`Unknown TUI: ${only}`);
const build = Bun.spawnSync(['bun', 'run', 'build:single', ...(only ? ['--', '--only', only] : [])], { cwd: root, stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' });
if (build.exitCode !== 0) process.exit(build.exitCode);
const platform = process.platform === 'win32' ? 'windows' : process.platform;
const name = `agent-dash-${platform}-${process.arch}`;
const installDir = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'agent-dash', 'bin') : path.join(os.homedir(), '.local', 'bin');
fs.mkdirSync(installDir, { recursive: true });
for (const binary of only ? [only] : ['agent-dash', 'otel-tui']) {
  const base = path.join(root, 'dist', name, 'bin', binary);
  const source = process.platform === 'win32' && fs.existsSync(`${base}.exe`) ? `${base}.exe` : base;
  const destination = path.join(installDir, process.platform === 'win32' ? `${binary}.exe` : binary);
  fs.copyFileSync(source, destination);
  if (process.platform !== 'win32') fs.chmodSync(destination, 0o755);
  console.log(`installed ${destination}`);
}
