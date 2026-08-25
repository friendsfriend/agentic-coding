## 1. Dashboard workflow selection

- [x] 1.1 Add `plan-fusion` to `NewWorkflowModal` workflow choices and display labels while preserving standard, direct-apply, and quick mappings.
- [x] 1.2 Add dashboard-modal coverage proving Plan Fusion submits `workflowType: "plan-fusion"` and remains selectable alongside existing workflow types.

## 2. Dashboard plan-fusion routing

- [x] 2.1 Reuse or extract the shared built-in role derivation so the dashboard start path can create `planner-1` through `planner-N` and `consolidator` routes for `plan-fusion`.
- [x] 2.2 Update the in-process dashboard start bridge to derive the planner count from the selected preset's `fusion.plan` role assignments and resolve `fusion.consolidate` through the existing preset precedence chain.
- [x] 2.3 Validate the dashboard plan-fusion routing before workspace or agent effects: require 2–5 contiguous planner roles, distinct resolved planner profiles, and resolvable required routes; retain existing behavior for other workflow definitions.
- [x] 2.4 Add routing/start tests for valid 2-planner and 5-planner presets, invalid planner counts/duplicates, consolidator resolution, and unchanged non-fusion routing.

## 3. Preset editor support

- [x] 3.1 Extend the model configuration preset editor with optional `fusion.plan` planner-1 through planner-5 role fields and a `fusion.consolidate` step field.
- [x] 3.2 Update preset draft loading and saving to persist fusion assignments under the existing `roles.fusion.plan` and `steps.fusion.consolidate` tables without dropping unrelated role tables or storing `(unset)`.
- [x] 3.3 Add model-configuration modal tests covering the new fusion fields, persisted assignments, and round-trip preservation of existing preset entries.

## 4. Validation

- [x] 4.1 Run the focused dashboard and workflow test suites and fix regressions.
- [x] 4.2 Run `bun run lint` and `bun run type-check` from `agentic-coding/`.
