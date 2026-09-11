## 1. Verifier instruction assets

- [ ] 1.1 Add `agent-definitions/instructions/verification-concurrency.md` covering shared mutable state, races and ordering assumptions, duplicate or late run completion, outbox retry ordering and idempotency, and reentrancy between engine transactions and boundary adapters; keep the brevity and "concrete evidence only" wording of `verification-security.md`
- [ ] 1.2 Add `agent-definitions/instructions/verification-migration.md` covering persisted-format and version compatibility, upgrade path for state written by an earlier schema or definition, atomicity and partial-write windows, and rollback after a failed transition
- [ ] 1.3 Add `agent-definitions/instructions/verification-test-quality.md` covering whether changed behavior is asserted at all, whether assertions fail when the logic breaks, and tests that merely restate the implementation; state explicitly that the role uses focused checks only and never runs the complete suite
- [ ] 1.4 Extend the role table in `agent-definitions/instructions/triage.md` with `concurrency-verifier`, `migration-verifier`, and `test-quality-verifier` rows, keeping the current `test-verifier` row wording that the full suite is engine-launched

## 2. Engine registration

- [ ] 2.1 Append `concurrency-verifier`, `migration-verifier`, and `test-quality-verifier` to `VERIFIER_ROLES` in `src/workflow/steps/verification.ts` (before the derived `TRIAGE_ROLES` filter), and export the catalog as the single source of truth; leave the active-role fallback in the same file unchanged
- [ ] 2.2 Append `verification-concurrency.md`, `verification-migration.md`, and `verification-test-quality.md` to the `core.verification` asset list in `src/workflow/definitions/steps.ts`
- [ ] 2.3 Regenerate the embedded definitions with `bun run scripts/generate-embedded.ts` and confirm `AGENT_DEFINITION_VERSION` changed; do not hand-edit `src/workflow/embedded.generated.ts`
- [ ] 2.4 Confirm the new roles behave correctly through the existing derived logic: selectable by triage via `TRIAGE_ROLES`, still rejected for `test-verifier`, still excluded for `openspec-verifier` under the `no-openspec` definition, and no new conditional exclusion added for the new roles

## 3. Single-source catalog for the dashboard

- [ ] 3.1 Replace the dashboard-local `VERIFICATION_ROLES` table in `src/tui/dash/ui/ModelConfigModal.tsx` with an import of the engine catalog from `src/workflow/steps/verification.ts`
- [ ] 3.2 Verify the editor still renders one role row per registered role in the intended order and that a preset containing an assignment for a role outside the current catalog still loads and saves without being rewritten

## 4. Tests

- [ ] 4.1 Update `expectedCandidateRoles` and the digest table `EXPECTED_DEFINITIONS` in `test/workflow-steps.test.ts` for the extended `core.verification` candidate roles and the changed step digest
- [ ] 4.2 Add a registration test asserting every exported catalog role resolves exactly one pinned `verification-<role without "-verifier">.md` asset, and that `test-quality-verifier` does not resolve `verification-test.md`
- [ ] 4.3 Add triage completion tests for the new roles: each new role is accepted when scoped to changed files, an unregistered role name is rejected, `test-verifier` is rejected, and a role listed in `roles` but absent from `assignments` (or vice versa) is rejected
- [ ] 4.4 Add a verification completion test asserting that selecting `test-quality-verifier` without a completed suite still launches `test-verifier` exactly once, and that an already-run suite is not launched again
- [ ] 4.5 Add a dashboard model-config test asserting the editor lists every catalog role, including the three new ones
- [ ] 4.6 Update other fixtures only where a test pins an enumerated verifier role list (`test/fakes.ts`, `src/tui/dash/demo.ts`, dash projection/metric tests); leave role-suffix-driven behavior (result popup, cost/metrics projections) untouched

## 5. Documentation

- [ ] 5.1 Add an "Adding a verifier role" checklist to `agentic-coding/docs/workflow-architecture.md` next to "Adding a step": asset file in `agent-definitions`, regeneration, `VERIFIER_ROLES` entry, `core.verification` asset list, triage table row, tests to run

## 6. Verification gates

- [ ] 6.1 Run the focused suite: `bun test test/workflow-steps.test.ts test/workflow-registry.test.ts test/workflow-model-config.test.ts test/dash/modelConfigModal.test.tsx`
- [ ] 6.2 Run `bun run lint`, `bun run type-check`, and `bun run build` from `agentic-coding/` with zero diagnostics
- [ ] 6.3 Start a workflow in the TUI and confirm triage can select the new roles, the new panes appear in the shared `verification` tab, and the model-config editor lists the new roles for assignment
