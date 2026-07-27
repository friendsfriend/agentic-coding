## Why

Once the engine is TypeScript (`consolidate-workflow-to-typescript`), the dashboard no longer needs to shell out to it. `architecture-checkup-round-1` cataloged R4 and R5 as the integration seam that consolidation unlocks:

- **R4** — Every surface independently shells `herdr` and re-parses the `.result` envelope (once in the engine's `effects`, multiple call sites in `data.ts`, plus the extension); pane-geometry math is duplicated between the engine's `launch_role` and the dashboard's `focusAgent`.
- **R5** — The dashboard polls every 5s, re-spawning `herdr agent list`, `herdr workspace list`, and multiple `git` calls per cycle, even though the engine already emits watchable `telemetry.jsonl` / `traces.jsonl`.

With one runtime, the dashboard imports the engine and shares one Herdr client, and refresh becomes event-driven.

## What Changes

- The dashboard imports the engine module in-process instead of `Bun.spawn("herdr-workflow", …)` + JSON reparse for workflow actions and status reads.
- Introduce one shared Herdr client module (single `.result` envelope parser, shared pane-geometry helpers) consumed by the engine and the dashboard; remove the duplicate parsers in `data.ts`.
- Replace the 5s re-spawn poll with an event/watch-driven refresh that tails `telemetry.jsonl` / `traces.jsonl` and reacts to workflow-state file changes; keep a low-frequency safety re-sync.

## Capabilities

### Added Capabilities

- `dashboard-engine-integration`: In-process engine use, a single shared Herdr client, and an event-driven dashboard refresh.

## Impact

- Affected areas: `agent-dash` data layer and refresh loop; shared Herdr client module.
- Depends on: `consolidate-workflow-to-typescript` (R1) landed. Blocks: none.
- Non-goals: otel viewer dedupe and cleanups (`workflow-tui-cleanups`).
