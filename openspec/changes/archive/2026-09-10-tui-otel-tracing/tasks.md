## 1. TUI trace adapter

- [x] 1.1 Add a small TUI-owned tracing helper that reuses the existing bounded OTLP exporter and W3C identifier helpers to emit completed, receiver-compatible spans with stable names, timestamps, OK/ERROR status, and allowlisted scalar attributes.
- [x] 1.2 Make trace export observational and exclude dynamic status/error text, developer input, credentials, and artifact content from emitted attributes.
- [x] 1.3 Add focused tests that mock OTLP transport and verify valid span identity/shape, stable safe attributes, error status, and non-throwing export failure behavior.

## 2. Remove layout-affecting status output

- [x] 2.1 Inventory every `setMessage` and transient refresh/progress rendering path in `agentic-coding/src/tui/dash/App.tsx` and `agentic-coding/src/tui/dash/Home.tsx`; classify each as trace-only operational output, modal validation/error, durable health diagnostic, or a limited action-result toast.
- [x] 2.2 Remove the dashboard `message` signal and generic status/progress rows, including refresh indicators, and route each former operational outcome through the tracing helper without changing workflow action control flow.
- [x] 2.3 Retain only case-by-case notification overlays that concisely confirm a requested mutation or report an actionable failure; do not create toasts for progress, refresh, key, or debug events, and retain modal validation/errors plus durable workflow health diagnostics.
- [x] 2.4 Migrate overview workflow-start outcomes and all existing `AGENTIC_CODING_TRACE` sites in the dashboard, observability app, and TUI process startup/exception handlers to stable bounded OTLP trace events; remove debug-file append and heartbeat behavior.

## 3. Focused regression coverage

- [x] 3.1 Update dashboard and overview render tests to prove transient action/refresh text cannot add a primary-layout row while required modal, toast, and health feedback remains available in the reviewed cases.
- [x] 3.2 Add focused tests for traced dashboard/overview action success and failure plus TUI diagnostic tracing, asserting the trace outcome and that dynamic input/error text is absent.
- [x] 3.3 Run `cd agentic-coding && bun test test/dash/userActions.test.tsx test/dash/homeOverview.test.tsx test/otel/appCopySelection.test.tsx test/tui-tracing.test.ts`, `cd agentic-coding && bun run type-check`, and `cd agentic-coding && bun run lint`.