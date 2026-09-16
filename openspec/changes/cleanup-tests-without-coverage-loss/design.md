## Context

The initial audit mapped 221 Bun test files and 68,568 test lines across workflow, actions, runtime, configuration/state, integrations, server/lifecycle, shell, dashboard, observability, and imported DevEnv packages. A 10,554-line block in `test/workflow-steps.test.ts` repeats compatibility expectations for 489 historical definitions. These figures describe the audited working tree, not a required final count.

Main-suite execution reported 1,714 tests in 78.42 seconds, with one process-tree timeout in `actions-script-runtime.test.ts`; the focused rerun passed. The package suite reported 171 passing tests in 0.98 seconds. Another test runner and concurrent source changes were present, so neither timings nor the timeout establish a causal performance finding. Four opt-in runtime smoke cases returned early yet counted as passes.

Isolated probes established these bounded findings:

| Fault | Missed by | Caught by |
| --- | --- | --- |
| Remove location-picker acceptance callback | `app/pagesRender.test.tsx` | No surviving detector established in the audit |
| Remove production modal Portal | `dash/modalCentering.test.ts` | `dash/sharedPrimitives.test.tsx` |
| Return no trace summaries | `otel/tabShell.test.ts` | `otel/traceLiveRefresh.test.tsx` |
| Accept forged bearer tokens | — | `server-api.test.ts` |
| Add workflow import of environment state store | `environment-ownership.test.ts` | No surviving detector established in the audit |

Additional inspected checks use manufactured route results, a copied modal, a non-cycle fixture, nullish inputs labeled oversized, and exact implementation/prose strings. None of these observations alone justifies deleting an entire neighboring suite. Existing workflow testability and source-layer specifications remain binding.

## Goals / Non-Goals

**Goals:**

- Reduce repeated expectations and redundant assertions without losing supported contract or defect coverage.
- Ensure retained tests execute the production path they claim to protect.
- Repair identified false-confidence checks and distinguish skipped runtime work from executed checks.
- Leave a small, reviewable record of removals, surviving detectors, focused probes, and verification results.

**Non-Goals:**

- A numerical test-count, line-count, runtime, or mutation-score target.
- Exhaustive mutation testing, a new test framework, a permanent coverage ledger/tool, or broad test-directory moves.
- Dropping unique cosmetic/accessibility checks, weakening supported historical pins, changing product behavior, or replacing real process/store tests with mocks.
- Running destructive live-runtime checks without explicit opt-in or provisioning external tools/resources automatically.
- Final testing-policy edits to `AGENTS.md`; those follow review of this cleanup.

## Decisions

### 1. Delete by guarantee, not filename or test size

Before each removal, record a short row in change-local `verification.md`: removed case/assertion, protected guarantee, surviving test and relevant input, or why it has no product guarantee. Read existing requirements and callers before classifying internal exports, instruction text, or migration checks as obsolete. Keep ambiguous cases.

Start with test-local `shape`/`caseNamed` checks, redundant constructor/export-existence checks in `otel/tabShell.test.ts`, repeated deterministic calls in `dash/projections.test.ts`, and demonstrably overlapping source/asset markers. Preserve unique empty-state, asset packaging, instruction-policy, and public-contract checks. The internal export fixture stays unless its removal is compatible with existing specification requirements; no blanket deletion is authorized.

Alternative rejected: remove all snapshots, source tests, migration fixtures, or small units. These categories include independent compatibility oracles and real security/data-loss detectors.

### 2. Deduplicate independent pin data, not compatibility coverage

Extract the existing literal expectations mechanically into a compact independent fixture: unique step-digest maps referenced by historical definitions, plus each definition's existing identity, version, digest, and ordering. If map deduplication is insufficient, use a shared literal step-digest table with explicit per-definition membership. Choose the smaller representation that reconstructs every original tuple exactly.

Before removing the old block, compare the reconstructed representation with the full old expectation, not just current registry output. Retain a single executable comparison against every previously guarded definition and step association. Missing/extra identities, changed hashes, and changed associations must still fail. Do not update expected hashes to make implementation changes pass, broaden/narrow the historical filter, or hand-edit generated workflow assets.

Alternative rejected: recompute expected hashes from `registerBuiltins()`, retain one representative version, or merely move the repeated block into JSON. Those weaken independence or fail to reduce duplication.

### 3. Repair assertions at existing production seams

