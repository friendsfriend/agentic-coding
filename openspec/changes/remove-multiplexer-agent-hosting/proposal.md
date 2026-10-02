## Why

The developer's target architecture removes multiplexer support for agents and shows agent feedback in the dashboard's OpenTUI agent session view. After `add-pi-durable-runtime`, OpenCode runs remain the only managed agents that need Herdr panes.

## What Changes

- Host remaining managed agent runtimes without multiplexer panes (headless processes supervised like the durable host), or retire runtimes that cannot be driven headlessly.
- Make the dashboard agent session view the only agent visibility surface; Agents-panel Enter always opens it.
- **BREAKING:** remove agent pane creation, `herdr agent start/prompt` lifecycle use, pane-based agent status, and agent tab status syncing; keep multiplexer use only where a non-agent feature still needs it, or remove it entirely.

## Capabilities

### New Capabilities
- `pane-free-agent-hosting`: every managed agent run is hosted, prompted, observed and stopped without a multiplexer pane.

### Modified Capabilities

## Impact

`src/multiplexer/`, `src/workflow/effect-runner.ts`, `adapters.ts`, tab/sidebar sync, dashboard Agents panel, OpenCode adapters, README install requirements. Depends on `add-pi-durable-runtime`.
