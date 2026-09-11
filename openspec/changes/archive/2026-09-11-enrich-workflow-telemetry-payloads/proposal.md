# Enrich Workflow Telemetry Payloads

## Why

Workflow telemetry answers "what event happened" but not "was this session effective". Engine events carry no role, profile, runtime, or run identity, so no engine span can be attributed to a role; runtime bridges throw away the data that matters most (`step-finish` tokens/cost, tool durations, provider status, context pressure). Two durable events (`effect.exhausted`, `legacy.migrated`) are never exported at all. Analysis today means grepping 23k untyped rows.

## What Changes

- Engine layer: every exported event carries workflow/step/revision/status plus role, profile, runtime, run/effect identity and runtime `session.id`; per-event numeric payloads (outcome, attempt, retry, findings counts, question round-trips, developer wait time, artifact size).
- Engine layer: emit the currently missing `effect.exhausted` and `legacy.migrated` events, and add the workflow roll-up fields needed for per-run effectiveness (`verification rounds`, revisions, runs, cost/token totals).
- Adapter layer: emit the baseline launch / assignment-delivered / observed-status / stop / error events the telemetry spec already requires but nothing produces.
- pi bridge: add tool-duration and turn bookkeeping and new events for provider responses, turns, model selection, compaction, and context growth; add model/provider/session identity to all events.
- opencode plugin: keep `sessionId`, add the per-`part.type` payload (step-finish tokens/cost, tool status/duration/sizes, retry attempts, error classes, permission latency, todo and diff counts) and drop the noise-only event families.
- TUI: parse, group, filter, and render every event name and attribute produced above, including numeric attributes and runtime/engine identity, and keep status/duration mapping correct for every event.
- **BREAKING** (telemetry file format, not the workflow contract): new attribute keys on existing event names. Legacy consumers must ignore unknown attributes; `telemetry.jsonl` from older runs stays readable.

## Capabilities

### New Capabilities
- `workflow-session-telemetry`: engine-owned per-event payload catalog, the required identity/session join keys, and the per-workflow roll-up fields that make a run analyzable for session effectiveness.
- `agent-session-payloads`: runtime-bridge owned per-event payload catalog for pi and opencode (usage, cost, tool duration and failure, provider latency, model selection, compaction, context pressure) plus the event set each bridge must emit and the noise it must not.

### Modified Capabilities
- `herdr-agent-telemetry`: adapter baseline telemetry becomes a real emitted layer (launch, assignment delivered, observed status, stop, error, handoff) and every event must carry role/run/profile/runtime/session identity rather than only the ones a bridge happens to send.
- `trace-tree-view`: the TUI must render every telemetry event and attribute (numeric included), keep the correct status/duration mapping, group by workflow, filter on the new attributes, and degrade gracefully on unknown event names.

## Impact

- `agentic-coding/src/workflow/observability.ts` — envelope/attribute contract and bounded attribute helper.
- `agentic-coding/src/workflow/runtime/engine.ts` — `telemetryEffect` receives the committed event and run/effect identity; new emissions.
- `agentic-coding/src/workflow/runtime/store.ts`, `runtime/migration.ts` — route the two unexported events through the telemetry boundary.
- `agentic-coding/src/workflow/effect-runner.ts` — adapter-layer baseline emissions around launch/prompt/stop.
- `agent-definitions/bridges/pi-telemetry.ts`, `bridges/opencode-telemetry.js`, `bridges/opencode-v2-telemetry.js` — payloads, new hooks, noise pruning (regenerated into `embedded.generated.ts` by `bun run build`).
- `agentic-coding/src/tui/otel/model/parser.ts`, `tui/otel/views/*`, `tui/dash/projections.ts`, `tui/dash/ui/EventsModal.tsx` — render/consume the new events and attributes.
- Existing `telemetry.jsonl` files stay readable; no workflow state migration, no change to workflow transitions or agent lifecycle.
