## Context

See `proposal.md` — Why for motivation. This design records how four independent planning drafts were reconciled, and what was verified in the repository rather than assumed.

Constraints that shape the approach:

- **Digest asymmetry.** `stepDigest()` in `agentic-coding/src/workflow/registry.ts` hashes an explicit field list (`id`, `version`, `actor`, `requirements`, contract ids/versions, `outcomes`, `retryLimit`, `allowedEffects`) and deliberately omits instruction assets. A definition digest, by contrast, is `digest({ ...manifest, stepDigests })` — it spreads the **whole** manifest. Adding a field to `StepDefinition` is therefore digest-safe; adding a field to `WorkflowManifest` is not.
- **`registerBuiltins` registers 40 definition sets** (20 verification-round counts × legacy/policy). Anything attached per step is constructed 40 times on every CLI invocation.
- **Two role tables answer two different questions.** This was mis-stated as "verbatim duplication" in one draft and is the single most important correction made during consolidation:
  - `runtime.ts:3796 roleForStep(step, snapshot)` resolves the roles that run **now**. For `core.verification` it returns `snapshot.step.selectedRoles`, falling back to `["test-verifier"]` or `["quality-verifier"]`; for `fusion.plan` it derives planners from the already-pinned `snapshot.routing`.
  - `cli.ts:989 rolesForDefinition(definitionId, steps, registry, fusionPlannerCount)` resolves the roles a definition can **ever** use, at start time, *before* routing exists. For `core.verification` it returns all six verifier roles; for `fusion.plan` it derives planners from a count. It feeds `validatePresetCoverage` and `resolveRouting` in both `cli.ts:1421` and `src/tui/dash/engine.ts:226`.

  They are not interchangeable. Collapsing them into one function would either strand profile routing (no route for a verifier not yet selected) or corrupt the agent fan-out (launching all six verifiers). What is genuinely duplicated is the *underlying knowledge* — the six-verifier list, the `no-openspec` drop of `openspec-verifier`, the `research` → `research-wiki` selection, the `planner-N` ordering — written out twice.
- **Existing oracle.** `test/workflow-runtime.test.ts` is 2605 lines and imports from `../src/workflow/runtime.ts`. It is only a valid before/after oracle for this refactor while that import path and its export surface stay untouched.

## Goals / Non-Goals

**Goals:**

- One declarative owner per step for role knowledge, with the type system forcing an author to answer the question rather than the engine answering it behind their back.
- Prove the seam is free: identical definition digests, identical step digests, identical resolved roles, before and after.
- Leave a documented, enforceable rule (`docs/workflow-architecture.md`) that later stages extend rather than reinvent.

**Non-Goals:**

- No new abstraction layer. This change activates a seam `StepDefinition` already declares (`enter`/`reduce`); it does not introduce a parallel registry, feature container, port set, or application service.
- No file split of `runtime.ts`, `definitions.ts`, or `cli.ts` in this change (stage C).
- No change to the legacy/policy dual definition registration. The wiki concept `projects/agentic-coding/workflow-lifecycle` (stable, human-reviewed) records that the legacy `wikiGate = false` sets exist so already-started runs keep resuming; dropping them would permanently break any such store.
- No change to SQLite schema, transaction boundaries, effect leasing, capability/token handling, artifact validation, CLI verbs, or `WorkflowView`.

## Decisions

### D1. The seam lives on `StepDefinition`, not on `WorkflowManifest`

Two drafts proposed a declarative `policy` block on `WorkflowManifest` (target kind, checkout requirement, read-only-researcher requirement) to replace the engine's hard-coded `isWikiWorkflowTarget` / `isResearchWorkflowTarget` / definition-id array checks.

Rejected for this change because the manifest digest spreads the entire manifest: `digest({ ...manifest, stepDigests })`. A new manifest field changes the digest of all 40 registered definition sets and strands every in-flight workflow with `pin-mismatch`. One of those drafts flagged this risk itself and offered "keep policy out of the digest-bearing fields" as a mitigation — but that means special-casing the digest input, which weakens the very property (whole-manifest hashing) that makes pinning trustworthy. The step-level seam needs no such carve-out: `stepDigest()` already hashes an explicit allowlist that behavior is simply not on.

