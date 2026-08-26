## Why

Verifier findings are already available to the dashboard and can be opened in a popup, but the Agents panel does not expose a quick severity summary. Users must open each verifier result to understand whether critical, warning, or informational findings exist. Showing those counts inline makes the verification state visible while preserving the existing panel workflow.

## What Changes

- Derive per-verifier finding counts from the committed verifier findings for the current verification round.
- Render critical, warning, and info counts in verifier rows in the Agents panel.
- Use semantic severity colors: critical in red/error, warning in yellow/warning, and info in blue/info.
- Preserve the existing agent identity, status, verdict, metric-line, panel bounds, and verifier-result popup behavior.
- Extend dashboard fixtures and focused UI tests to cover non-zero counts, zero counts, severity colors, and the no-findings/unavailable state.

## Capabilities

### New Capabilities

- `dashboard-agent-findings`: Display current-round verifier finding counts by severity directly in the Agents panel.

### Modified Capabilities

<!-- No existing capability requirements change; verifier result access and agent metrics remain unchanged. -->

## Impact

- Dashboard data model and loading in `agentic-coding/src/tui/dash/data.ts`.
- Agents-panel rendering and severity color selection in `agentic-coding/src/tui/dash/App.tsx`.
- Dashboard test fixtures and focused rendering tests under `agentic-coding/test/dash/`.
- No workflow engine, verifier contract, persisted-state, or external API changes.
