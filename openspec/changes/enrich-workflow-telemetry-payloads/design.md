# Design: Enrich Workflow Telemetry Payloads

## Context

Workflow telemetry has three emitters that all write the same envelope shape
(`TelemetryEnvelope` in `workflow/observability.ts`) into
`.herdr-workflow/<workflowId>/telemetry.jsonl` and, when
`OTEL_EXPORTER_OTLP_ENDPOINT` is set, POST the same envelope to the collector:

1. the engine, via `WorkflowEngine.telemetryEffect` (`runtime/engine.ts`), layer `engine`;
2. the pi extension bridge (`agent-definitions/bridges/pi-telemetry.ts`), layer `runtime`, runtime `pi`;
3. the opencode plugin bridges (`bridges/opencode-telemetry.js`, `bridges/opencode-v2-telemetry.js`), layer `runtime`.

Today the engine passes only the event *name* to `telemetryEffect`, so engine
events carry no role, profile, runtime, or run identity and no payload at all —
the committed event `data_json` and the affected run/effect rows are discarded.
The pi bridge emits four events and drops tool duration, model, provider, turn,
compaction, and context pressure. The opencode bridge forwards only
`sessionId` and drops the `part.type` discriminator, which is where step usage,
cost, tool status, and tool durations live. `layer: "adapter"` is declared but
never emitted, so the baseline launch/assignment/stop observability the
telemetry capability already requires does not exist. The TUI parser
(`tui/otel/model/parser.ts`) maps a fixed list of envelope fields, so payloads
written at the envelope top level — including the existing pi `inputTokens` /
`outputTokens` / `cost` — never reach the trace viewer.

The change is observational: no workflow transition, run status, effect
retry, or agent lifecycle may depend on telemetry, and the flush budget
(`TELEMETRY_FLUSH_BUDGET_MS`) stays the only liveness bound.

## Goals / Non-Goals

**Goals:**

- Every exported event is self-describing: layer, workflow, step, and, when
  attributable, run, role, profile, runtime, runtime session, effect, and attempt.
- Every event carries a bounded, numeric, content-free payload sufficient to
  judge session effectiveness without reading neighboring rows: outcome,
  duration, attempts, retries, tokens, cost, tool failure and duration,
  question round-trips, developer wait time, artifact size, findings counts.
- The two committed-but-unexported durable events are exported.
- Adapter-layer baseline events exist for launch, assignment delivery, observed
  status, stop, error, and handoff.
- The TUI renders every event and every attribute it receives, including
  numeric and boolean values from envelopes, OTLP, and legacy payloads.

**Non-Goals:**

- No content capture. Prompts, model text, tool arguments, tool results, and
  repository content stay excluded unless the existing explicit opt-in is set.
- No analysis pipeline, warehouse, aggregation table, dashboard chart, or
  sampling layer. The deliverable is the event stream, not a report.
- No new OTLP schema, receiver, or export transport; envelopes keep their
  current JSONL-plus-`/v1/logs` shape.
- No change to workflow state, command set, definitions, or run lifecycle.
- No retroactive rewrite of existing `telemetry.jsonl` files.

## Decisions

### D1: Payload is produced inside the commit transaction, telemetry stays outside

`telemetryEffect` currently receives only an event name and runs after commit by
design (a telemetry failure must never roll back a committed command). Resolving
run/effect identity there would mean a second store read outside the commit.

**Decision:** `commitStart` and `commitDispatch` return the telemetry payload
they already have in hand — the committed event (`type`, `actor`, `data`), the
pre- and post-command snapshot status, the affected run row or effect row, and
the bounded aggregate counts for the roll-up. `telemetryEffect` remains a pure
sink that formats and emits; it never opens a transaction.

Rationale: one read, one transaction, no second validation path, and the
observational boundary stays where it is. Alternative considered — letting
`telemetryEffect` resolve identity itself — was rejected because it duplicates
`locate`/`runs` reads outside the transaction and can observe a newer revision
than the event it is describing.

### D2: Do not fail the command when a payload field cannot be resolved

Every payload field is optional. Unresolvable identity or missing data is
omitted, never inferred, and a payload-building failure degrades that event's
payload rather than throwing from inside the commit path. Roll-up emission is
best-effort and idempotent per commit: it is emitted on the transition into
`completed`, `closed`, or `attention-required` when the pre-command status was
not already terminal, so a repeated dispatch cannot emit it twice.

### D3: Adapter events use the existing sink through options, not a new Effect service

`EffectRunner.drainProgram` runs with requirement `never` at its call site, and
the effect handlers are constructed in `operations.ts` where the application
layer is already available. Adding `WorkflowTelemetry` to the effect-runner
requirement set would force layer provisioning into the drain path and the
dashboard's child scopes for no benefit.

**Decision:** `AdapterEffectOptions` gains an optional
`telemetry?: (directory, envelope) => void`, defaulting to `TelemetrySink`, and
the launch/prompt/stop handlers emit through it. Rationale: same sink, same
boundary, no new service, drain requirements unchanged. Alternative considered —
a dedicated `AdapterTelemetry` service — was rejected as a second telemetry
boundary for one caller.

### D4: Attribute key namespaces are per layer

