## Context

See `proposal.md` — Why. This is stage C of the four-stage sequence recorded in `restructure-repo-for-agent-use/design.md` D7, and it is the change all four original planning drafts independently proposed.

Current state (line counts will differ after stages A and B; the concern grouping will not):

| File | Lines | Exports | Shape |
| --- | --- | --- | --- |
| `src/workflow/runtime.ts` | 3936 | 22 | one `WorkflowEngine` class + free helpers |
| `src/workflow/cli.ts` | 1804 | 20 | one `run(argv)` branch chain |
| `src/workflow/definitions.ts` | 1396 | 10 | one `registerBuiltins` + one `workflowEdges` |

19 files import from these three paths: `src/cli.ts`, `src/tui/dash/data.ts`, `src/tui/dash/engine.ts`, `src/workflow/effect-runner.ts`, and 15 files under `test/`.

Two facts make this stage tractable in a way it would not have been as stage A:

- **Stages A and B already moved the semantics.** What remains is genuinely relocation, not reinterpretation. The step behavior modules already exist under `src/workflow/steps/`, so no step-identity logic needs a home invented for it here.
- **The digests are a machine-checkable proof of a no-op.** `registerDefinition` computes a content digest over each manifest. If any definition id, version, edge, effect, outcome, or contract identity changes during the split, the stage-A digest snapshot fails immediately and loudly. A refactor with a built-in correctness oracle is a different risk class from one without.

## Goals / Non-Goals

**Goals:**

- No file in `src/workflow/` exceeds roughly 600 lines, and each has one nameable concern.
- Zero import churn: all 19 importers compile unchanged.
- The split is provably behavior-preserving via unchanged digests and the unmodified existing test suite.

**Non-Goals:**

- No behavior change of any kind. Any behavior improvement noticed during the split is recorded and deferred, not folded in — mixing a fix into a 3000-line move destroys the "pure move" property that makes this safe.
- No retargeting of consumer imports to the new paths. Barrels stay; whether they stay permanently is deliberately left open below.
- No split of `contracts.ts` or `effect-runner.ts`.
- No collapse of the legacy/policy dual definition registration. The wiki concept `projects/agentic-coding/workflow-lifecycle` (stable, human-reviewed) records that legacy sets exist so already-started runs keep resuming.

## Decisions

### D1. Barrels are mandatory, and the export surface is diffed mechanically

One draft noted that a barrel "must enumerate every currently exported name exactly; missing one breaks a consumer at type-check time, and the true export surface can only be confirmed by diffing `export` statements before and after, not by inspection alone."

That is adopted literally as a task: capture the sorted export list of each of the three files before the split, and assert the post-split barrel re-exports exactly that set — same names, same kinds, no additions. `bun run type-check` catches a missing export, but only for names some consumer actually uses; the diff catches an export nothing currently imports but which is part of the published surface.

### D2. Split by concern, not by extraction convenience

Three of the four drafts proposed near-identical groupings for `runtime.ts`, which is strong convergence. The grouping used here:

| Module | Owns | Why it is one unit |
| --- | --- | --- |
| `runtime/store.ts` | schema DDL, row mapping, open/rollback, snapshot writes | SQL ownership must be in exactly one place, so an engine change cannot silently alter transaction boundaries |
| `runtime/capability.ts` | token hashing, capability issue/authorize, artifact path/size/schema/digest validation | **the security boundary** — extracted as one cohesive unit rather than spread, so it can be reviewed and tested as a whole |
| `runtime/migration.ts` | legacy discovery, phase mapping, conflict diagnostics | least-covered code in the package; isolating it makes its thin coverage visible |
| `runtime/dialogue.ts` | question create/answer/expire, dialogue bounds | self-contained feature, snapshot-in/snapshot-out |
| `runtime/evidence.ts` | Git inspection, source fingerprinting, changed files, wiki baseline | all external-I/O reads |
| `runtime/view.ts` | view/list/status projection, repair preview | read path only |
| `runtime/engine.ts` | the `WorkflowEngine` class: start, dispatch, reduce, transition, effects | the transactional kernel, now much smaller |

