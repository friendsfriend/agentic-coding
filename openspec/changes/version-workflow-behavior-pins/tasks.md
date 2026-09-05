## 1. Capture compatibility baseline

- [ ] 1.1 Preserve every currently supported definition/step digest fixture and record the baseline behavior represented by legacy compatibility mappings.
- [ ] 1.2 Inventory every registry.step call across registry compilation, runtime, routing, adapters/assignments, CLI/application, TUI, and repair/repin.
- [ ] 1.3 Add a fixture with two versions of the same step ID whose completion behavior differs despite equivalent graph structure.

## 2. Resolve explicit semantic identities

- [ ] 2.1 Define exact step references and explicit behavior compatibility identity for new manifest versions without adding fields to historical digest inputs.
- [ ] 2.2 Implement one definition-aware step resolver with explicit supported legacy mappings and fail-closed missing-version diagnostics.
- [ ] 2.3 Migrate all workflow-dependent step lookups to the resolver and register old/new implementations side by side in tests.
- [ ] 2.4 Persist and validate the new semantic pin format on startup, dispatch, run creation, assignment rendering, and effect execution.

## 3. Enforce upgrade compatibility

- [ ] 3.1 Validate semantic compatibility in operator migration/repair/repin so digest-only replacement cannot bypass changed behavior contracts.
- [ ] 3.2 Implement migration preview and atomic old/new pin audit with expiration of incompatible runs/effects; test rollback and stale revisions.
- [ ] 3.3 Test legacy workflows continuing on supported mappings, new workflows choosing exact versions, unavailable implementations blocking, and presentation-only instruction edits leaving semantic pins unchanged.
- [ ] 3.4 Verify equivalent function relocation preserves pins and incompatible guard/aggregation changes require a new identity or explicit migration.

## 4. Validate and document

- [ ] 4.1 Run affected workflow-registry, workflow-steps, workflow-runtime, workflow-assets, workflow-adapters, workflow-effects, workflow-plan-fusion, workflow-migration, and workflow-e2e tests.
- [ ] 4.2 Document semantic version rules, supported legacy mappings, retention policy, migration/rollback limits, and the distinction from instruction and execution-setting pins.
- [ ] 4.3 From agentic-coding/, run bun run type-check, bun run lint with zero diagnostics, and bun run build.
- [ ] 4.4 Run openspec validate version-workflow-behavior-pins --strict and confirm historical digests were not rewritten to make tests pass.