Engine attributes keep the `herdr.*` prefix already emitted by the parser
(`herdr.change.id`, `herdr.role`, `herdr.run.id`, `herdr.step.id`,
`herdr.effect.id`, `herdr.profile`, `herdr.outcome`). New engine payload keys
use `herdr.` too (`herdr.effect.kind`, `herdr.run.attempt`,
`herdr.questions.asked`, `herdr.findings.critical`, …). Runtime bridges use
`pi.*` and `oc.*` for runtime-specific keys so a runtime's own vocabulary never
collides with the workflow vocabulary. Values are numbers or short scalars;
durations, counts, tokens, costs, byte sizes, and attempt numbers are always
numbers so consumers can sum and average without parsing. Long strings are
truncated with the existing bounded-attribute helper, and any key containing
`content` stays filtered unless content capture is explicitly enabled.

### D5: Payload travels at the envelope top level and the TUI maps generically

The pi bridge already writes `inputTokens` / `outputTokens` / `cost` at the
envelope top level and the parser silently drops them, which is the concrete
"TUI does not support all messages" defect. Rewriting every legacy producer to
nest payloads under `attributes` would break the historical files already on
disk.

**Decision:** keep top-level payload fields as the wire shape, and make the
parser map every unknown top-level scalar envelope key to an attribute while
skipping the reserved envelope keys (`schemaVersion`, `at`, `layer`, `event`,
`workflowId`, `runId`, `stepId`, `role`, `profile`, `runtime`, `messageId`,
`effectId`, `traceparent`, `durationMs`, `outcome`, `attributes`). The named
`attributes` object keeps merging on top. Reserved keys keep their existing
`herdr.*` attribute names so current grouping, role filters, and dashboards do
not regress.

Rationale: legacy and new files render through one path, and a future bridge
field appears in the viewer without a parser change. Alternative considered —
a per-event-name attribute allowlist in the parser — was rejected because it
reintroduces exactly the "known field list" failure that dropped the token
fields in the first place.

### D6: Scalar types survive every ingest path

The JSONL path already preserves numbers and booleans. The OTLP decode path
(`tui/otel/model/parser.ts` `attrValue`) currently drops numeric strings for
`intValue`/`doubleValue`, which would silently blank the new numeric
attributes when the same envelope arrives through `/v1/logs`. The decoder is
normalized to accept numeric strings and to preserve int, double, bool, and
string distinctly, and the span detail view renders a number as a number rather
than coercing the type away.

### D7: Noise is dropped at the bridge, not filtered downstream

The opencode `event` hook currently forwards the entire opencode event stream;
in the local corpus that produced ~23k `runtime.tool` rows and large numbers of
pty/tui/server/installation/lsp/file-watcher rows with no analysis value.
Bridges drop those families and the pi `tool_execution_update` /
`message_update` streaming hooks are not wired at all, so the file keeps one row
per meaningful unit of work. Alternative considered — sampling or a retention
cap — was rejected because it discards the events that matter for the slowest
runs, which are the interesting ones.

### D8: Legacy event names stay readable

`tui/dash/projections.ts` and `tui/dash/ui/EventsModal.tsx` still read
`model_usage`, `provider_response`, `pi_agent_start`, `pi_agent_end`,
`pi_agent_settled`, and the retired verification/triage names. Those names stay
recognized (the TUI keeps degrading to the raw name for anything unknown) and no
dashboards are removed, because existing workflow directories keep loading.

## Risks / Trade-offs

- **[Telemetry file grows per workflow]** → payloads are bounded scalars, the
  noise families are dropped at the bridge, and content is never captured; the
  flush budget and the append-only sink are unchanged. If a file still grows
  unacceptably, the next step is dropping `message.part.updated` text/reasoning
  length rows, not sampling work events.
- **[New attributes break an existing consumer]** → consumers read by key and
  ignore unknown keys; the reserved keys and their `herdr.*` attribute names are
  unchanged, and legacy names remain recognized. Verified by the existing
  dashboard projection tests plus new parser tests over mixed old/new files.
- **[A payload bug inside the commit path rolls back a command]** → payload
  construction is bounded and strictly best-effort: field-level omission on
  failure, never a thrown error, and emission stays outside the transaction.
- **[Identity cannot be resolved for some event]** → the field is omitted, the
  event still exports, and the roll-up is emitted once per terminal transition
  rather than being re-derived later.
- **[pi/opencode hook payloads differ from the assumed shape]** → every field is
  read defensively and omitted when absent; the bridge never throws on an
  unexpected payload because telemetry must not affect the runtime.
- **[`embedded.generated.ts` drifts from bridge sources]** → bridges are edited
  in `agent-definitions/` and regenerated with `bun run build`; the generated
  file is never hand-edited.

## Migration Plan

1. Land the observability contract additions (payload types, bounded attribute
   helper, adapter emitter) with the engine and bridges.
2. Regenerate agent assets (`bun run build`) so new workflow runs get the new
   bridges; already-running or archived workflows keep their existing bridge
   copy and continue to write the old shape.
3. Land the TUI parser/rendering changes; they read both shapes, so old and new
   `telemetry.jsonl` files render with no migration step.
4. Rollback: revert the commit. Telemetry is observational, so nothing in
   workflow state needs repair; files written with extra keys remain readable by
   the older parser because it ignores unknown envelope keys.

## Open Questions

- Whether the roll-up should also be emitted from an explicit
  `workflow rollup` observation command for workflows that reach a terminal
  state without a dispatching command (for example closure by the timer sweep
  in `runtime/store.ts`). Default: yes, emit from the sweep too, through the
  same best-effort path.
- Whether `herdr.artifact.digest` should be a truncated digest or omitted in
  favour of the artifact byte size. Default: truncated digest, since it is what
  correlating a handoff with an evidence record needs.
