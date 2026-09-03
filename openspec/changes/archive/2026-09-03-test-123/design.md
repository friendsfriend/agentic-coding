## Context

`agentic-coding/src/tui/dash/data.ts` computes `durationSeconds` per verifier run from telemetry start/end timestamps. `agentic-coding/src/tui/dash/App.tsx` renders it directly as `· ${durationSeconds}s` when defined. The duration is bounded and small (verification rounds), but raw seconds become unreadable past a few minutes (e.g. `184s`). The fix is a pure formatting function, not a change to how durations are measured.

## Goals / Non-Goals

**Goals:**
- Provide a compact humanized duration string for run labels.
- Keep the helper pure, synchronous, and dependency-free.
- Cover formatting rules with unit tests.
- Preserve current behavior when a duration is unavailable.

**Non-Goals:**
- Changing how durations are measured or stored (telemetry timestamps stay as-is).
- Changing units or labels elsewhere in the dashboard (age label stays `Xh`).
- Adding i18n, pluralization options, or configurable formats.
- Touching the workflow engine, runtime, or OpenSpec pipeline.

## Decisions

### Pure helper with compact units

Implement `formatDuration(totalSeconds: number): string` as a pure function:

- Non-finite or negative input is clamped to `0s`.
- Less than 60 seconds: whole seconds, e.g. `0s`, `3s`, `59s`.
- 60–3599 seconds: minutes plus leftover seconds, e.g. `2m`, `4m 5s` (zero leftover seconds renders as just `2m`).
- 3600 seconds and up: hours plus leftover minutes, e.g. `1h`, `1h 5m`, `25h 2m` (sub-minute remainder is truncated).

Rounding is truncation toward zero on each unit, which matches the existing `Math.floor` behavior in `data.ts` (`durationSeconds` is already floored before it reaches the helper).

Alternative considered: rendering with a single unit (`4m` for 245s). Rejected because sub-minute precision is useful for short verification runs.

### Integration point

Replace the inline template in `App.tsx` (`· ${entry().durationSeconds}s`) with `· ${formatDuration(entry().durationSeconds)}`, keeping the existing `durationSeconds !== undefined` guard. The helper lives in `src/workflow/format.ts` (same package, no imports beyond standard library) so it can be unit-tested in isolation and reused later.

### Verification

- `bun test agentic-coding/test/workflow-format.test.ts` covers seconds, minutes, hours, truncation, and clamping.
- Full suite `bun test` and `tsc --noEmit` must pass.

## Risks

- Low. The change is display-only; `data.ts` output shape is unchanged. Dashboard tests already exercise rendering paths, so regressions would surface in `bun test`/type-check.
