# Proposal

## Why

Classifier-driven model routing makes the JEV/System One classifier the brain of
every classifiable workflow step, but that call is the one part of a workflow
run with no observability at all: it is a bare HTTP request made by the engine
process, so no runtime bridge emits rows for it. The only trace of a routing
pass in the OTEL/JSONL telemetry stream is the generic `effect.result` row with
`herdr.effect.kind=model.classify`, which says nothing about which model was
asked, how long it took, what it answered per step, which pool entries were
applied, or whether the pass silently fell back to the tagged defaults. Every
other model-driven part of a run (the pi and opencode agent sessions) is fully
monitorable, so a workflow's routing behaviour cannot be reviewed, tuned, or
debugged the way its sessions can.

## What Changes

- Emit a dedicated, content-free telemetry event per classification pass that
  records the pass outcome and the per-step decision: asked label, reported
  confidence, the profile(s) actually pinned for that step after the pass, and
  whether the pass fell back to a tagged default.
- Emit a provider-call event pair around every System One request the routing
  integration makes, recording the classifier model, the question/entry counts,
  the bounded state size, the HTTP status class, the measured latency, and the
  reported token/cost usage when the endpoint returns it — the same metadata
  shape the pi bridge already publishes for its provider calls.
- Keep both event families on the existing telemetry wire contract (one JSONL
  row per event in `.herdr-workflow/<id>/telemetry.jsonl`, plus the OTLP export
  when configured), sharing the workflow trace id, and keep every exported value
  bounded, credential-redacted, and free of task text, artifact content, and
  answer text.
- Group the new `routing.*` family under one stable category node in the
  observability trace tree, so a pass and its decisions are visible while
  browsing a workflow trace.
- Telemetry stays observational: emitting, redacting, or bounding a routing
  payload can never fail a classification, change a routing selection, or alter
  a workflow transition.

## Capabilities

### New Capabilities

- `classifier-routing-telemetry`: observable, bounded, content-free telemetry
  for JEV/System One classifier routing passes — the per-pass decision record,
  the provider-call record, their identity/redaction/failure rules, and the
  trace-tree grouping of the resulting event family.

### Modified Capabilities

- `trace-tree-view`: the trace tree groups the new classifier-routing event
  family under one stable category node instead of leaving it under its raw
  family name, while still rendering one span per event with its attributes.

## Impact

- `agentic-coding/src/workflow/classifier-runner.ts` (the System One call:
  request/response instrumentation),
- `agentic-coding/src/workflow/classifiers.ts` (pure routing-decision summary
  shared by the reducer and the emitter),
- `agentic-coding/src/workflow/effect-runner.ts` (`model.classify` handler and
  the runner's bounded telemetry emit path),
- `agentic-coding/src/workflow/runtime/reducers/effect-result.ts` (the
  classifier routing reducer, which knows the applied selection and fallbacks),
- `agentic-coding/src/workflow/runtime/engine.ts` (post-commit emission of the
  per-pass decision event),
- `agentic-coding/src/tui/otel/model/traceStore.ts` (category mapping for the
  new family),
- `agentic-coding/docs/agent-session-telemetry.md` (event catalog),
- focused suites `agentic-coding/test/workflow-classifiers.test.ts`,
  `agentic-coding/test/workflow-telemetry-engine.test.ts`,
  `agentic-coding/test/workflow-effects.test.ts`, and the trace-store test.
