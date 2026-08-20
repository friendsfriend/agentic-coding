## Why

The `agent-runtime-routing` capability currently lets configuration declare `runtime_diversity` rules that force selected steps or roles (e.g. plan and worker/implementation) to resolve to different agent runtimes, hard-failing workflow start when they match. This removes user freedom to intentionally run plan and worker phases (or any other constrained routes) on the same agent harness. The user wants complete freedom to configure any combination of runtimes/profiles per step without an enforced diversity constraint.

## What Changes

- **BREAKING**: Remove the "Optional runtime diversity constraints" requirement from `agent-runtime-routing` — configuration SHALL NOT enforce that any steps/roles use different runtimes; diversity is no longer validated or reported.
- Remove the `runtime_diversity` config option from `AgentsConfig` (`src/workflow/profiles.ts`) so it is no longer parsed or enforced.
- Remove the diversity computation and its throw-on-violation check from `resolveRouting`.
- Drop the `diversity` field from `WorkflowRouting` (`src/workflow/contracts.ts`) and its snapshot parse/serialize logic, since it no longer carries meaningful state.
- Update existing tests that exercise `runtime_diversity` / `routing.diversity` to reflect the removed constraint.

## Capabilities

### New Capabilities
(none)

### Modified Capabilities
- `agent-runtime-routing`: Remove the "Optional runtime diversity constraints" requirement entirely; plan and worker (and all other steps/roles) may freely use the same or different agent runtime with no validation gate.

## Impact

- Affected code: `src/workflow/profiles.ts` (`AgentsConfig`, `resolveRouting`), `src/workflow/contracts.ts` (`WorkflowRouting`, `parseSnapshot`), `src/workflow/runtime.ts` (routing construction sites already emit `diversity: []`), `src/workflow/cli.ts` (routing resolution call site, unaffected in shape).
- Affected tests: `test/workflow-adapters.test.ts` (routing/diversity assertions).
- No new dependencies. Persisted workflow snapshots that still contain a `routing.diversity` array remain readable (extra field is simply no longer produced or required); no migration needed since the field becomes optional/absent going forward.