Manifest-level policy is not wrong, just not free. It is recorded as a stage-B candidate where it can be introduced together with an explicit definition-version bump.

### D2. Per-step behavior modules, not per-workflow-family feature modules

One draft proposed `features/{core,openspec,fusion,wiki,research}.ts`, each feature owning its workflows' start guards, role selection, lifecycle behavior, developer actions, and evidence requirements.

Rejected because the granularity does not match the coupling. The duplication is per **step** (`core.wiki` role logic is shared by the `wiki`, `wiki-comments`, `openspec-full`, `no-openspec`, and `research` families), not per family; feature-level ownership would re-duplicate `core.wiki` across the OpenSpec, wiki, and research features. That draft's own risk list also notes that a feature policy must be "declarative and validated by the kernel, not an unrestricted callback that can bypass those checks" — which is precisely what a narrow, snapshot-only step hook is and a broad feature policy is not.

The family-level split of `definitions.ts` into `definitions/graphs/*.ts` that the same draft and one other converged on is retained as stage C: it is a good split, but of graph *composition*, not of behavior.

### D3. The transactional kernel is not restructured

One draft proposed a functional-core/imperative-shell rewrite: `ports.ts`, `domain/transition.ts`, `domain/validation.ts`, `application.ts`, `use-cases.ts`, with the dashboard and effect runner re-pointed at a gateway port.

