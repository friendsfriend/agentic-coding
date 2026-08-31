## 1. Blocked phase presentation

- [x] 1.1 Derive a current-phase blocked flag in `agentic-coding/src/tui/dash/App.tsx` from the projected workflow's `attention-required` status and a run with `status: "blocked"` for the current step, without using agent observations or historical runs from other steps.
- [x] 1.2 Render a separate compact `BLOCKED` indicator beside the existing phase badge in the Change panel, using attention styling and static animation while preserving the existing phase label and terminality-based animation rules.

## 2. Focused dashboard coverage

- [x] 2.1 Add focused TUI tests for a blocked current phase, asserting that the phase label remains visible and a distinct `BLOCKED` indicator is rendered.
- [x] 2.2 Cover non-blocked active workflows, multiple working agents, unrelated `attention-required` state, and a historical blocked run from another phase to ensure none are mislabeled; retain coverage that terminality controls the phase badge animation.

## 3. Validation

- [x] 3.1 Run the focused blocked-phase dashboard test file(s) and `bun run type-check` from `agentic-coding/`; resolve any failures or formatting/type issues caused by the change.
