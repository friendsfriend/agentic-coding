## Why

Dashboard App.tsx combines rendering, review state, submission, refresh, and navigation, while data.ts combines external observations, artifact reads, and projections. Their coupling makes focused review and testing harder; splitting by line count alone would not fix ownership.

## What Changes

- Extract review state/submission from the dashboard root into cohesive feature modules.
- Separate observation/artifact I/O from deterministic dashboard projections.
- Keep the root component responsible for composition and lifecycle wiring, not feature implementation.
- Preserve current action-ID/revision contracts, UI behavior, and observation-versus-authority distinction.

## Capabilities

### New Capabilities

- `dashboard-module-boundaries`: Explicit ownership of review state, observation I/O, projections, and root composition without changing user-facing behavior.

### Modified Capabilities

None. Existing dashboard requirements remain unchanged.

## Impact

- Priority: low; architecture cleanup finding 2.
- Depends on `separate-workflow-observation-execution`; move the resulting scheduling and asynchronous observation code without redesigning it again.
- Code: `agentic-coding/src/tui/dash/App.tsx`, `data.ts`, and directly affected dashboard feature/test imports.
- No persisted schema, workflow definitions, engine contracts, or user-visible behavior changes.

## Non-goals

No arbitrary file-size target, global state store, new UI framework, component primitive consolidation, or unrelated review UX improvements.
