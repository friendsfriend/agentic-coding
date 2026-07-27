## Why

`architecture-checkup-round-1` cataloged three small, independent cleanups that share no coupling beyond being low-risk polish after consolidation:

- **R6** — The otel trace-view code is duplicated: `agent-dash/src/otel-tui.tsx`, `TraceBrowser`, `traces.ts`, and `receiver` exist both inside `agent-dash` and as the standalone `otel-tui/` project.
- **R7** — Agent-name mismatch: the Herdr agent name is truncated to 32 chars (`role_agent_name`) while pi's `--name` uses the untruncated `{change}-{role}`.
- **R8** — Legacy dead paths remain: `startWorkflowWizard` (bash `read` wizard superseded by the new-workflow modal) and `pi_command` (diagnostic-only Pi invocation builder).

Bundling them avoids three near-empty changes.

## What Changes

- Extract the shared otel trace-view code (`TraceBrowser`, `traces`, `receiver`) into one module consumed by both the dashboard's trace tab and the standalone `otel-tui` binary; remove the duplicate copy.
- Make the agent name consistent so the Herdr agent name and pi `--name` agree for a given `{change}-{role}` (single naming helper, one truncation rule).
- Remove `startWorkflowWizard` and `pi_command` and any now-unreferenced helpers.

## Capabilities

### Added Capabilities

- `workflow-tui-cleanups`: Deduplicated otel viewer, consistent agent naming, and removal of legacy dead paths.

## Impact

- Affected areas: shared otel-viewer module; engine agent-naming helper; `agent-dash` data layer (legacy path removal).
- Depends on: none strictly; cleanest after `consolidate-workflow-to-typescript` so the naming helper is fixed once in the TS engine.
- Non-goals: any behavioral change to trace viewing, agent launching, or workflow start beyond removing duplication and dead code.
