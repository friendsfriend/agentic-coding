## Context

See `proposal.md` — Why. This is stage B of the four-stage sequence recorded in `restructure-repo-for-agent-use/design.md` D7.

State this design assumes, and which **must be re-verified before implementing** because stage A produces it:

- `StepBehavior` exists in `agentic-coding/src/workflow/steps/types.ts` with `roles` and `candidateRoles` hooks, and `StepDefinition.behavior` exists in `registry.ts`.
- `stepDigest()` hashes an explicit field allowlist that behavior is not on, so extending the behavior block is digest-free. The definition digest, by contrast, is `digest({ ...manifest, stepDigests })` — it spreads the whole manifest.
- `steps/index.ts` holds the catalog and its construction-time exhaustiveness assertion.
- `docs/workflow-architecture.md` records the rule that step knowledge lives only in `src/workflow/steps/`.

Verified in the current repository (pre-stage-A line numbers, for scope not for editing):

- `runtime.ts:2380-2484` `transition()` — nine step-id branches including the five-clause context carry-over.
- `runtime.ts:2485-2532` `enterStep()` — `fusion.plan` relaunch-skip, `core.delivery` and `core.closed` enqueues.
- `runtime.ts:2870-2920` `validateStepEvidence()` — planning, implementation (with the `no-openspec` exemption), and archive guards.
- `runtime.ts:3011-3128` `actions()` — a nested ternary that contains `core.wiki-approval` twice, once in the research sub-tree and once in the main chain, with identical action content.
- `effect-runner.ts:1054,1294,1323,1426,1442`; `assignment.ts:184`; `profiles.ts:502` — the remaining step-identity branches outside the engine.

## Goals / Non-Goals

**Goals:**

- No file outside `src/workflow/steps/` branches on a `core.*` or `fusion.*` step identifier when this stage completes. That is the checkable end state stage A's documentation promised.
- Collapse the duplicated `core.wiki-approval` action branch to one declaration.
- Make the context carry-over precedence explicit and directly asserted rather than emergent from ternary ordering.

**Non-Goals:**

- No file split of `runtime.ts`, `definitions.ts`, or `cli.ts` — that is stage C, and doing both at once would make this diff unreviewable.
- No dashboard change — that is stage D. This stage leaves `tui/dash/data.ts` re-deriving action availability; it only makes the engine side single-sourced so stage D has something correct to read.
- No change to effect mechanics, pane ownership, transaction boundaries, capability handling, or the SQLite schema.
- No change to which steps exist, which graphs exist, or what any workflow does.

## Decisions

### D1. Manifest policy lands here, with a version bump

Stage A deferred the manifest-level `policy` block because the definition digest spreads the whole manifest, so adding a field silently strands every in-flight workflow with `pin-mismatch`. That constraint has not changed — what changes is that this stage can afford the correct handling: register the policy-bearing manifests under a **new definition version**, leaving the prior versions registered and resolvable exactly as the existing legacy/policy dual registration already does for `wikiGate`.

The wiki concept `projects/agentic-coding/workflow-lifecycle` (stable, human-reviewed) documents that precedent: `registerBuiltins` already registers a legacy set and a policy set per workflow id per round count, and the app resolves the version to run via `definitionVersionForPolicy(...)`. This stage follows the same mechanism rather than inventing one.

Alternative considered: keep policy out of the digest input via a carve-out in `digest()`. Rejected — it special-cases the hash and weakens the property that makes pinning trustworthy, and it was rejected for the same reason in stage A.

Alternative considered: leave the identifier checks in the engine indefinitely. Rejected — they are start-time security-relevant rules (read-only researcher, target kind), and leaving them as string comparisons scattered across the engine is precisely the coupling this sequence exists to remove.

### D2. `onArrive` receives the prior step, not the live snapshot mid-mutation

`transition()` currently reads `priorAttempt`, `priorResults`, and `priorContext` into locals *before* `snapshot.step = freshStep(...)` overwrites them, then consults those locals in the carry-over condition. A hook invoked after `freshStep` cannot see them.

`onArrive` therefore receives an explicit `prior: { attempt, results, context }` alongside the edge, outcome, and output, and returns the derived step state rather than mutating a snapshot it does not own. This makes the data dependency visible in the signature instead of implicit in statement order — one of the drafts flagged exactly this class of hidden dependency as the reason a mechanical extraction can silently change behavior.

### D3. Context carry-over becomes an ordered rule list, not per-step hooks alone

The five clauses have load-bearing precedence: the `wiki-comments` definition override beats the loop self-edge, which beats the output-carrying step list, which beats `comments`-into-wiki/archive, which beats `wiki-approval` + `complete` → `wikiVerificationPayload`. Decomposing this into five independent per-step hooks would lose the ordering, and the failure mode is silent — a wrong `step.context` surfaces as a wrong or empty agent assignment several steps later.

