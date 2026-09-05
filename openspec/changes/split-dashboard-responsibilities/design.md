## Context

`App.tsx` owns review popups, comments, submission, navigation, refresh, and rendering. `data.ts` owns Git/Herdr reads, artifact parsing, telemetry aggregation, fixtures, and projections. Existing tests already cover actions, stale revisions, renderer interactions, and evidence-derived findings.

## Goals / Non-Goals

**Goals:** review features have cohesive state/submission ownership, projections accept data instead of performing I/O, and the root composes these pieces.

**Non-goals:** arbitrary size limits, new global stores, visual changes, altered action availability, or another execution scheduler.

## Decisions

### Separate at responsibility boundaries

After `separate-workflow-observation-execution`, identify the resulting interfaces for asynchronous observations and explicit command execution. Move review state and submission into a dashboard-local feature module using existing Solid signals and callbacks. It owns draft comments, pending/error state, and submission payload construction, but it uses the displayed engine action ID/revision and does not infer workflow semantics from step IDs.

Move external observation/artifact readers out of projection helpers. Projections accept typed workflow views plus observations/artifact results and return display data without Git, Herdr, filesystem, timers, or database access. Keep test-only demo data in test/demo ownership rather than importing fixtures into every live refresh path when unnecessary.

Keep `App.tsx` as composition, subscription/disposal, and layout wiring. Do not move a large closure into a single equally opaque context object; give each extracted feature the specific inputs it already uses. Preserve public exports where callers need them, with temporary re-exports rather than duplicate behavior.

### Preserve behavior during the move

Capture review submission payloads and representative projection output before extraction. Test plan/developer/wiki reviews, pending questions, stale revisions, cancellation, selection changes, and late observation results. Keep action authority in WorkflowView, artifact digest checks in their existing trusted boundary, and execution lifecycle ownership unchanged.

The new architectural spec records module ownership without changing existing dashboard behavior requirements. The installed OpenSpec CLI does not honor the archived skip_specs convention. A discovered UX or evidence bug gets its own change rather than modifying a characterization fixture to conceal a behavior difference.

## Risks / Trade-offs

- Extracted signals can outlive the component → preserve Solid ownership and onCleanup semantics.
- A data module can become a service locator → use explicit typed inputs and narrow exports, not a global dashboard context.
- A broad move can obscure accidental changes → extract one feature/projection family per green test run.

## Migration Plan

Depends on completed observation/execution separation. Move pure projections first, then review state/submission, then trim root wiring and obsolete imports. Coordinate primitive imports with `consolidate-tui-primitives` if it lands first. No data migration or behavior-version bump is expected; rollback is a code revert.
