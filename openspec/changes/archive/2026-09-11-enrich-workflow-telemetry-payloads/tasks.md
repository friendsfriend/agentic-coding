# Tasks: Enrich Workflow Telemetry Payloads

## 1. Telemetry contract

- [x] 1.1 Extend `workflow/observability.ts` with the optional payload fields the enriched envelopes use (`attempt`, `tool`, `model`, `provider`, `sessionId`, `tokens`, `cost`, numeric attributes) and keep `schemaVersion: 1` for the wire shape.
- [x] 1.2 Add a bounded payload helper that drops `content`-keyed fields unless content capture is enabled, truncates long strings, and keeps numbers and booleans as scalars.
- [x] 1.3 Add an adapter-layer emit entry point (layer `adapter`, runtime from the run profile) that uses the same bounded sink and never throws.
- [x] 1.4 Extend `agentic-coding/test/workflow-observability.test.ts` to cover the payload helper (type preservation, content filter, truncation) and adapter-layer emission.

## 2. Engine payloads

- [x] 2.1 Change `commitStart` and `commitDispatch` to return the committed event, the pre- and post-command status, and the resolved run or effect row alongside the snapshot, without a second store read.
- [x] 2.2 Change `telemetryEffect` to accept that payload and emit identity (role, run id, attempt, profile, runtime, session id, effect id, effect kind) plus workflow id, step id, revision, and status.
- [x] 2.3 Emit `outcome` and `durationMs` as envelope fields for events that have them: handoff outcome and run wall clock, effect outcome and effect duration, question answer and wait duration.
- [x] 2.4 Add the per-event payload fields for `agent.handoff` (attempt, artifact digest, artifact bytes, findings counts by severity, evidence count).
- [x] 2.5 Add the per-event payload fields for `effect.result` (effect kind, attempt, max attempts, bounded error class instead of raw error text).
- [x] 2.6 Add the per-event payload fields for the question events (`agent.question.*`, `developer.question.*`: question or group id, asking role, answering side, answer kind, option count, wait duration, timeout flag).
- [x] 2.7 Add the per-event payload fields for `developer.action` (normalized action id without variable identifiers, step before and after, revision) and for the operator events (`step from/to`, reason length, version from/to, digest from/to).
- [x] 2.8 Add the per-event payload fields for `workflow.started` (definition id/version, change id, repository basename, repository-independent flag, task length, branch, base commit) and `research.handoff.recorded` (directive count, citation count).
- [x] 2.9 Export the effect-exhaustion event written by the lease sweep, including effect kind, attempt count, error class, and attention count.
- [x] 2.10 Export the legacy-migration event from `runtime/migration.ts` with source version, phase, and workflow type.
- [x] 2.11 Export one best-effort roll-up event on the transition into `completed`, `closed`, or `attention-required`, carrying verification rounds, revision count, run count, distinct agent count, developer-question count, attention count, and current step, emitted once per transition and also from the question-expiry sweep when that sweep terminates the workflow.
- [x] 2.12 Extend the engine observability tests to assert identity, payload fields, and the two new event exports from a real dispatch flow.

## 3. Adapter baseline events

- [x] 3.1 Add an optional `telemetry` emit function to `AdapterEffectOptions`, defaulting to the bounded sink, wired in `workflow/operations.ts`.
- [x] 3.2 Emit a launch-attempt event and a launch-outcome event (outcome, duration, bounded error class) around `agent.launch` in `effect-runner.ts`.
- [x] 3.3 Emit an assignment-delivered event for `agent.prompt`, including reused-prompt continuation, with run identity, attempt, and delivery duration.
- [x] 3.4 Emit stop and error events around `agent.stop` and the launch/prompt/stop failure paths, carrying outcome, duration, and error class, without altering the failure returned to the workflow.
- [x] 3.5 Test the adapter-layer events through the effect-runner test surface, asserting they are emitted for launch, delivery, stop, and failure.

## 4. pi bridge payloads

