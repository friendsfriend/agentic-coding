## 1. Bounded engine state

- [x] 1.1 Add `WorkflowSnapshot.verificationScope` to
  `src/contracts/workflow.ts`: the round index, the plan's `{role, files}[]`
  ownership, the digest `baseline`, the `delta`, and the `decision`.
- [x] 1.2 Mirror it in `src/workflow/schema.ts` as an exact optional struct with
  the caps the other bounded records use (512 plan paths, 512 baseline and delta
  entries, 16-character digests, 9 roles), so a snapshot written before this
  change decodes unchanged and one that carries it re-decodes.
- [x] 1.3 Let a step completion carry the record
  (`CompletionResult.verificationScope` in `src/workflow/steps/types.ts`) and
  merge it in `applyCompletionResult` (`src/workflow/runtime/kernel.ts`) with the
  reducer-contract validation the other completion fields get, merged field by
  field so the runtime's baseline and delta survive a triage completion.

## 2. The scope decision (pure domain)

- [x] 2.1 `src/workflow/steps/reverification.ts`: one exported decision function
  over plain facts (eligible roles, last completed round, the record, the
  threshold) returning the mode (`first-round`, `scoped`, `suite-only`,
  `full-set`), the reason, the run set, and the skip set, each role carrying a
  reason from a closed vocabulary (`owner-touched`, `not-owner`), plus the
  bounded record builders and caps. No file, git, or config access.
- [x] 2.2 Cover the decision table in `test/workflow-steps.test.ts` (or a focused
  sibling; done in `test/workflow-reverification.test.ts`): first round, one owner, several owners, a touched file with no owner,
  a touched file with several owners, a below-threshold fix, every widening
  reason (wrong round, unusable baseline, unusable delta, empty plan, truncated
  plan), a whitespace-only change, and the threshold `0`.

## 3. The routing step applies it

- [x] 3.1 Extend `core.triage-route`'s behavior
  (`src/workflow/steps/routing.ts`): compute the decision in the completion — the
  only place that can both persist a record and choose an outcome, and the only
  place the classifier's answer exists — persist it on the snapshot, keep the one
  `model.classify` effect, and apply the decision after the gate verdict and
  before the classifier's role answers — `scoped` completes with the scope's `{roles}`, `suite-only`
  takes the existing `empty` outcome plus an `attention` entry naming the
  below-minimum fix, and `full-set`/`first-round` keep today's path.
- [x] 3.2 Emit the `verification_scope` event from that completion with the mode,
  the reason, the threshold, the touched/baseline counts, and the sorted
  `role=reason` run and skip lists, next to the existing gate decision.
- [x] 3.3 Report `herdr.triage.source` as `reverification` when the arriving
  selection came from the persisted decision and `reverification-empty` for a
  below-minimum round, leaving the arrival output shape `{roles}` so the rendered
  `Step input` line does not change.

## 4. Recording plan ownership

- [x] 4.1 `core.triage`'s completion (`src/workflow/steps/verification.ts`)
  records the round index and the plan's role→files ownership, bounded by the
  caps, so the next round's scope survives the transition that resets the step
  context. A round that bypasses triage writes no plan and therefore widens.

## 5. The fix delta (runtime)

- [x] 5.1 `src/workflow/runtime/reverification.ts`: the changed-manifest digest
  capture (`raw` plus whitespace-stripped `normalized`, binary by NUL byte, 512
  entries / 1 MiB per file / 32 MiB total) and the delta comparison (touched,
  substantive, added, removed), both returning a `complete` flag instead of
  throwing; keep the file-system calls in this runtime module.
- [x] 5.2 Capture at the `core.implementation` handoff in
  `src/workflow/runtime/engine.ts prepareHandoff` when the outcome is `complete`,
  before the writer transaction: read the manifest, compare against the stored
  baseline, stamp the delta with the round the fix followed, replace the baseline
  with the round it opens, and leave the record untouched when the baseline is
  already stamped with that round (so the `blocked`/`failed` self-loops and a
  second handoff of the same step cannot reset the reference).
- [x] 5.3 Carry it through `PreparedHandoffEvidence`
  (`src/workflow/runtime/reducers/agent-handoff.ts`) into the snapshot before the
  completion is applied; a capture failure records an incomplete delta and never
  fails the handoff.
- [x] 5.4 Resolve and validate `workflow.min_reverification_changed_files`
  (integer 0..20, default 1) where the delta is measured, with a refusal message
  naming the key; add the default to `DEFAULT_CONFIG`
  (`src/workflow/effects.ts`) and to the shipped `pi/herdr-workflow.json`, and
  cover the default, an explicit value, `0`, and an out-of-range value.

