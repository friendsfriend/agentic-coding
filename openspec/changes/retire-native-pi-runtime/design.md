## Context

`add-pi-durable-runtime` keeps `pi` selectable as a legacy runtime. Running workflows pin their route, so removal must not strand a workflow that still has a `pi` route pinned.

## Goals / Non-Goals

**Goals:** remove the legacy runtime and its pi-only surfaces; give users an explicit, previewable config migration.

**Non-Goals:** changing the durable runtime itself; removing OpenCode adapters.

## Decisions

- Migration reuses `agentic-coding config migrate` (preview by default, `--apply` writes with backup) to rewrite `pi` profiles/presets to `pi-durable`, keeping model and thinking values.
- Workflows with a pinned `pi` route that are still active are refused at resume with a diagnostic recommending `repair`, never silently re-routed (no implicit runtime fallback).
- Server session listing reads durable host storages instead of pi JSONL session files.

## Risks / Trade-offs

- [Users depending on pi extensions or codemode] → land `pi-durable-codemode-parity` first or document the gap.
- [Active workflows pinned to `pi`] → explicit refusal plus repair guidance.