- [x] 4.1 Add session identity and model metadata to every pi event: session id from the session manager, runtime id, model id, provider id, thinking level, turn index.
- [x] 4.2 Add tool start bookkeeping keyed by tool call id and report tool name, call id, outcome, exact duration, argument size, result size, and bounded error class.
- [x] 4.3 Add the provider-response hook emitting status, request latency, and a bounded error class with outcome `error` for non-success statuses.
- [x] 4.4 Add the turn hook emitting turn index, turn duration, tool call count, and tool error count.
- [x] 4.5 Add the model-selection hook emitting new model, previous model, and selection source.
- [x] 4.6 Add the compaction hook emitting tokens before and after, compaction duration, and the automatic flag, and add context usage to the settle event.
- [x] 4.7 Add cumulative session totals to the settle event: turns, tool calls, tool errors, input/output/cache-read/cache-write tokens, and cost.
- [x] 4.8 Keep `tool_execution_update` and `message_update` unwired so streaming updates never produce telemetry rows.
- [x] 4.9 Extend `agentic-coding/test/pi-telemetry-bridge.test.ts` to cover duration bookkeeping with out-of-order completions, provider status classification, compaction, and settle totals.

## 5. opencode bridge payloads

- [x] 5.1 Branch the `event` hook on `event.type` and on `part.type` for message-part updates in both `opencode-telemetry.js` and `opencode-v2-telemetry.js`.
- [x] 5.2 Emit the `step-finish` payload: cost, input/output/reasoning tokens, cache read and write tokens, finish reason, and step duration.
- [x] 5.3 Emit the `tool` part payload: tool name, call id, status, duration from state timestamps, input and output sizes, and bounded error class.
- [x] 5.4 Emit retry and compaction part payloads (attempt, flag) and report text and reasoning parts by character length only.
- [x] 5.5 Emit the session status payload (status, retry attempt, retry delay, bounded retry reason) and the session error payload (bounded error class, retryable flag).
- [x] 5.6 Emit the permission request and reply payloads with permission type, pattern count, reply outcome, and elapsed time.
- [x] 5.7 Emit the todo and diff payloads with todo counts per status and changed files, additions, and deletions.
- [x] 5.8 Add model id and provider id to message events, derived from the enclosing assistant message when available.
- [x] 5.9 Drop pty, tui, server, installation, lsp-updated, and file-watcher events at the bridge, and verify the two bridge variants stay at parity.
- [x] 5.10 Add a bridge test covering part discrimination, the dropped families, and both bridge variants.

## 6. Regenerate agent assets

- [x] 6.1 Run `bun run build` from `agentic-coding/` to regenerate `src/workflow/embedded.generated.ts` from the edited bridge sources, and confirm the generated diff contains only the bridge changes.
- [x] 6.2 Extend `agentic-coding/test/workflow-assets.test.ts` so the embedded bridge payload assertions match the new event set and the dropped families stay absent.

## 7. TUI support for every event

- [x] 7.1 Map every non-reserved top-level scalar envelope key to a span attribute, keeping the existing reserved keys and their `herdr.*` attribute names, and keep merging the named `attributes` object on top.
- [x] 7.2 Preserve scalar types for top-level payload values so token, cost, count, attempt, and duration attributes reach the viewer as numbers.
- [x] 7.3 Normalize the OTLP attribute decoder to accept numeric strings for int and double values and to keep int, double, bool, and string distinct.
- [x] 7.4 Render numeric attributes as numbers and boolean attributes as booleans in the span detail view, keeping the sorted key-value layout.
- [x] 7.5 Match the trace filter against attribute keys as well as values, the event name, the workflow id, the role, and the runtime id.
- [x] 7.6 Keep grouping by workflow and make the engine/runtime correlation for one run visible through the run and session attributes.
- [x] 7.7 Keep unknown event names rendering as raw names with their attributes and durations, and keep layer-less legacy records loading with a resolvable service name.
- [x] 7.8 Extend `agentic-coding/test/otel/telemetryIngest.test.ts` with mixed old/new payload rows, including top-level token fields, numeric attributes, an unknown event name, and a layer-less legacy record.

## 8. Verification

- [x] 8.1 Run `bun run lint` and `bun run type-check` from `agentic-coding/` and fix every diagnostic without adding suppressions.
- [x] 8.2 Run the workflow, otel, and dash test suites and confirm the telemetry, asset, parser, and dashboard projection tests pass.
- [x] 8.3 Inspect the TUI against a real workflow directory: open the trace viewer, confirm every event name and numeric attribute of that workflow renders, and confirm the `?` help and footer keybinds are unchanged by this change.
- [x] 8.4 Record the emitted event/attribute catalog in the change notes and confirm the emitted set matches the specs, including the two newly exported events and the dropped noise families.
