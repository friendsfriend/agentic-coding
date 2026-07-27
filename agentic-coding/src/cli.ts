#!/usr/bin/env bun
// Top-level `agentic-coding` surface dispatch. Only the `workflow` surface exists so
// far (this change); `dash`/`home`/`manager` land in later changes per
// openspec/specs/agentic-coding-consolidation.
import { main as workflowMain } from './workflow/cli.ts';

const [surface, ...rest] = process.argv.slice(2);

if (!surface || surface === '--help' || surface === '-h' || surface === 'help') {
  console.log('Usage: agentic-coding <surface> [args]\n\nSurfaces:\n  workflow   Workflow engine (start/apply/verify/archive/...). Run `agentic-coding workflow --help` for its commands.');
} else if (surface === 'workflow') {
  await workflowMain(rest);
} else {
  console.error(`unknown agentic-coding surface: ${surface}. Known surfaces: workflow`);
  process.exit(1);
}