Rejected as the vehicle for this problem. It is the largest and most invasive of the four, and its risk surface (duplicated outbox rows, a run committed without its snapshot, changed retry/lease behavior — all enumerated in that draft's own risks) is concentrated in exactly the recovery-sensitive code that is *not* the source of the developer's pain. Extracting `transition()` into a pure function also relocates the step-id ternary chain rather than removing it; the branches would live in `domain/validation.ts` instead of `runtime.ts` and would still have to be found and edited together with the CLI and dashboard copies.

Its genuinely convergent parts — extract the SQLite store, extract repository/Git inspection, extract token/capability/artifact security as one cohesive unit — appear in three of four drafts and are carried into stage C, where they are pure moves rather than a paradigm change.

### D4. Two role hooks, one role fact

`StepBehavior` exposes both lifecycle moments, so neither consumer has to re-derive anything:

- `roles(ctx: { snapshot }): string[]` — the roles to fan out **now**. Replaces `roleForStep`.
- `candidateRoles(ctx: { definitionId, fusionPlannerCount }): string[]` — every role this step can use under this definition, resolved at start time before routing exists. Backs `rolesForDefinition`.

Each step module defines its role facts once (the ordered verifier list, the `no-openspec` filter, the `research` → `research-wiki` rule, the `planner-N` generator) and both hooks read them. `core.verification` is the only step where the two hooks legitimately differ, and the module states why in a comment next to the shared list.

Alternative considered: a single `roles(ctx)` with an optional snapshot, branching internally on whether routing is pinned. Rejected — that reproduces today's ambiguity in one function and makes it possible to call it at the wrong moment and get a silently wrong answer, which is the failure mode this change exists to remove.

### D5. `rolesForDefinition` keeps its export and signature

It becomes a thin adapter that iterates the definition's agent steps and calls `candidateRoles`. One draft proposed deleting it and updating call sites.

Retained because two `src/` consumers and one test import it, and keeping it costs nothing once the body is a delegation: there is no second table left to drift. It also preserves `test/workflow-registry.test.ts` unchanged, which keeps that file an oracle for the role parity this change must not break.

### D6. The digest guard lands before any behavior moves

All four drafts independently ranked definition-digest drift as the top risk, and the wiki concept `projects/agentic-coding/workflow-lifecycle` confirms the consequence: a digest mismatch blocks the workflow before further mutation and requires repair or migration. Task ordering makes this non-negotiable — the pinned-digest snapshot test is written and green against the *current* code first, so it can only ever fail because of this change.

The snapshot enumerates every `(id, version)` pair returned by `registry.definitions()` (including the legacy/policy sets and version 1000), asserting both `definition.digest` and every entry of `stepDigests`. Wiki-native definitions (`wiki`, `wiki-comments`, and `research`) have no legacy version 1 and are not invented for the fixture.

### D7. Scope is stage A, by developer decision

The developer was asked whether the behavior seam and the file split should land together, be sequenced, or be reduced to a mechanical split, and chose sequencing: plan the `StepBehavior` seam plus role de-duplication here, and record the rest as follow-ups. On plan review the developer then asked for the follow-up proposals to be written now rather than deferred, so all four exist as separate OpenSpec changes implemented in dependency order:

- **Stage A — this change**, `restructure-repo-for-agent-use`. The `StepBehavior` seam plus role de-duplication.
- **Stage B — `move-step-semantics-to-behavior-hooks`.** Moves `validateStepEvidence`'s per-step guards, the `transition()` step-id ternary chain (loop counters, `step.mode`, `selectedRoles` extraction, context carry-over), and the `actions()` chain behind `validateEvidence` / `onArrive` / `onEnter` / `developerActions` hooks. Also carries D1's manifest policy with an explicit definition-version bump, and `profiles.ts`'s single research route check.
- **Stage C — `split-workflow-god-modules`.** `runtime.ts` → `runtime/{store,capability,migration,dialogue,evidence,view,engine}.ts`; `definitions.ts` → `definitions/{steps,edges,graphs/*}.ts`; `cli.ts` → `cli/commands/*.ts`; all three originals reduced to re-export barrels. This is the one structural change all four drafts agreed on and is a pure move, verifiable by the same digest guard.
- **Stage D — `derive-dashboard-actions-from-engine`.** `src/tui/dash/data.ts:1881 requiredUserActionFor` derives action *availability* from the engine's `view.actions` instead of re-implementing the phase table and the close-only allowlist, keeping UI copy in the dashboard keyed by action id. `App.tsx`'s six step-id popup checks follow.

Each later stage's plan states the stage-A output it assumes and requires re-verification before implementation, because those plans were written against the pre-stage-A repository. Planning them upfront gives the full sequence visible for approval; it does not make any of them exempt from checking that its premises still hold.

Writing stage D's plan surfaced two live divergences between the engine's action list and the dashboard's, both present in the current repository and neither previously known: the dashboard's close-only allowlist omits `wiki-comments`, so a completed `wiki-comments` workflow offers a `create-pr` the engine refuses; and the dashboard offers a `close-clean` action that exists nowhere else in the package. They are evidence for the sequence rather than against it — this is exactly the silent-breakage class the restructuring targets — and they are addressed in stage D, not here.

Trade-off accepted: the duplicated evidence, transition, action, and assignment branches remain in place until stages B and D land, so the "each change breaks something" problem is reduced but not eliminated by this change alone. Four smaller diffs, each independently green and independently revertable, was judged worth that.

### D8. Behavior is declared, not computed

`StepBehavior` implementations must be module-level constants whose hooks are pure functions of their arguments. No hook receives a `Database` handle, an engine reference, or a filesystem path, so a step module cannot reach into persistence, and nothing is allocated per registration — which matters because registration happens 40 times per CLI invocation.

## Risks / Trade-offs

- **Definition-digest drift strands in-flight workflows** → D6: the pinned-digest guard is task 1, written green against current code before any behavior exists; `stepDigest()` is not edited, and a comment next to its existing instruction-asset note states that behavior must never enter the digest.
- **`core.verification`'s two role answers get collapsed into one** → D4 makes the two moments separate named hooks; `test/workflow-steps.test.ts` asserts both, and asserts they differ for `core.verification` (six candidates vs. the snapshot-selected subset) and agree everywhere else.
- **A role-parity regression is silent** — a wrong role list launches the wrong agent rather than throwing → parity is asserted exhaustively: every agent step × every definition id × fusion planner counts 2–5, compared against values captured from the current implementation.
- **Import cycles under Bun's ESM loader surface as undefined-at-module-init, not a clear error** → the dependency direction is one-way and shallow in this stage (`steps/* → registry types only`; `definitions.ts`, `runtime.ts`, `cli.ts` → `steps/*`); no `steps/*` module may import `runtime.ts`, `definitions.ts`, or `cli.ts`, and `bun run type-check` plus the focused tests catch a violation.
- **Per-registration cost multiplies by 40** → D8 requires module-level constants; behavior objects are shared by reference across every registered definition set.
- **The exhaustiveness assertion could fail closed on a legitimately behavior-free step** → it asserts only over steps referenced by a registered manifest, and a behavior with no hooks is valid, so a developer/system step needs an entry but no logic.
- **Scope is smaller than the underlying problem** (D7 trade-off) → `docs/workflow-architecture.md` states the end-state rule and marks which branches are still outstanding, so stage B/C/D authors inherit the map rather than rediscovering it.

## Migration Plan

No data migration: no schema, manifest, version, or digest changes. Deployment is an ordinary build.

Task order is the risk control, each stage green before the next:

1. Pinned-digest guard, written against current code.
2. `StepBehavior` type + `behavior?` field + registry validation (no behavior declared yet) — guard must still pass.
3. Step modules with both role hooks; `steps/index.ts` with the exhaustiveness assertion; role-parity test compares hooks against the still-live `roleForStep` / `rolesForDefinition`.
4. Delete `roleForStep`, delegate in `runtime.ts`; reduce `rolesForDefinition` to an adapter.
5. Docs.

Rollback: revert. Nothing is persisted, pinned, or version-gated by this change, so a revert at any point leaves existing workflow stores fully operational.

## Open Questions

These are deferrable — none changes the specs, the approach, or the task breakdown:

- Whether `src/workflow/runtime.ts` stays a permanent re-export barrel after stage C, or whether a later change retargets consumers to `runtime/*.ts` directly. Not answerable until stage C exists; irrelevant to this change, which does not split the file.
- Whether the duplicated TUI component sets (`src/tui/dash/devenv-ui/`, `src/tui/dash/ui/`, `src/tui/otel/components/` each defining Badge, GenericModal, Highlight, ScrollableContent) are a stalled migration worth consolidating. Real duplication, but unrelated to workflow coupling; it needs its own change.
- Whether `src/tui/dash/data.ts`'s legacy phase-string handling (`proposed`, `wiki-approval`, `developer-review`, `research`, `completed` alongside their `core.*` equivalents) can be dropped. Belongs to stage D, where the phase table is being replaced anyway.
- Whether `contracts.ts` (1078 lines) and `effect-runner.ts` (1478 lines) warrant splitting. Both are flat exported functions rather than god-classes, so they are not the current coupling problem; revisit after stage C.

## Documentation Gaps for the Wiki Step

Recorded here for the workflow's dedicated wiki step; not written from consolidation.

- **Update `projects/agentic-coding/workflow-lifecycle`** with the step-behavior seam and the digest asymmetry from Context: `stepDigest()` hashes an explicit allowlist (behavior and instruction assets excluded, safe to extend) while the definition digest spreads the whole manifest (not safe to extend without a version bump). This is the fact that determined D1 and is currently discoverable only by reading `registry.ts`.
- **New concept, `projects/agentic-coding/workflow-step-roles`**: the two role-resolution moments (start-time candidate roles for profile routing vs. run-time active roles for agent fan-out), why `core.verification` is the one step where they legitimately differ, and the rule that both derive from one step-owned fact. This corrects an easy and consequential misreading — the two functions look like duplicates and are not.
- **Update `projects/agentic-coding/research-wiki-handoff`** if and when stage A's role modules change where `research` → `research-wiki` selection is written; the concept currently cites `runtime.ts`'s `roleForStep` by name as the location of that rule.
- **New concept, `projects/agentic-coding/dashboard-action-authority`** (for stage D, recorded here because it was discovered while planning the sequence): the engine's `actions()` list is authoritative and the dashboard's `requiredUserActionFor` is a second, drifted copy. Two live divergences are evidence — the dashboard's close-only allowlist omits `wiki-comments`, and it offers a `close-clean` action defined nowhere in the package. Documenting the intended authority direction prevents the next contributor from re-adding a dashboard-side allowlist.
