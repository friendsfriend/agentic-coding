## Why

`architecture-checkup-round-1` cataloged R1–R3 as the tightly-coupled core of the consolidation: they all happen during one port and cannot be done independently.

- **R1** — The workflow engine is Python (`pi/lib/herdr_workflow/`, ~3.6k LOC) while the dashboard, otel viewer, and Pi extensions are TypeScript. The split forces the engine and dashboard to share three hand-duplicated contracts (phase list, `state.json` shape, phase→action map) that have already drifted — the phase lists even disagree on order.
- **R2** — `commands.py` is a 1298-line god module mixing phase orchestration, git/ssh, terminal BSP pane-layout geometry, tracing/telemetry, and plugin management.
- **R3** — Terminal-layout fields (`verificationSecondRowPane`, `verificationSecondRowRole`, `verificationPaneOrder`) are persisted in durable `state.json`.

Porting the engine to TypeScript is the moment to also draw module boundaries (R2) and drop layout state from persisted workflow state (R3); doing them separately would mean porting the mess first and refactoring twice.

## What Changes

- **BREAKING** Reimplement the workflow engine in TypeScript as `agentic-coding workflow <verb>`, sharing the dashboard's runtime and types. Retire `pi/lib/herdr_workflow/` and `pi/bin/herdr-workflow` (Python).
- Add a thin `herdr-workflow` shim executable that forwards `argv` to `agentic-coding workflow`, preserving the exact agent-facing CLI surface (skills, prompts, `PLAN_REJECTED` loop unchanged).
- Draw module boundaries in the port: orchestration, git/ssh, terminal layout, tracing/telemetry, and plugins each live in their own module (no single module spans all).
- Remove terminal-layout fields from persisted `state.json`; reconstruct verification pane layout from live Herdr queries or a non-durable layout store.
- Port the pytest suite to `bun test`; it is the behavioral-parity oracle (exact verb stdout + `state.json` semantics).

## Capabilities

### Added Capabilities

- `workflow-engine-runtime`: The TypeScript workflow engine binary surface, its CLI-compatibility guarantee, its module boundaries, and its persisted-state invariants.

## Impact

- Affected areas: new TS engine under the `agentic-coding` binary; `herdr-workflow` shim; removal of `pi/lib/herdr_workflow/` and `pi/bin/herdr-workflow`; test port to `bun test`.
- Depends on: `architecture-checkup-round-1` (catalog) approved. Blocks: `dashboard-in-process-engine` (R4/R5).
- Agents are unaffected at the CLI level thanks to the shim.
- Non-goals: dashboard in-process integration, refresh model, otel dedupe (later changes).
