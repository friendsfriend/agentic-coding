## 1. Capture boundaries and behavior

- [ ] 1.1 Confirm separate-workflow-observation-execution is implemented and identify its final observation/coordinator APIs before moving callers.
- [ ] 1.2 Inventory App.tsx/data.ts responsibilities and exports; select cohesive review, observation/artifact, and projection groups without line-count targets.
- [ ] 1.3 Capture representative projection outputs and plan/developer/wiki review submission payloads, stale revision handling, cancellation, and pending-question behavior.

## 2. Extract cohesive modules

- [ ] 2.1 Move deterministic projections into data-in/display-out helpers with explicit time inputs and no external reads.
- [ ] 2.2 Move observation/artifact I/O into separate modules while preserving asynchronous cancellation, evidence diagnostics, and execution ownership.
- [ ] 2.3 Extract review signals/drafts/submission into dashboard-local feature modules with explicit dependencies and correct Solid owner cleanup.
- [ ] 2.4 Reduce App.tsx to composition, layout, and lifecycle wiring; preserve engine action-ID/revision authority and current navigation behavior.
- [ ] 2.5 Retarget imports, relocate unnecessary live-path demo fixtures, and remove obsolete duplicate logic; preserve narrow compatibility re-exports only where callers need them.

## 3. Validate and document

- [ ] 3.1 Test deterministic projections, unchanged review payloads, missing/invalid evidence, unmount disposal, late results after navigation, and stale-action refresh behavior.
- [ ] 3.2 Run affected workflow-dashboard and dashboard review/question/markdown/navigation renderer tests after each cohesive move.
- [ ] 3.3 Document feature, observation, projection, and root ownership and coordinate shared primitive imports with consolidate-tui-primitives if already landed.
- [ ] 3.4 From agentic-coding/, run bun run type-check, bun run lint with zero diagnostics, and bun run build.
- [ ] 3.5 Run openspec validate split-dashboard-responsibilities --strict and verify no persisted contracts, pins, execution scheduling, or UI behavior changed.
