## Why

After `slim-agent-prompts`, the largest block every workflow request carries is the tool definitions: ~26 KB of descriptions (plus parameter schemas) for all tools, installed for every run whatever its step. A planner or wiki run receives every `stage_*`, `browser_*`, `otel_query`, `db_query` and `debug_*` definition; a stage tester receives `env_*` and debug tools it must not use. Several descriptions also carry long reference text (`otel_query`, `stage_login`, `browser_run_script`, `browser_open`) that only a few roles need.

## What Changes

- Each workflow step declares the tool groups its roles may use (dialogue, judgment, search, environment, evidence, browser, stage, debug tools, debug requests); the durable host installs only those groups for that run. Coding tools and the handoff path are unchanged.
- The longest tool descriptions are trimmed to their contract; reference detail moves into error results or the tool's own answers where it is needed.
- This is a capability change (a run can no longer call a tool its step does not declare), so it is reviewed separately from the prompt-text change.

## Capabilities

### New Capabilities

### Modified Capabilities
- `durable-agent-tools`: tool installation follows the step's declared tool groups.

## Impact

- `agentic-coding/src/agent-host/host.ts` (`installWorkflowExtensions`, `toolSelectionFor`), `src/workflow/steps/*` (declared tool groups), tool description sources under `src/agent-host/` and `src/server/`.
- Tests: `test/agent-host-tool-surface.test.ts`, `test/agent-host-codemode.test.ts`, environment/browser/stage/debug tool tests; the prompt budget table from `slim-agent-prompts` gains system-side budgets.
- Depends on `slim-agent-prompts` (inventory and budgets) landing first.
