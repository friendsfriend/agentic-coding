## Why

The dashboard renders transient action and progress text in its content column, so messages of varying length change the terminal layout and make the workflow view jump. Those operational details are better captured as OpenTelemetry telemetry, while UI validation and error dialogs remain available when users need to act.

## What Changes

- Remove the dashboard's variable-height inline transient status message from the rendered layout.
- Emit trace records for dashboard and overview actions, including successful and failed operations, without putting diagnostic content into the layout.
- Replace the TUI's file-only debug trace path with the same bounded OpenTelemetry tracing path.
- Preserve interactive modal validation/errors and existing overlay notifications.

## Capabilities

### New Capabilities
- `tui-operational-tracing`: TUI action and diagnostic outcomes are emitted as bounded OpenTelemetry traces without layout-affecting status text.

### Modified Capabilities
- None.

## Impact

- Affected code: dashboard and overview TUI action handlers, TUI process diagnostics, and the existing telemetry export seam.
- Affected systems: the OTLP trace endpoint and local workflow telemetry evidence.
- No new dependency or user-facing API is required.
