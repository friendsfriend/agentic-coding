## Context

`core.verification` fans out one run per verifier role selected by the preceding `core.triage` run. The role set is a closed list in `src/workflow/steps/verification.ts` (`VERIFIER_ROLES`, with `TRIAGE_ROLES` derived by removing `test-verifier`), and each role resolves exactly one pinned instruction asset by stripping its `-verifier` suffix and looking for `verification-<role>.md` among the step's pinned assets (`src/workflow/assignment.ts`). Triage validates its plan against the same engine-side list, so a role the engine does not register cannot be selected.

Instruction assets live in `agent-definitions/instructions/` and are bundled into `src/workflow/embedded.generated.ts` by `scripts/generate-embedded.ts`; each step pins its asset list by digest in `src/workflow/definitions/steps.ts`. The dashboard model-config editor keeps its own copy of the verifier role names, which `AGENTS.md` explicitly discourages ("the engine, CLI, and dashboard must read registered step behavior rather than duplicate role tables").

Three defect classes have no owner today: concurrency/ordering defects in the durable-state engine, persisted-state and schema migration safety, and test adequacy (suite green over unasserted behavior). `quality-verifier` is defined as "correctness, maintainability, error handling" — too broad to be accountable for any of the three.

Constraints: no new step, contract, graph edge, or outcome; findings keep the existing `core.findings` shape and the path + 1-based line requirement; `test-verifier` keeps exclusive ownership of the complete repository test suite; existing workflow state is pinned at start and must not be disturbed.

## Goals / Non-Goals

**Goals:**
- Register three additional triage-selectable verifier roles with explicit, narrow remits.
- Keep the role set single-sourced so the engine, triage validation, and the dashboard cannot drift.
- Keep complete-suite ownership and the existing auto-launch of `test-verifier` unchanged.
- Make adding a verifier role a documented, test-covered operation.

**Non-Goals:**
- No new engine mechanics: no new step, contract schema, transition outcome, severity, or verdict rule.
- No mutation testing, coverage tooling, or dependency/supply-chain verification.
- No change to pane/tab grouping, routing pinning, model routing resolution, or the fix-loop limit.
- No back-fill of already-passed verification results.

## Decisions

### Decision: three roles, not a widened `quality-verifier` remit

Add `concurrency-verifier`, `migration-verifier`, and `test-quality-verifier` rather than extending `quality-verifier`.

Alternative considered: append the three remits to `quality-verifier`. Rejected — an unfocused role reliably reports the easy third of its remit, and no role is then accountable for the two classes it skips. Triage also loses the ability to scope each class to different files.

### Decision: role ids and asset names follow the existing derivation

Role ids: `concurrency-verifier`, `migration-verifier`, `test-quality-verifier`.
Asset names: `verification-concurrency.md`, `verification-migration.md`, `verification-test-quality.md`.

`assignment.ts` selects a role's asset by exact equality (`name === \`verification-${roleAsset}.md\``), so `test-quality-verifier` → `verification-test-quality.md` does not collide with `test-verifier` → `verification-test.md`. A registration-time test asserts every registered verifier role resolves to a pinned asset, so a rename cannot silently produce a missing-asset throw.

### Decision: all three roles are triage-selectable, none auto-launched

All three are added to `VERIFIER_ROLES` and therefore to the derived `TRIAGE_ROLES`; `test-verifier` remains the only exclusion. No `no-openspec`-style conditional exclusion is added.

Alternative considered: auto-launch `test-quality-verifier` next to `test-verifier` and make it mandatory per round. Rejected — test adequacy is a change-scoped judgment (only changes that add or modify tests need it), whereas the complete suite is a fixed repo-wide gate. Auto-launching it would also require a second `testRunStarted`-style flag to order it against `test-verifier` and would add fixed cost to every verification round.

### Decision: `test-verifier` keeps complete-suite ownership

The completion rule stays as-is: after all selected verifiers report, the engine launches `test-verifier` exactly once if it has not run. `test-quality-verifier` is instructed to review whether the changed behavior is asserted at all and whether the assertions would fail if the logic broke, using only focused checks for the changed scope — never the full suite. The instruction states this boundary explicitly so a reader cannot mistake the new role for the suite owner.

