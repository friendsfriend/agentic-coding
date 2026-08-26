## Why

The Agents panel currently shows each agent's selected model but omits the runtime that executes it. When profiles use Pi, stable OpenCode, or OpenCode V2, model names alone do not identify the active execution environment, making it harder to understand routing and compare agent rows. The dashboard should expose this already-pinned runtime metadata without adding another row.

## What Changes

- Carry each agent run's runtime into the dashboard agent projection.
- Render the runtime and selected model together on the existing agent model line.
- Display the supported runtime labels as `pi`, `opencode`, and `opencode2` (mapping the internal OpenCode V2 identifier to its executable-facing label).
- Preserve existing fallback text for agents without a selected run/model and keep the row bounded within the Agents panel.
- Add focused projection and rendering coverage for runtime/model display.

## Capabilities

### New Capabilities

- `dashboard-agent-runtime`: Displays the executing agent runtime alongside the selected model in each Agents panel row.

### Modified Capabilities

- None.

## Impact

- Dashboard data projection and agent-row rendering in `agentic-coding/src/tui/dash`.
- Dashboard tests covering projected agent metadata and the Agents panel.
- No workflow routing, runtime adapter, or external API behavior changes; the feature consumes runtime metadata already present on workflow runs.
