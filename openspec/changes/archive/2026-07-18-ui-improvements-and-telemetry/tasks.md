## 1. Correlated telemetry

- [x] 1.1 Add bounded trace/span ID, W3C `traceparent`, OTLP JSON, local span JSONL, and best-effort exporter helpers to Pi telemetry extension.
- [x] 1.2 Instrument user-message agent operations, model turns, provider outcomes, usage, and tool executions without default content capture.
- [x] 1.3 Propagate active tool context into Bash and consume fresh one-use controller handoff context in managed role agents.
- [x] 1.4 Instrument `herdr-workflow` command actions and role prompts, preserve legacy telemetry events, and write atomic expiring trace-context handoffs.

## 2. Shared trace browser

- [x] 2.1 Add shared normalized span model and decoders for workflow trace JSONL and OTLP/HTTP JSON envelopes, including hierarchy, filtering, and bounded retention.
- [x] 2.2 Build reusable OpenTUI trace list, span tree, detail, filtering, and live-update components.
- [x] 2.3 Replace dashboard flat trace detail with shared workflow-filtered trace browser and retain empty/error-safe dashboard behavior.

## 3. Standalone viewer

- [x] 3.1 Add `otel-tui` entrypoint with loopback OTLP JSON receiver, request validation/limits, live rendering, and optional JSONL import/follow.
- [x] 3.2 Update multi-target build and current-platform installer to package `otel-tui` beside `agent-dash`.
- [x] 3.3 Document endpoint configuration, `http/json` requirement, CLI options, content policy, network exposure warning, and dashboard usage.

## 4. Validation

- [x] 4.1 Add focused workflow checks for traceparent parsing, one-use handoff expiry, nested verification propagation, local fallback, and telemetry failure isolation.
- [x] 4.2 Add Bun tests for OTLP decoding, malformed input, span hierarchy/filtering, retention, and receiver responses.
- [x] 4.3 Run workflow regression script, `agent-dash` tests/type-check/current-platform build, and strict OpenSpec validation.