`capability.ts` grouping is the one deliberate deviation from "smallest possible modules": the token, capability, and artifact checks are a single security contract, and splitting them across three files would make it possible to weaken one without the reviewer seeing the others.

### D3. Reducer dispatch replaces the private-method chain, but only mechanically

One draft proposed extracting each `reduce()` command branch into its own module with an explicit `ctx` object, replacing implicit `this`. Adopted, with one constraint that draft itself raised: those private methods may share closure state or call other private methods (`writeSnapshot`, `validateSnapshot`) and may assume they run inside the caller's `BEGIN IMMEDIATE` transaction.

So each reducer is extracted **one at a time**, each with its own green test run, and each keeps running inside the same transaction the kernel opened — the `ctx` carries the open `db` handle rather than opening its own. A reducer that turns out to depend on something not in `ctx` stays in the kernel and is recorded, rather than having `ctx` widened until it is `this` by another name.

### D4. The digest guard from stage A is the gate, and it runs between every move

Not once at the end. Each extraction task ends with the digest snapshot passing, so a digest change is attributed to the single move that caused it instead of being discovered after twenty moves.

### D5. One-way dependency order, enforced

`store` / `capability` / `evidence` → `dialogue` / `migration` / `view` → `engine`. No module under `runtime/` may import the `runtime.ts` barrel; that would create the cycle `barrel → engine → barrel`, which under Bun's ESM loader surfaces as undefined-at-module-init rather than a clear error. Type-only imports are used where a type is needed across the direction.

## Risks / Trade-offs

- **A barrel omits an export and breaks a consumer** → D1's mechanical before/after export diff, plus `bun run type-check` across `src/` and `test/`.
- **An extracted reducer silently leaves its transaction or loses an implicit dependency** → D3: one reducer per task, `ctx` carries the open handle, no widening; `test/workflow-runtime.test.ts` stays unmodified as the oracle and covers rollback and effect-result paths.
- **A definition digest moves during the graph-family split** → D4 runs the stage-A digest snapshot between every move; the split is a pure move, so any change is a bug, not a decision.
- **Import cycles surface as undefined-at-module-init** → D5's enforced one-way order; a cycle check runs in the validation group.
- **`migrateLegacy` is the least-covered code and operates on stores that may already exist on the developer's machine** → moved verbatim with no signature change beyond taking registry and clock as parameters; `test/workflow-migration.test.ts` is the only oracle, and its thinness is called out in `docs/workflow-architecture.md` rather than papered over.
- **The diff is large by line count even though it is small by semantic content** → reviewers should read it as file moves; the tasks are ordered so each commit is one coherent extraction, and the digest guard plus unmodified test suite carry most of the verification burden.

## Migration Plan

No data, schema, manifest, version, or digest changes. Deployment is an ordinary build.

Order: `definitions.ts` first (smallest, and the digest guard is most direct there), then `cli.ts` (fewest cross-dependencies), then `runtime.ts` (largest, benefits from the pattern being established twice). Within `runtime.ts`: leaf helpers first (`store`, `evidence`, `capability`), then self-contained features (`dialogue`, `migration`), then `view`, then reducers one at a time, leaving `engine.ts` as the residue.

Rollback: revert. No persisted state, pin, or version is touched at any point.

## Open Questions

- Whether the three barrels stay permanently or a later change retargets the 19 importers to the new paths. Keeping them costs one indirection and preserves the existing test suite as an unmodified oracle; retargeting is cleaner long-term but produces a second large diff and destroys that oracle property. Deferrable — the barrels are correct either way, and the answer does not change any task here.
- Whether `runtime/capability.ts` should later move next to the other security-relevant code rather than under `runtime/`. Placement question only, no behavior impact.
