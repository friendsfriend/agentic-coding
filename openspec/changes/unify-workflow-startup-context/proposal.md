## Why

CLI and dashboard duplicate workflow validation, routing, preflight, and Git setup. Configuration overlays use process working directory rather than the selected repository, so launching another project can select the wrong configuration; delivery effects also reload mutable ambient settings.

## What Changes

- Introduce one application-level startup function shared by CLI and dashboard.
- Resolve configuration and its provenance from the selected canonical repository or an explicit repository-independent target context, not ambient cwd.
- Normalize preset and explicit fusion-profile selection through one precedence rule.
- Pin non-secret execution settings needed after startup, including delivery remote and PR tool selection.
- Preserve final transactional guards and fail-closed model/capability preflight.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `workflow-engine-runtime`: Shared startup orchestration for all entry points.
- `agent-runtime-routing`: Repository-scoped configuration and durable execution settings.

## Impact

- Priority: high; architecture finding 2. No prerequisite changes.
- Code: `agentic-coding/src/workflow/cli/commands/start.ts`, `src/tui/dash/engine.ts`, `src/workflow/effects.ts`, `profiles.ts`, `cli/drain.ts`, contracts, and effect handlers.
- CLI flags and dashboard controls remain entry-point concerns. CLI fusion starts gain preset-derived planner selection when no explicit profile list is supplied.
- Existing workflows without execution settings require an explicit, revision-bound settings adoption before configuration-sensitive effects run; no silent reread of current defaults.
- Coordinate the new persisted fields with `version-workflow-behavior-pins`; they are separate pin dimensions.

## Non-goals

No dependency-injection container, configuration framework, new runtime, credential persistence, or global process.chdir workaround.
