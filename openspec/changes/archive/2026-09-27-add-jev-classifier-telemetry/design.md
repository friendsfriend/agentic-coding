# Design

## Context

See `proposal.md` — Why. The relevant current state:

- The routing integration is the only model-driven part of a workflow run with
  no telemetry. `invokeRoutingClassifier` (`agentic-coding/src/workflow/classifier-runner.ts`)
  posts the System One request inside the engine process via `postJsonEffect`
  and returns `{ integration, phase, answers }`; nothing on that path touches a
  telemetry sink. There is no runtime pane and no bridge, so the pi-shaped
  `runtime.*` session events have no counterpart.
- The `model.classify` effect handler lives in `effect-runner.ts`, which already
  owns an optional bounded telemetry emit used for the adapter-layer
  `agent.launch*` / `agent.assignment.delivered` events.
- The applied routing is decided in the engine's commit transaction:
  `applyClassifierRouting` → `applyPoolRouting` in
  `runtime/reducers/effect-result.ts` calls `selectSingleEntry` /
  `selectRosterEntries`, overlays the selections on `snapshot.routing`, and
  appends an `attention` entry per fallback. Afterwards the engine emits
  post-commit telemetry through `telemetryEffect` (`runtime/engine.ts`), which
  merges `herdr.revision` / `herdr.status` and an event-specific payload. A
  secondary event already exists in that path: `workflow.rollup` is emitted from
  a payload the reducer produced, which is the pattern this change follows.
- The consumer side is generic: `parseTelemetryLine` maps every scalar envelope
  key to a span attribute, and the trace tree groups spans by the segment before
  the first dot through `CATEGORY_BY_FAMILY` in
  `agentic-coding/src/tui/otel/model/traceStore.ts`, falling back to the raw
  family name.
- Wire constraints that already hold and must keep holding: one JSONL row per
  event in `.herdr-workflow/<workflowId>/telemetry.jsonl`; the same
  `workflowTraceId(workflowId)` on every event; bounded payload
  (`TELEMETRY_ATTRIBUTE_LIMIT`), credential redaction
  (`redactTelemetryText`), a non-raising sink, and the shared
  `TELEMETRY_FLUSH_BUDGET_MS` for OTLP export.

## Goals / Non-Goals

**Goals:**

- One findable, self-describing event per completed routing pass, containing the
  pass outcome and the per-step decision that was actually applied.
- A provider-call record per classifier call with the same metadata shape the pi
  bridge publishes for its provider calls (model, status, status class, latency,
  usage), so a slow or failing classifier is as diagnosable as a slow agent.
- Zero new wire concepts: same envelope, same trace identity, same bounds, same
  redaction, same non-raising sink, generic viewer rendering.

**Non-Goals:**

- No routing content capture. Prompt, task, artifact, criteria, and answer text
  stay out of the stream permanently, not behind the `telemetry.capture_content`
  opt-in — the classifier's "session" is not an agent conversation.
- No aggregate routing metrics, no new observability views, no dashboard panel.
  Routing events land as spans only, grouped under one category node.
- No change to routing behavior, pools, selection floors, fallbacks, or
  attention handling.
- No `runtime.*` session bridge for the classifier, and no model/session
  identity beyond the effect id of the pass.

## Decisions

### 1. One `routing.*` event family, emitted on the two layers that own the facts

| Event | Layer | Emitter | When |
| --- | --- | --- | --- |
| `routing.request` | `adapter` | `model.classify` effect handler in `effect-runner.ts` | immediately before the System One call |
| `routing.response` | `adapter` | same handler | when the call returns, fails, or times out |
| `routing.classified` | `engine` | engine, next to the existing `workflow.rollup` emission | after the `effect.result` commit that applied the pass |

Rationale: the provider facts (model, counts, request bytes, HTTP status,
latency) exist only in the effect handler, which already owns a bounded emit on
the adapter layer; the decision facts (which profile each step ended up with,
whether a fallback happened) exist only after the commit, in the engine, which
already owns the non-raising post-commit emission. Splitting by owner keeps
every emission in the process that actually holds the data and avoids inventing
a second telemetry service.

Rejected alternatives:

- *Enrich the existing `effect.result` row only.* Fewer events, but per-step
  routing data on a generic effect row is ungroupable and unreadable, and a pass
  that fails would have no row of its own.
- *A `runtime.*` session bridge for the classifier.* The pi bridge keys on
  `ExtensionContext` session/model/thinking state that a System One call does
  not have; there is no session to correlate, so `runtime.*` would be a naming
  lie and would drag the agent-category grouping onto non-agent work.

### 2. The decision record is computed by the reducer, emitted by the engine

`applyPoolRouting` already computes every value the record needs (the per-step
selection, the applied profile(s), the roster size, the attention entries for
fallbacks) and throws it away today. It is refactored to return a pure
`RoutingDecisionSummary` (plain data, built in `classifiers.ts` so the domain
owns the shape), which the `effectResult` reducer attaches to the committed
event data. The engine's `buildDispatchTelemetry` picks that summary up the same
way it picks up `rollupPayload`, and the engine emits `routing.classified`
right after the `effect.result` row.

