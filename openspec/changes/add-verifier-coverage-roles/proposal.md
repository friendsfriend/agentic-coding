## Why

Verification triage can only route six roles, and three defect classes are owned by none of them: concurrency/ordering/reentrancy defects, persisted-state and schema migration safety, and test quality (a green suite over behavior that is not actually asserted). This repository is a durable-state workflow engine with a live terminal UI, so all three classes are real risks that currently reach `pass` unreviewed. The cheapest correct fix is three more selectable verifier roles — no new step, contract, edge, or outcome.

## What Changes

- Add three triage-selectable verification roles to the verification role set: `concurrency-verifier`, `migration-verifier`, `test-quality-verifier`.
- Add one instruction asset per new role under `agent-definitions/instructions/`: `verification-concurrency.md`, `verification-migration.md`, `verification-test-quality.md`, each following the existing `<role minus "-verifier">` asset-name contract that `assignment.ts` already implements.
- Pin the three new assets on the `core.verification` step alongside the existing verifier assets, and extend the role set in `src/workflow/steps/verification.ts` so `VERIFIER_ROLES` and the derived `TRIAGE_ROLES` include them.
- Make the role set a single source of truth: export it from the verification step module and have the dashboard model-config editor consume it instead of keeping its own copy of the role names.
- Extend the triage instruction's role→remit table so triage can select the new roles and scope them to changed files.
- Keep `test-verifier` as the only engine-auto-launched verifier and the sole owner of the complete repository test suite. `test-quality-verifier` reviews test adequacy for the changed scope only and never runs the full suite.
- Regenerate `src/workflow/embedded.generated.ts` from `agent-definitions` (never hand-edited) so the new assets and the updated triage instruction are pinned with a new definition version.
- Document how to add a verifier role in `agentic-coding/docs/workflow-architecture.md` so the next role addition has a checklist.

## Capabilities

### New Capabilities

- `workflow-verifier-role-coverage`: the registered verifier role catalog for `core.verification` — which roles triage may select, what each role's remit covers, how each role resolves its instruction asset, and the invariants that keep the role set single-sourced and keep complete-suite ownership with `test-verifier`.

### Modified Capabilities

- `agent-configuration-presets`: the preset editor's verification-role list becomes catalog-driven — it must offer every verification role the engine registers, rather than a dashboard-local copy of the role names.

## Impact

- Agent definitions: `agent-definitions/instructions/triage.md` plus three new `verification-*.md` assets; `AGENT_DEFINITION_VERSION` changes on regeneration.
- Engine and definitions: `src/workflow/steps/verification.ts` (role set, exported catalog), `src/workflow/definitions/steps.ts` (`core.verification` instruction asset list), `src/workflow/embedded.generated.ts` (generated).
- Dashboard: `src/tui/dash/ui/ModelConfigModal.tsx` (consume the catalog), `src/tui/dash/demo.ts` fixtures if role-driven demo coverage is extended.
- Tests: step/registry role and instruction-digest coverage, dashboard model-config role coverage.
- Runtime behavior: triage may select up to three additional roles per round, so a single verification round can fan out more concurrent agent panes in the shared `verification` tab. `max_verification_rounds`, the fix loop, finding severities, panes-per-role grouping, and the verdict rule (critical blocks) are unchanged. Verifier result popups and cost/metrics projections already key off the `-verifier` role suffix and need no change.
- No dependency, contract schema, workflow graph, or CLI surface change; no migration of existing workflow state.
