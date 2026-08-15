# Proposal: Humanized run durations in the workflow dashboard

## Why

The workflow dashboard renders agent run durations as raw seconds, e.g. `· 184s`, which is hard to read for long-running verification rounds. This change adds a small pure `formatDuration` helper and uses it in the dashboard, replacing raw-second labels with compact humanized durations (`3s`, `4m`, `1h 5m`). It also exercises the full workflow pipeline (plan -> implement -> verify -> archive -> deliver) as a smoke test with a change that is minimal, deterministic, and easy to verify.

## What Changes

- Add a pure `formatDuration(totalSeconds: number): string` helper in `agentic-coding/src/workflow/format.ts`.
- Use it in the dashboard run-duration label in `agentic-coding/src/tui/dash/App.tsx` (the `· <duration>s` label for verifier runs).
- Add unit tests for the helper in `agentic-coding/test/workflow-format.test.ts`.
- Keep the existing guard that omits the label when no duration is available.

## Capabilities

### New Capabilities
- `workflow-duration-formatting`: Humanized formatting of run durations in the workflow dashboard, backed by a pure, unit-tested helper.

### Modified Capabilities

- None.

## Impact

- Adds a small pure TypeScript module (`format.ts`) with no dependencies.
- Changes one display label in the dashboard; no behavior change when duration is unknown.
- Adds unit tests run via `bun test`; existing tests and `tsc --noEmit` must stay green.
- No changes to workflow engine, persistence, CLI, or OpenSpec artifacts.
