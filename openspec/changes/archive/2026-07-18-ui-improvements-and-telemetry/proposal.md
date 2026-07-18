## Why

Current Herdr telemetry is a flat workflow-local event log. It shows that agents ran, but cannot reconstruct which user message caused each model/tool action or follow a verification round across controller, triage, verifier, fix, and retry processes in OpenTelemetry tooling.

## What Changes

- Emit correlated OpenTelemetry-compatible traces for workflow commands and Pi agent messages, model turns, and tool executions.
- Propagate W3C trace context through `herdr-workflow` handoffs so triage, parallel verifiers, test verification, and worker fixes remain connected.
- Keep workflow-local telemetry as best-effort fallback while exporting OTLP/HTTP JSON to configurable collectors and UIs.
- Add standalone `otel-tui` executable that receives and browses local OTLP traces from Herdr or other applications.
- Reuse trace browser inside `agent-dash` for workflow-filtered trace inspection.
- Bound captured data and omit prompt, tool argument, and tool result content unless explicitly enabled.

## Capabilities

### New Capabilities

- `herdr-agent-telemetry`: Correlated, privacy-aware OpenTelemetry tracing for workflow and agent actions.
- `local-otel-trace-viewer`: Standalone OTLP trace receiver/browser plus workflow dashboard integration.

### Modified Capabilities

None.

## Impact

- `pi/extensions/herdr-telemetry.ts`: message/action spans, trace propagation, OTLP export, local fallback.
- `pi/bin/herdr-workflow`: workflow spans and trace-context handoff between controller and role agents.
- `agent-dash/src/`: shared OTLP decoding, trace models/browser, dashboard integration, and standalone viewer entrypoint.
- `agent-dash/scripts/`, install scripts, and docs: build/install both `agent-dash` and `otel-tui`.
- No collector service or new runtime dependency is required; implementation uses Python/Bun standard APIs and existing OpenTUI packages.