## 6. Docs

- [x] 6.1 `docs/workflow-architecture.md`: the scope decision point, the record's
  fields and caps, the widening list, the below-minimum round and its `attention`
  entry, the `verification_scope` event, and the
  `reverification`/`reverification-empty` sources — as engine state and
  telemetry only, with no new keybind or dashboard surface.

## 7. Verification

- [x] 7.1 Engine test: a two-round workflow where round 1 plans two roles and the
  fix touches one of them — round 2 launches that role plus the engine-owned
  suite and nothing else; a second case where the untouched role does not run but
  is recorded as `not-owner`; a third where a touched file with no owner or
  several owners widens the round to the classifier's selection; a fourth where a
  whitespace-only fix gives a suite-only round with an `attention` entry.
- [x] 7.2 Snapshot/store tests: a snapshot without the field decodes and takes
  the first-round path, a snapshot with the field round-trips, and a record
  beyond the caps is refused by the schema rather than stored truncated.
- [x] 7.3 Telemetry test: the `verification_scope` payload for a scoped round, a
  widened round, and a below-minimum round exports no path and no body, and the
  `triage.plan.selected` source for an engine-scoped selection and for a
  below-minimum round.
- [x] 7.4 Update the existing assertions that read the round/role payloads and
  the snapshot record: `test/workflow-verify.test.ts` (the multi-round round and
  every widened/no-op case), `test/workflow-e2e.test.ts` (the second round
  re-enters the routing step and scopes to the fix's owner),
  `test/workflow-effect-foundation.test.ts` (the snapshot record round-trips and
  its caps hold), and `test/workflow-steps.test.ts` (the triage plan's new
  persistence shape). The default config value is asserted in
  `test/workflow-reverification.test.ts` against `DEFAULT_CONFIG`, so no config
  fixture needed a new key.
- [x] 7.5 `bun run type-check` 0 errors, `bun run test` passes, `bun run lint`
  clean, `openspec validate role-scoped-reverification --strict` and
  `openspec validate --changes --strict` pass, and `git status --short` is empty.

## 8. Review-round fixes (verifier findings)

- [x] 8.1 The reported-role floor: `core.verification`'s `fix` completion records
  the roles that reported the round's critical findings, `decideReverification`
  unions them into every mode's run set with the reason `findings-reported`, and a
  reported role outside the eligible catalog widens the round
  (`reported-role-outside-catalog`). The engine-owned full-suite role is excluded.
- [x] 8.2 Bounded, contained reads in `runtime/reverification.ts`: real-path
  containment under the worktree, regular-file check, per-file cap before the
  read, one-pass whitespace normalization; any refusal is an unmeasurable
  observation that widens the round. Symlink, non-regular-file, oversize, and
  over-long-path cases are covered in `test/workflow-reverification.test.ts`.
- [x] 8.3 Deletions are substantive: a path the baseline held and the tree no
  longer has is recorded with a reserved all-zero digest pair, so a deletion-only
  fix widens instead of reading as "nothing changed", and an already-absent path
  reads as unchanged.
- [x] 8.4 A plan the record cannot hold is written as an empty plan rather than an
  omitted field, and the handoff merge is restricted to `baseline`/`delta`, so an
  unrecordable plan clears the previous round's ownership instead of leaving it
  under the new round's stamp.
- [x] 8.5 A second fix in one round window folds into the round's delta (union of
  the substantive paths) instead of discarding the first fix's measurement, and
  the second measurement uses the reference its first measurement used.
- [x] 8.6 The engine reuses the `core.triage` manifest read it already made
  instead of spawning git a third time, and resolves the threshold only on the
  branch that measures a delta.
- [x] 8.7 Tests for every branch above: the floor in each mode, the reported-role
  widening, both deletion directions, the contained/bounded reads, the over-long
  path, the plan cap, the second-fix union, the threshold's default/explicit/`0`
  and out-of-range refusal, the two-role engine round, the unowned-file and
  shared-file widenings, and the scoped-round outage entry.
- [x] 8.8 Specs and docs: the floor requirement, the measurement-bounding
  requirement, the KPI acceptance requirement, the new reason vocabulary, and the
  implementation notes (including the accepted digest-of-low-entropy-content risk
  and the corrected migration note) are recorded in
  `specs/triage-verifier-routing/spec.md`,
  `specs/classifier-routing-telemetry/spec.md`, and `design.md`.
