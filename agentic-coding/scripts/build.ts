#!/usr/bin/env bun
// Builds the single self-contained `agentic-coding` executable (engine + TUI
// surfaces) plus the gRPC sidecar, using the @opentui/solid JSX plugin.
// Injects HERDR_AGENT_DEF_DIR at compile time — the file-relative walk in
// paths.ts collapses inside a compiled binary (see paths.ts).
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(import.meta.dir, '..');
process.chdir(root);

const solidPluginPath = path.join(root, 'node_modules/@opentui/solid/scripts/solid-plugin.js');
if (!fs.existsSync(solidPluginPath)) {
  console.error('missing @opentui/solid; run `bun install` first');
  process.exit(1);
}
const solidPlugin = (await import(solidPluginPath)).default;

// Bundle the current agent-definitions snapshot into the binary (skills +
// extensions), materialized on first run (see src/workflow/bootstrap.ts).
await Bun.$`bun run scripts/generate-embedded.ts`;

const agentDefDir = path.resolve(root, '..', 'agent-definitions');
if (!fs.existsSync(agentDefDir)) {
  console.error(`agent-definitions not found at ${agentDefDir}`);
  process.exit(1);
}

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });

const main = path.join(root, 'dist/agentic-coding');
const sidecar = path.join(root, 'dist/agentic-coding-grpc-sidecar');

await Bun.build({
  tsconfig: './tsconfig.json',
  plugins: [solidPlugin],
  compile: { outfile: main, autoloadBunfig: false, autoloadDotenv: false },
  entrypoints: ['./src/cli.ts'],
});

await Bun.build({
  tsconfig: './tsconfig.json',
  compile: { outfile: sidecar, autoloadBunfig: false, autoloadDotenv: false },
  entrypoints: ['./src/tui/otel/receiver/otlp-grpc-sidecar.ts'],
});

console.log(`built ${main}`);
console.log(`built ${sidecar}`);
