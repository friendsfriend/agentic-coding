## Context

`agentic-coding/src/tui/dash/App.tsx` renders its `message` signal above the dashboard panels. Action progress, command results, and handler failures therefore add a variable-height row and reflow the terminal whenever the text changes. `Home.tsx`, the dashboard, the observability view, and `index.tsx` also contain an `AGENTIC_CODING_TRACE` debug path that appends key, lifecycle, and exception diagnostics to a local file.

The repository already has a bounded OTLP HTTP span exporter (`TraceExporter`) and W3C trace identity helpers in the workflow observability seam. The TUI's embedded receiver already accepts the emitted OTLP span shape. The developer confirmed that only transient inline status/progress text and debug diagnostics move to traces; modal validation/errors remain interactive feedback. A toast is permitted only after reviewing an individual action when it gives the user a concise actionable confirmation or failure, not as a replacement for progress, refresh, key, or debug output.

## Goals / Non-Goals

**Goals:**
- Keep dashboard panel geometry stable while transient actions run or fail.
- Export structured, bounded TUI operational traces for action outcomes and diagnostics through the existing OTLP configuration and timeout behavior.
- Cover every existing TUI `AGENTIC_CODING_TRACE` diagnostic site and the action/refresh paths that currently publish the inline dashboard message.
- Retain workflow health diagnostics, modal errors, and notification overlays when they require user attention.

**Non-Goals:**
- Do not alter workflow-engine telemetry, the OTLP receiver/storage UI, workflow lifecycle, or trace sampling/configuration.
- Do not add a logging dependency, a persistent local debug-log format, or a new user-visible trace panel.
- Do not place user-entered text, credentials, artifact content, or unbounded raw error text into trace attributes.

## Decisions

### Use a small TUI tracing adapter over the existing OTLP span exporter

Add a TUI-owned helper that creates a short completed span with a generated W3C trace identity, a stable event name, timestamps/duration, an OK or ERROR status, and allowlisted scalar attributes. It delegates transport to the existing bounded `TraceExporter`, so it honors `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`/`OTEL_EXPORTER_OTLP_ENDPOINT`, the default local OTLP endpoint, and the 750 ms best-effort timeout.

This reuses the repository's exporter and receiver-compatible wire format rather than adding an SDK or a second JSONL/debug-file protocol. Logging to stderr or retaining `AGENTIC_CODING_TRACE` was rejected because it does not make the information queryable as OTLP traces and maintains two diagnostics paths.

### Replace the generic dashboard message channel rather than hiding it

Remove the `message` signal and its rendering from the dashboard. Review and classify every current call site as: an operational event (emit a stable trace event and outcome with no UI message), an interactive validation/error (retain feedback through its modal), a concise user-action outcome (use the existing notification overlay only when it confirms a requested mutation or presents an actionable failure), or a durable workflow health diagnostic (continue rendering from workflow state). Progress, refresh, key, and debug events MUST NOT become toasts. This prevents future call sites from silently reintroducing a layout-affecting text row or a noisy toast stream.

Simply constraining, truncating, or reserving height for the line was rejected because it leaves operational state in the TUI and still consumes space; converting the line into a scrolling log was rejected because it is a new UI surface contrary to the requested removal.

### Trace operation identity and outcome, not arbitrary message contents

Trace names and attributes identify the UI surface, operation category, outcome, and safe metadata such as key/action identifier, without serializing dynamic status strings, custom answers, or exception bodies. The helper must make telemetry failures observational so UI actions and exception handling preserve their original control flow.

Capturing full message text was rejected because action failures and validation data can contain repository paths, command output, or developer input. Creating a span for every render was rejected as noisy and unrelated to a user action or diagnostic; tracing remains limited to former debug points and operational transitions.

## Risks / Trade-offs

- [Best-effort export can be unavailable] → The helper never blocks or changes the result of a UI action; local receiver/default endpoint and existing OTLP environment configuration remain the delivery options.
- [Tracing key diagnostics can generate high volume] → Emit only at the existing debug-handler boundaries, use stable names and minimal attributes, and do not add render-loop instrumentation.
- [Removing inline errors can hide actionable failures] → Review every former message category, preserve modal validation/errors and durable workflow health diagnostics, and use a toast only for a concise action result that needs immediate attention.
- [TUI-to-workflow reuse could violate layer checks] → Keep presentation orchestration in a TUI-owned adapter and reuse only the established export seam; run the source-layer boundary test.

## Migration Plan

1. Introduce and unit-test the TUI tracing adapter against the OTLP span record shape.
2. Migrate the dashboard, overview, observability-view, and process diagnostic call sites; remove `AGENTIC_CODING_TRACE` file writes and the dashboard inline message channel.
3. Add rendering and tracing regression coverage, then validate focused TUI/telemetry tests plus lint and type checking.
4. Roll back by reverting the change; it adds no persisted schema or migration and telemetry export remains best effort.

## Open Questions

None. The developer selected removal of transient inline status/progress messages and debug diagnostics, retention of modal validation/errors, and case-by-case limited use of existing notification overlays.
