#!/usr/bin/env bun
// Top-level `agentic-coding` surface dispatch. Only the `workflow` surface exists so
// far (this change); `dash`/`home`/`manager` land in later changes per
// openspec/specs/agentic-coding-consolidation.
import { main as workflowMain } from './workflow/cli.ts';

const [surface, ...rest] = process.argv.slice(2);

if (surface === 'workflow') {
  await workflowMain(rest);
} else {
  console.error(`unknown agentic-coding surface: ${surface ?? '(none)'}. Known surfaces: workflow`);
  process.exit(1);
}