So carry-over is expressed as one explicitly ordered resolver in the engine, with steps *opting into* named rules via declared flags (`carriesOutputContext`, `acceptsCommentsContext`, `producesWikiVerificationContext`) rather than each step reimplementing resolution. The precedence list is written once, in order, with a test per adjacent pair proving the higher rule wins.

Alternative considered: pure per-step `onArrive` ownership of context, as one draft proposed. Rejected for the reason above — it is the one place in this refactor where centralized ordering is the safer structure, and pretending otherwise to satisfy a symmetry would trade a real invariant for tidiness.

### D4. `onEnter` receives capabilities, never the database

`enterStep` currently calls `this.enqueue(db, ...)` directly and, for `fusion.plan`, queries `workflow_runs` by run id to find an active role. A hook must not receive `db` — that would let a step module reach into persistence and would undo stage A's D8 boundary.

`onEnter` therefore receives `{ snapshot, enqueue, hasLiveRun }` where `enqueue` is a bound callback and `hasLiveRun(role)` is a precomputed predicate the engine supplies. The step declares *what* to enqueue and *which roles to skip*; the engine remains the only code that touches SQLite.

### D5. `assignmentInputs` is scoped to snapshot and run, and the scope is checked first

One draft flagged that moving assignment shaping out of `effect-runner.ts` may need context the step modules deliberately do not receive — resolved profile, pane state, adapter details — and that discovering this mid-implementation would force a signature widening that reintroduces the coupling.

Task 5.1 therefore audits every branch being moved and records its actual inputs *before* the hook is written. If any branch needs more than `{ snapshot, run }`, it stays in `effect-runner.ts` and is recorded as out of scope rather than widening the hook. Removing four of five branches cleanly is a better outcome than moving all five through a context object broad enough to leak the engine back in.

### D6. Stage ordering within this change is guard → arrival → entry → actions → outside-engine

Each is independently green, in increasing order of risk: entry guards are pure predicates with existing focused coverage; arrival semantics carry the silent-failure risk of D3; entry effects touch the outbox; actions change what the dashboard sees; the outside-engine branches touch the assignment render path. The manifest policy bump lands last because it is the only part that changes a digest, so everything before it is verifiable against unchanged digests.

## Risks / Trade-offs

- **Context carry-over precedence silently reorders** → D3's single ordered resolver plus a test per adjacent precedence pair; `test/workflow-runtime.test.ts` stays an unmodified oracle for the combinations it already covers.
- **`onArrive` misses a dependency captured before `freshStep`** → D2 puts `prior` in the signature; the engine no longer keeps those locals, so a missed dependency is a type error rather than a stale read.
- **Manifest policy changes every definition digest** → D1's version bump, following the existing legacy/policy dual-registration precedent; a parity test asserts prior versions still resolve with unchanged digests, and a workflow pinned to a prior version still dispatches.
- **`actions()` delegation drops an action** — a dropped action is silent, the workflow simply stalls with no offered button → parity test enumerating the action list for every step × every definition id against values captured before the change, including both former `core.wiki-approval` branches resolving to the same single declaration.
- **`assignmentInputs` needs context the hook cannot have** → D5 audits before writing; branches that need more stay put and are recorded.
- **This stage touches the engine's hottest function while stage C will move the whole file** → sequencing is deliberate: semantics move first while `runtime.ts` is still one file and the 2605-line oracle applies unchanged, then stage C moves files with semantics already settled. Reversing the order would mean re-doing the oracle twice.

## Migration Plan

Data migration: none for the hook work. The manifest policy bump (D1) registers new definition versions alongside existing ones; no store is rewritten and no pin is changed. A workflow already running continues on its pinned version.

Order: entry guards → arrival semantics → entry effects → developer actions → outside-engine branches → manifest policy version bump. Each stage green before the next.

Rollback: revert. Nothing is persisted or pin-changed until the final policy bump, and that step only *adds* registered versions, so a revert leaves every existing workflow resolvable.

## Open Questions

- Whether `wikiVerificationPayload` should move into the wiki step module or stay an engine helper the step calls. It reads wiki state rather than snapshot state, so it may belong to the wiki boundary rather than the step; decide when the step module is written, it does not change the approach.
- Whether `profiles.ts`'s single `core.research` route check is better served by the step behavior or by D1's manifest policy `requiresReadOnlyResearcher` flag. Both work; the policy flag is likely cleaner since it is a workflow-level rule, but this can be settled during implementation without changing the specs.
