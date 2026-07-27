## Why

The workflow engine and its terminal UIs grew as three separately-built surfaces, and the seams between them have accumulated structural debt:

- The **workflow engine** is Python (`pi/lib/herdr_workflow/`, ~3.6k LOC), while both terminal UIs (`agent-dash`, `otel-tui`) and both Pi extensions are TypeScript. The engine and the dashboard therefore share three *implicit, hand-duplicated* contracts — the phase list, the `state.json` shape, and the phase→action map. They have already drifted: the phase lists even disagree on order (`transitions.py` has `…developer-review, committing, archive, completed`; `data.ts` has `…developer-review, archive, committing, completed`), and the TS `WorkflowState` interface is missing `tabs`, `workflowType`, `developerApproval`, `otelTraceRoot*`, and every verification-layout field the engine actually writes.
- `commands.py` is a **1298-line god module** that mixes phase orchestration, git/ssh plumbing, terminal BSP pane-layout geometry, tracing/telemetry, and plugin management.
- **Terminal-layout state leaks into durable workflow state** — `verificationSecondRowPane`, `verificationSecondRowRole`, and `verificationPaneOrder` are persisted in `state.json`, coupling workflow correctness to terminal geometry.
- Every surface **independently shells `herdr` and re-parses the `.result` envelope** (once in `effects.py`, five times in `data.ts`, plus the extension); pane-geometry math is duplicated between `launch_role` and the dashboard's `focusAgent`.
- The dashboard **polls every 5s**, re-spawning `herdr agent list`, `herdr workspace list`, and multiple `git` calls per cycle, even though the engine already emits watchable `telemetry.jsonl` / `traces.jsonl`.
- The **otel trace-viewer code is duplicated** — `agent-dash/src/otel-tui.tsx`, `TraceBrowser`, `traces.ts`, and `receiver` exist both inside `agent-dash` and as the standalone `otel-tui/` project.

This is `architecture-checkup-round-1`: a **spec-only analysis catalog**. It does not change engine or UI code. It records the findings, the agreed target architecture, and a ranked migration backlog so later rounds can implement each item independently.

## What Changes

- Add a new living catalog capability, `agentic-coding-consolidation`, that documents:
  - The **target architecture**: a single TypeScript umbrella binary `agentic-coding` that provides the workflow engine (`agentic-coding workflow <verb>`) plus the dashboard TUI views (`agentic-coding dash` / `agentic-coding home` / `agentic-coding manager`), importing the engine in-process rather than shelling it. The Python engine is retired. `otel-tui` stays a **separate** binary.
  - A **CLI compatibility requirement**: agent-facing invocations (`herdr-workflow verify …`, `dispatch-verifiers`, `verification-result`, `phase proposed`, and the `PLAN_REJECTED` loop) must keep working unchanged, via a thin `herdr-workflow` → `agentic-coding workflow` shim.
  - A **ranked backlog (R1–R8)**, one requirement per finding, each with tier (High/Med/Low), effort (S/M/L/XL), evidence, and a target-state invariant.
- No engine, dashboard, or config code is modified in this change. Implementation is deferred to subsequent rounds.

## Capabilities

### Added Capabilities

- `agentic-coding-consolidation`: Living catalog of the workflow↔TUI architecture findings, the agreed single-binary TypeScript target, and the ranked migration backlog.

## Impact

- Affected files: `openspec/changes/architecture-checkup-round-1/**` only. No source code, config, or tests are touched.
- No runtime dependency changes.
- Consumers of this catalog: later `architecture-checkup-round-N` changes that implement R1–R8. Each backlog item is written to be independently actionable.
- Non-goals: performing the TypeScript port, splitting `commands.py`, renaming binaries, or changing the refresh model in this change.