Rationale: the fallback and applied-profile facts are only knowable at the point
of application. Recomputing them in the emitter would mean re-resolving the
preset and re-running the selectors against a second config read, which could
drift from what was actually pinned. Passing the summary out of the commit keeps
one evaluation, and the summary is part of the same post-commit, non-raising
telemetry path, so it can never roll back the command that produced it.

Rejected alternative: emit `routing.classified` from inside the reducer /
handler. The reducer runs inside the commit transaction and must not do I/O;
the handler does not know the applied result.

### 3. The record reports applied results, never raw model output

Payload contract (all keys are envelope-top-level scalars, `herdr.routing.*`
naming per the `herdr.*` workflow vocabulary):

`routing.request` and `routing.response` share:

- `model` (existing envelope field, same as the pi bridge), `herdr.routing.integration`,
  `herdr.routing.phase`, `herdr.routing.steps.asked`,
  `herdr.routing.entries.offered`, `herdr.routing.artifacts.count`,
  `herdr.routing.state.bytes`, `herdr.routing.timeout.ms`,
  `herdr.routing.endpoint.host`

`routing.response` adds:

- `outcome` (`ok` / `error`), `durationMs`, `herdr.routing.status` (HTTP status
  when one was received), `herdr.routing.status.class` (`2xx` / `4xx` / `5xx` /
  `transport`), `herdr.error.class` (redacted, reusing the engine's existing
  field), `herdr.routing.answers.choice` / `.answers.noul` counts, and
  `tokens` / `cost` (existing envelope fields) only when the provider reported
  usage.

`routing.classified` adds:

- `herdr.routing.phase`, `herdr.routing.steps.asked`,
  `herdr.routing.steps.applied`, `herdr.routing.fallback.count`, and per asked
  step `herdr.routing.<stepId>.label`, `.confidence`, `.fallback` (boolean),
  `.profile` (single steps) / `.profiles` (stable comma-joined applied roster
  profiles) and `.selected.count` (roster steps).

Only what was applied is exported: for a below-floor or `noul` answer the label
is the pool's tagged default, never the rejected answer's label, and roster
probabilities are reduced to the applied count and profiles. Confidence is
exported as a number when the provider reported one, because a number cannot
carry session content and it is what makes "why did it fall back?" answerable.
Pool `criteria` and the provider's free-form answer text are never exported.

Rationale: a routing decision is only actionable if it says what actually
happened. Reporting the rejected label would be both misleading and an
unvalidated model string in the stream; the pool label set is closed, config
vocabulary, and small.

### 4. Bounding, redaction, and failure isolation are the existing ones

Every routing payload goes through the same `boundedTelemetryPayload` filter as
every other event, and every string the routing records add (model, endpoint
host, label, profile, error class) is passed through `redactTelemetryText`
before it enters the payload. No new bound, no new key filter, no new sink.
Handler-side emission is wrapped so a failure resolves to a no-op, matching the
existing adapter events; the engine-side emission already cannot raise.

Rationale: re-implementing bounds is how telemetry leaks credentials and grows
unbounded attributes; reusing the one helper is both safer and smaller.

### 5. The viewer needs one line

`routing` is added to `CATEGORY_BY_FAMILY` in `traceStore.ts` mapping to the
label `classifier routing`. Nothing else: the parser, span rendering, span
detail, search, and filtering are already generic over event families and
attributes, and the existing "every event renders" requirement already covers
events with no display label.

### 6. Documentation follows the code

`agentic-coding/docs/agent-session-telemetry.md` gains the two new event
families and the rationale that classifier content is never captured — the doc
is the place a user looks to learn what leaves the machine, and a permanent
content exclusion is exactly the kind of fact that must be documented, not
implied.

## Risks / Trade-offs

- [Emission from the effect handler duplicates identity resolution] → the
  handler already resolves run/step/role/profile for adapter events; routing
  events resolve workflow id, step id, and effect id from the same snapshot and
  the leased effect row, and the spec forbids placeholder identity fields.
- [A dynamic per-step attribute key set (`herdr.routing.<stepId>.*`)] → keys are
  bounded by the classifiable step set (at most eight) and every value is a
  scalar, so the bounded-payload filter still applies; the alternative
  (a JSON blob) would violate the scalar-attribute contract and break viewer
  filtering.
- [The decision summary grows the committed event data] → it is plain
  scalars-only data derived during the commit, and it is what makes the emission
  truthful; it is not persisted as workflow state.
- [Token/cost usage may never appear for this endpoint] → the fields are
  emitted only when reported, per spec; an always-empty field would be a lie.
- [The engine is the only emitter, so a crash between call and commit yields a
  response record with no decision record] → the provider-call record is exactly
  what makes that case diagnosable, which is why it exists.