### Decision: the engine's role set becomes the single source for the dashboard

Export the verifier role catalog from `src/workflow/steps/verification.ts` and import it in `src/tui/dash/ui/ModelConfigModal.tsx`, deleting the dashboard-local table.

Alternative considered: leave the duplicate table and extend both. Rejected — it is the exact drift `AGENTS.md` forbids, and it already means a new role can be selectable while unconfigurable in the preset editor.
Alternative considered: derive the list in the dashboard from the definition registry. Rejected — the registry exposes structural step data, while the active role catalog is step behavior; the step module is already the validated home for it.

### Decision: additive registration only

Existing roles keep their positions and assets; new entries are appended to `VERIFIER_ROLES`, to the `core.verification` asset list, and to the triage instruction's role table, in the same order in all three places.

Effects of append-only registration: in-flight workflows keep their pinned instruction digests and role behavior, so this change cannot invalidate a running verification round; only newly started workflows see the new roles. Fixtures and dashboards that key off the `-verifier` suffix (verifier result popup, cost/metrics projections, run short-role display) work for the new roles without modification.

### Decision: regenerate, never hand-edit, the embedded definitions

Assets are authored in `agent-definitions/instructions/`, then bundled via `scripts/generate-embedded.ts` (`bun run build` runs it), which also updates `AGENT_DEFINITION_VERSION`. `src/workflow/embedded.generated.ts` is never edited by hand; lint excludes it from formatting overrides.

### Decision: per-role remits stay narrow and evidence-based

Each new asset follows the brevity of its siblings (`verification-security.md`, `verification-performance.md`) and names only its own class:

- `verification-concurrency.md` — introduced races, ordering assumptions, and reentrancy in shared mutable state: concurrent transitions and projections, duplicate or late run completion, outbox retry ordering and idempotency, unguarded interleaving between engine transactions and boundary adapters.
- `verification-migration.md` — persisted-state safety: compatibility of written formats and versions, upgrade path for state written by an earlier definition/schema, atomicity and partial-write windows, and how a failed transition is rolled back.
- `verification-test-quality.md` — test adequacy for the changed scope: whether new or changed behavior is asserted at all, whether assertions fail when the logic breaks, and whether a test only restates the implementation. Focused checks only; never the full suite.

All three inherit the shared verification contract: `core.findings` shape, critical findings block, every finding names a repository-relative path and 1-based line, no code edits, no sibling coordination.

## Risks / Trade-offs

- Triage over-selects because more roles exist → verification rounds get slower and costlier. Mitigation: the triage instruction keeps its "minimum verifier roles that cover the change" rule, and each new role has a table row with a concrete remit so triage can skip it when the changed files carry no such surface.
- A narrow role reports no finding on most changes, which can look like dead weight → Mitigation: instructions require no finding when the class is absent (matching `verification-test.md` behavior) instead of inventing advisory noise; remits are scoped to changed files, not the repository.
- Severity inflation: a new role marking stylistic concerns critical would trigger fix loops. Mitigation: instructions require concrete, evidenced defects for critical, consistent with the existing roles' "concrete evidence only" wording.
- Role/asset drift reintroduced later by someone extending only one of the three lists. Mitigation: single exported catalog, one registration test asserting every registered role resolves a pinned asset, and a documented "adding a verifier role" checklist.
- More concurrent verifier panes per round in the shared `verification` tab. Mitigation: no geometry change is needed (one pane per role already); the round's fan-out remains bounded by triage's selection.

## Migration Plan

No state migration. Registration is additive; in-flight workflows keep pinned digests.

Deploy order: author assets → regenerate embedded definitions → extend role set and step asset list → single-source the dashboard role list → tests and docs.

Rollback: revert the change. New roles are only observable through triage selection, so a revert cannot strand persisted workflow state; a workflow started under the new roles is unaffected because its instruction assets and routing are pinned at start.

## Open Questions

- Should `migration-verifier` be named for persisted *state* explicitly (for example `state-migration-verifier`) so triage does not read it as database migrations? Current decision keeps the shorter id; the triage table row disambiguates by remit.
- Should `test-quality-verifier` be gated on the change touching test files? Current decision leaves this to triage's judgment rather than engine gating, to avoid a second selection mechanism.
