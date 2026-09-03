# Tasks

## 1. Helper

- [x] 1.1 Add `agentic-coding/src/workflow/format.ts` exporting pure `formatDuration(totalSeconds: number): string`.
- [x] 1.2 Implement unit rules: clamp non-finite/negative to `0s`; `< 60s` as `Ns`; `60–3599s` as `Xm` or `Xm Ys`; `>= 3600s` as `Xh` or `Xh Ym`; truncate remainders.

## 2. Dashboard integration

- [x] 2.1 In `agentic-coding/src/tui/dash/App.tsx`, replace the raw `· ${entry().durationSeconds}s` label with `· ${formatDuration(entry().durationSeconds)}`, keeping the existing `!== undefined` guard.

## 3. Tests and verification

- [x] 3.1 Add `agentic-coding/test/workflow-format.test.ts` covering: 0s, sub-minute values, exact-minute values, minute+seconds, hour, hour+minute, long durations (>24h), non-finite and negative clamping.
- [x] 3.2 Run focused tests (`bun test test/workflow-format.test.ts`, `bun test test/workflow-dashboard.test.ts`) and `tsc --noEmit`; all pass with no regressions.
