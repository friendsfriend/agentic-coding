## Why

Managed pi sessions inherit `codemode` and `tool_search` from the user's global pi settings. Durable runs from `add-pi-durable-runtime` do not, so agents lose batched tool orchestration that workflow instructions rely on.

## What Changes

- Offer a durable `codemode` tool built on `@earendil-works/pi-codemode` (pinned) that can call the run's other offered tools, when the user's global pi settings enable it.
- Offer `tool_search` equivalently when enabled.
- Keep the read-only guarantee: codemode SHALL only reach tools the run is offered.

## Capabilities

### New Capabilities
- `durable-agent-codemode`: codemode/tool_search availability and tool reach in durable runs.

### Modified Capabilities

## Impact

`src/agent-host/tools`, dependency on `@earendil-works/pi-codemode`, bundling (QuickJS/WASM assets must embed in the compiled executable). Depends on `add-pi-durable-runtime`.
