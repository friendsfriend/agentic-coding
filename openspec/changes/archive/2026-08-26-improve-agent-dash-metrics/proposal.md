## Why

The agent detail panel currently reports cache-hit percentages from incompatible token totals, producing impossible values such as `729067% cached`. It also shows the same agent cost in both the verification status line and the metrics line. In addition, the recently added Git status belongs in the agent-dash detail view, not the main workflow workspace overview, where it adds unrelated UI and behavior.

## What Changes

- Correct cache-hit-rate derivation and rendering so percentages use a valid bounded denominator and never display impossible values.
- Keep cache-hit metrics unavailable when the required token totals are missing or invalid rather than presenting misleading values.
- Remove the duplicate cost suffix from the verification status line; cost remains in the Agents metrics line and cost breakdown.
- Move the Git status panel and its refresh/interaction behavior from the main workflow Home overview to the agent-dash TUI detail view.
- Update dashboard fixtures and tests to cover valid cache rates, invalid/missing cache inputs, single cost display, and Git status placement.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `dashboard-agent-metrics`: Define a correct, bounded cache-hit percentage and require cost to be displayed only in the compact metrics line rather than beside verification status.
- `workspace-overview-git-status`: Remove Git status from the main workflow workspace overview; retain the Git status capability in the agent-dash detail view, including changed-file interaction and refresh behavior.

## Impact

- Affected TUI code: `agentic-coding/src/tui/dash/App.tsx`, `agentic-coding/src/tui/dash/data.ts`, and `agentic-coding/src/tui/dash/Home.tsx`.
- Affected dashboard and overview tests/fixtures under `agentic-coding/test/dash/`.
- No workflow state, telemetry schema, persistence, or external API changes are intended; the change is limited to telemetry interpretation and TUI placement/rendering.
