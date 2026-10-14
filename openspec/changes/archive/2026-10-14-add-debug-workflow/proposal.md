# Proposal

## Why

The developer often wants to check a behavior or reproduce a bug without
planning a change: "does the installer form still save on branch X", "show me
what happens when the customer search returns nothing". No workflow does this:
every family either plans, implements, or documents. The environment, browser
and debug tools need an agent role that uses them deliberately and reports
with evidence.

## What Changes

- A **`debug` agent role**: instructions `agent-definitions/instructions/debug.md`
  (reproduce first, minimal hypothesis-driven probing, Docker-first, kind only
  for concurrency, keep evidence only when it shows the problem or the fix,
  stop apps when done because others may be waiting, structured report). Writable: it may edit code to
  probe or fix.
- A standalone **`debug` workflow family**: `start --workflow debug --repo PATH
  --mode worktree --branch BRANCH --task TEXT [--app IDENT]`.
  - Workspace: a **detached** worktree at the branch head (the branch may be
    checked out elsewhere; edits never land on a branch implicitly).
  - Steps: `debug.investigate` (agent) → `debug.review` (developer gate:
    approve → completed; follow-up with comment → `debug.investigate`, bounded
    to 5 rounds) → completed, held until closed.
  - Output: `debug-report.md` (summary, environment, reproduction steps,
    expected vs actual, findings with evidence ids, code changes, open
    questions) plus `changes.patch` evidence when the worktree is dirty.
  - No delivery, archive or PR steps. Close releases its apps (`add-environment-instance-lifecycle`) and
    cleanup removes the worktree.
- Routing: a `debug` pool in presets, falling back to the preset default
  profile.
- TUI: launch dialog entry for `debug`, report rendered with the existing
  markdown artifact view, evidence panel (change 10) on the dashboard.

## Capabilities

### New Capabilities

- `debug-workflow`: debug role contract, standalone debug family graph, review
  gate, report and patch outputs, detached worktree.

## Impact

- `agent-definitions/instructions/debug.md`, `src/workflow/steps/debug.ts`,
  `src/workflow/definitions/graphs/debug.ts`, `registerBuiltins.ts`,
  `catalog.ts`, worktree port (`detached` attach), launch dialog
  (`src/tui/dash/launch.ts` / orchestrator `list_workflow_types`), README
  workflow list.
- Depends on `add-agent-environment-tools`, `add-workflow-evidence-store`,
  `add-agent-browser-sessions`, `add-agent-debug-tools`.
