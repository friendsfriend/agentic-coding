## Why

A verification round after a fix re-runs every eligible verifier role, even when
the fix touched one file. On the repaired efficiency baseline
(441.9321 units / 34,711 turns) later rounds already cost 7.198 units against
48.087 units for first rounds — 15 % of a first round's role work for a fix that
usually changed a handful of lines — and a fix that changed nothing at all buys
the same full round. Re-running roles whose files nobody touched cannot produce
a finding, so the round's cost and the developer's wait grow with the size of the
role catalog rather than with the size of the fix.

## What Changes

- **Engine-scoped re-verification.** For a round that follows a fix, the routing
  step selects the verifier roles itself instead of taking the classifier's role
  answers: the roles the previous round's plan assigned to the files the fix
  changed in content, and no other role, plus the engine-owned full-suite role as
  before. The classifier request keeps one question per eligible role plus the
  gate question and is still the round's only external effect; its role answers
  are recorded in `classifierDecisions` but no longer decide a scoped round. The
  gate answer still governs the skip outcome.
- **A bounded minimum fix diff decides whether a domain round opens.**
  `workflow.min_reverification_changed_files` (integer 0..20, default 1) is the
  number of files the fix must have changed in content, ignoring whitespace. A
  fix below it opens the round with no domain verifier — the existing tests-only
  round — and records an `attention` entry naming the below-minimum fix. A fix
  never suppresses a round: the full suite still runs in every round and the
  round budget is unchanged.
- **Fail-safe widening.** No usable previous-round record, an unreadable or
  overflowed delta, or a touched file the previous plan attributed to no role or
  to several roles leaves the round exactly as it is today (classifier-decided,
  full eligible catalog on a classifier outage).
- **Bounded engine state, no new store.** One optional snapshot field
  `verificationScope` carries the round's plan ownership, the changed-file
  content digests the round verified, the fix delta, and the decision.
  `STORE_SCHEMA_VERSION` stays 6; no migration, no compatibility shim.
- **A record of why each role ran or did not.** One `verification_scope` engine
  telemetry event per round reports the mode, the reason, and one reason per
  role in each of the run and skip sets; `triage.plan.selected` gains the source
  `reverification` for a round whose set the engine supplied.

Nothing else changes: the graph, the `core.verification` outcomes, when a
workflow blocks or parks in `attention-required`, and the `verificationRounds`
budget are the same, the full-suite role is never skipped, and definitions that
predate `core.triage-route` keep today's behaviour.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `triage-verifier-routing`: role selection for a round that follows a fix is
  engine-scoped from the previous round's plan ownership and the fix's own delta
  instead of
  classifier-decided, gated by a bounded minimum fix diff, with fail-safe
  widening to today's behaviour; triage still scopes the round's files and can
  only narrow the selection the engine or the classifier locked.
- `classifier-routing-telemetry`: a new `verification_scope` decision record per
  round (mode, reason, per-role run/skip reasons, counts) and the new
  `triage.plan.selected` source `reverification`, under the same bounded,
  content-free, observational-only contract.

## Impact

- `agentic-coding/src/contracts/workflow.ts` and
  `agentic-coding/src/workflow/schema.ts`: one optional bounded
  `verificationScope` field on the snapshot, with the array caps the existing
  bounded records use.
- `agentic-coding/src/workflow/steps/reverification.ts` (new, pure domain): the
  scope decision, the reason vocabulary, and the bounded record builders.
  `steps/{routing,verification,types}.ts`: the routing step applies the decision
  and emits its record, the triage completion records the plan's ownership, and a
  completion may carry the bounded record.
- `agentic-coding/src/workflow/runtime/reverification.ts` (new): the changed-file
  digest baseline and the fix delta, in the runtime layer where file I/O
  belongs. `runtime/engine.ts` captures them at the implementation handoff
  before the writer transaction; `runtime/reducers/agent-handoff.ts` carries them
  into the snapshot; `runtime/kernel.ts` merges the completion's record.
- `agentic-coding/src/workflow/effects.ts` and the shipped
  `pi/herdr-workflow.json`: the new `workflow.min_reverification_changed_files`
  default.
- `agentic-coding/docs/workflow-architecture.md`: the scope decision, its record,
  and the fail-safe list.
- Tests: the routing decision table, the digest/delta helper, a two-round engine
  scenario, the telemetry payload bounds, the config default, and the existing
  round/role payload assertions.
