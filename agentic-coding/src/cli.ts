#!/usr/bin/env bun
// Top-level `agentic-coding` surface dispatch.
//   workflow   engine (start/apply/verify/archive/...)
//   dash       per-workflow dashboard TUI (--repo --change | --profile test | --json)
//   home       workflow list + observability TUI (long-lived)
//   manager    alias for home (herdr-manager launches this)
import { main as workflowMain } from './workflow/cli.ts';

const [surface, ...rest] = process.argv.slice(2);

if (!surface || surface === '--help' || surface === '-h' || surface === 'help') {
  console.log('Usage: agentic-coding <surface> [args]\n\nSurfaces:\n  workflow   Workflow engine (start/apply/verify/archive/...). Run `agentic-coding workflow --help` for its commands.\n  dash       Per-workflow dashboard + observability TUI. `agentic-coding dash --repo PATH --change ID`\n  home       Workflow list + observability TUI (long-lived launcher).\n  manager    Alias for home (used by herdr-manager).');
} else if (surface === 'workflow') {
  await workflowMain(rest);
} else if (surface === 'dash' || surface === 'home' || surface === 'manager') {
  if (surface === 'home' || surface === 'manager') process.argv.push('--home');
  const { main } = await import('./tui/index.tsx');
  await main();
} else {
  console.error(`unknown agentic-coding surface: ${surface}. Known surfaces: workflow, dash, home, manager`);
  process.exit(1);
}
