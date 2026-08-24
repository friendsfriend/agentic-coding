## Why

Agent/model configuration today is a flat set of hand-edited TOML profiles plus step routes. Users who want to switch between different combinations of agent/model assignments across workflow steps (e.g. "frontier planning + cheap workers" vs "all frontier") must manually rewrite routes in `config.toml`. Additionally, a mistyped model name is only discovered when an agent fails mid-run, with no validation at workflow start.

## What Changes

- Introduce **agent configuration presets**: named bundles that assign an agent profile to every workflow step (including per-role overrides for verification), selectable as a unit.
- Presets and the agent profiles they reference are persisted in the existing agents config (`agents` section of `config.toml` / project-level `.pi/herdr-workflow.toml`), so they remain committable to a repository.
- The **new workflow modal** gains an agent-preset selection step; the selected preset drives routing for the started workflow without permanently rewriting global defaults.
- The **home dashboard** gains model-configuration management: create, edit, and delete agent profiles (execution environment `pi`/`opencode`/`opencode-v2`, model chosen from the models available for that runtime, optional agent name) and create, edit, and delete presets (define agents for all workflow steps).
- **Invalid model detection**: when a workflow starts, every routed profile whose model is not among the models available for its execution environment fails preflight with a clear error naming profile, runtime, and invalid model — instead of failing later inside the spawned agent.

## Capabilities

### New Capabilities
- `agent-configuration-presets`: Named preset bundles that map all workflow steps (and verification roles) to agent profiles, stored in committable config, manageable via the home dashboard, and selectable per-workflow via the new workflow modal.

### Modified Capabilities
- `agent-runtime-routing`: Adds requirement that configured models are validated against the models available for the profile's execution environment during start-time routing preflight, failing fast with an actionable error.

## Impact

- `agentic-coding/src/workflow/profiles.ts`: preset schema, parsing/validation, preset-based routing resolution, model availability check hook.
- `agentic-coding/src/workflow/effects.ts` / `engine.ts` (dash): config load/save round-trip preserving unknown fields; preset-aware routing at workflow start; per-workflow preset override.
- `agentic-coding/src/tui/dash/ui/NewWorkflowModal.tsx`: new preset selection step.
- `agentic-coding/src/tui/dash/Home.tsx` + new modal component(s): profile/preset CRUD UI, model list per execution environment.
- Config format: additive `[agents.presets]` section and per-profile model availability metadata; existing profiles/routes keep working (backwards compatible).
- No changes to workflow engine lifecycle, adapters' launch behavior, or run-time pinning semantics beyond earlier failure on invalid models.