- Navigation: drive actual keyboard/mouse handlers and assert emitted routes or shell state; never push expected results into the assertion array. Reuse actual breadcrumb click/journey tests where they protect the same input path; add a focused picker click regression where none exists.
- Modal positioning: remove the synthetic OpenTUI reconstruction only after a production modal mounted beneath offset shell content asserts terminal-relative centering. Reuse `sharedPrimitives.test.tsx`; retain its independent stacking/lifecycle assertions. Portal-removal detection alone does not prove exact centering.
- Cycle/payload cases: use a genuine cycle when claiming cycle handling; rename nullish-normalizer coverage accurately and retain actual byte-bound checks at the boundary that owns size limits. Add a missing required detector rather than preserve a false claim.
- Preserve live trace refresh and forged-token rejection as positive controls when deleting weaker neighboring checks.

Alternative rejected: strengthen fake/copied implementations or collapse distinct interaction paths into one happy-path journey. Production wiring can break independently of pure helper behavior.

### 4. Reuse the source graph for ownership checks

Replace the `content from` regex in `environment-ownership.test.ts` with resolved dependency edges from `scripts/workflow-module-graph.ts`. Enforce the existing workflow/telemetry prohibition on direct dependencies on environment state/manager/private operations without accidentally banning authorized composition-root clients. Cover named imports, re-exports, type-only references, and literal dynamic/require forms through the existing parser and small fixtures; do not build another scanner.

Consolidate duplicate cycle walks where practical, but retain both runtime-cycle detection and the separate parent-barrel rule required by `source-layer-boundaries`. Keep the real authority test that verifies other databases remain untouched. Unexpected legitimate edges require review, not silent exceptions or a wider policy rewrite.

### 5. Make smoke execution and safety claims truthful

Use supported Bun skip facilities for unselected runtimes and missing prerequisites. If the installed Bun API cannot mark a prerequisite skip after test entry, perform bounded prerequisite discovery before registration; do not turn skipped work into successful returns. Once prerequisites are satisfied and an operation is attempted, unexpected creation/lifecycle/cleanup errors fail the test.

Keep explicit Docker/Kubernetes opt-in. Combine weak foreign-resource checks with a meaningful lifecycle/preservation check where appropriate: use isolated, test-owned sentinel resources representing a different owner, assert their identity/state before and after the operation, and clean them only through test-owned teardown. Never delete, mutate, or rely on unrelated user workloads to establish preservation.

If the custom runner hides skip information, extend its existing reporting minimally so users can distinguish executed passes, failures, and skipped cases. Preserve process isolation and watchdog behavior; changing aggregate numbers is not evidence of lost coverage when earlier counts included no-op passes.

### 6. Prove the cleanup with bounded evidence

Re-run relevant fault probes in an isolated copy, with unmodified baseline passing first. Record the mutation, focused command, baseline result, expected failing assertion, and result after restoring production code. Keep normal regression tests; no committed deliberately broken production files or permanent mutation framework.

Re-measure both configured Bun commands and affected shell checks. Preserve timeout/cancellation coverage; investigate recurrence of the observed timeout separately rather than deleting it or relaxing its deadline to obtain green results. Run lint with zero diagnostics, type-check, and build, and validate this OpenSpec change. Report pre-existing/concurrent failures honestly without editing unrelated work.

## Risks / Trade-offs

- **Undetected coverage loss** → Retain ambiguous cases; require a surviving detector and focused probes for overlapping behavioral checks. No claim of exhaustive equivalence.
- **Digest compression hides omissions** → Prove exact reconstruction against the old independent fixture and verify missing/changed identity and step-association failures.
- **Renderer tests depend on timing** → Use existing renderer flush/wait helpers and actual input; preserve per-file isolation, not arbitrary sleeps.
- **Architecture repair changes policy** → Keep current ownership scope and negative/positive fixtures; retain distinct documented guardrails.
- **Smoke checks affect user resources** → Explicit opt-in, unique test identities, independently owned sentinels, bounded cleanup, and no automatic provisioning.
- **Concurrent navigation/telemetry changes invalidate baselines** → Refresh the inventory at implementation start and preserve unrelated edits. The audit's paths/probes are guidance, not stale expectations to force onto new behavior.

## Migration Plan

No product or data migration. Land independent, reviewable groups: baseline evidence, digest compaction, assertion/guard repair, proven redundant deletions, smoke reporting, and final verification. Each group can be reverted without changing production formats or historical pins. After review, use observed results to propose the separate `AGENTS.md` policy change.

## Open Questions

No product decision blocks implementation. Ambiguous deletion candidates default to retained. Final breadth of cosmetic pruning and repository-wide testing policy remains deferred to the user review.
