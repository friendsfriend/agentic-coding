## Context

`core.implementation` → `core.triage-route` → `core.triage` → `core.verification`
runs once per round, and the `fix` edge from `core.verification` back to
`core.implementation` (bounded by `workflow.max_verification_rounds`,
`loop.maxAttempts`) makes rounds 2..N reach the routing step with the whole
previous round's catalog still available. The routing step asks the classifier
one question per eligible role, the triage agent scopes the selected roles to
changed files, and every selected role runs again — whatever the fix actually
touched. On the repaired efficiency baseline (441.9321 units / 34,711 turns) of
21 round transitions, later rounds cost 7.198 units / 745 turns against 48.087
units / 10,505 turns for round 1 — 15 % of a first round — for fixes that in the
named examples were a handful of lines, and `introduce-local-model-support-for-
classification` re-ran the same seven roles after a 21-minute fix. Roles per
round are ≤ 4 in 88 % of rounds, so the cost is repetition, not breadth.

The engine already holds the fact a narrower decision needs at the moment the
next round opens: `core.triage`'s completion carries the round's plan
(`assignments: [{role, files}]`), and `core.verification`'s arrival stores it as
`step.context` (`carriesOutputContext`), where `verificationRoundTelemetry`
already reads it. A step transition resets that context (`freshStep`), so the
round's ownership survives the transition only if the engine persists it. The
changed-file manifest is likewise already an engine observation
(`changedFilesIn`, the one triage validates plan files against and the classifier
state is built from).

Three structural constraints shape the design. Workflow steps are pure domain
(`src/workflow/steps/**` may not do file or git I/O; enforced by
`test/workflow-source-layer-boundaries.test.ts`), so the scope *decision* belongs
in `steps/` while file reads belong in `runtime/`. The round is not a skipper:
the full-suite verifier role is engine-owned and unconditional, no outcome and no
edge may change, and the round budget must stay exactly what `loop.maxAttempts`
says. And no change may alter when a workflow parks in `attention-required` or
blocks.

Two neighbouring changes are in flight and are deliberately not touched here:
`orientation-budget-and-tool-names` owns the findings-forwarding plumbing and
every prompt asset (`agent-definitions/instructions/triage.md` already tells the
triage agent to drop a role whose files did not change since its last PASS, so no
prompt edit is needed for this change to work), and the `add-stage-*` changes own
the stage catalog. Assumption recorded here rather than asked: the previous
round's findings may or may not be forwarded as run inputs when this lands; the
selection below depends only on ownership, so both cases are supported.

## Goals / Non-Goals

**Goals:**

- A round that follows a fix runs the verifier roles that own the fix's
  substantively changed files and the engine-owned full-suite role — and no
  others, unless the engine cannot attribute a touched file to exactly one role,
  in which case the round is exactly what it is today.
- A fix below a bounded minimum changed-file count does not open a domain round:
  the round runs the engine-owned full suite only.
- Every role's participation is explainable after the fact: a bounded engine
  record plus one telemetry event naming why each role ran or did not.
- No change to `STORE_SCHEMA_VERSION`, no migration, no new store, no new graph
  edge, no new outcome, no change to blocking behaviour, no change to the round
  budget, and the full suite never skipped.

**Non-Goals:**

- Forwarding the previous round's findings as run inputs. That is
  `orientation-budget-and-tool-names`; this change neither adds nor needs it, and
  it keeps working when that change lands.
- Narrowing the classifier *request*. The routing step keeps enqueuing exactly
  one `model.classify` effect with one question per eligible role plus the gate
  question; only the use of the role answers changes. Suppressing the request
  would need a step-completion path that does not exist (a system step's only
  forward path is its effect completion) and would move the gate question out of
  the round.
- Routing around `core.verification`, adding an edge, or adding an outcome.
- Any dashboard, keybind, or modal surface. The record is engine state plus
  telemetry; nothing new is rendered.
- Definition tiers that predate `core.triage-route`
  (`includeTriageRoute: false`): they go straight from implementation to triage
  with no routing step to scope at, so they keep today's behaviour.
- Editing verifier assignment text, triage/verification prompt assets, or the
  classifier question table: all owned by `orientation-budget-and-tool-names`.

## Decisions

### D1. The decision point is the routing step's own completion

`core.triage-route` already owns "which roles run this round" and already has a
`complete` outcome that carries an arrival role set. A scoped round supplies that
outcome's `{roles}` output exactly like a classifier selection does, so
`core.triage`'s locked-set validation, its `Step input` rendering, the assignment
builder, and the verification fan-out are all unchanged.

*Alternatives rejected:* a decision inside `core.triage` (the triage agent would
be asked to enforce a rule the engine can compute, and the zero-role suite-only
round is unreachable from triage); a new `core.reverify` step (a new step id, a
definition digest change, and a second place that knows the role catalog); a
graph edge from implementation to verification (breaks the gate sequence and the
"verification alone decides pass/fix" invariant).

Order inside the completion keeps today's precedence, with the scope inserted
after the gate: an explicit gate `skip` verdict wins unconditionally, a scope
decision applies next, and the classifier's role answers decide only a round the
engine does not scope. On a scoped round the answers are still recorded in
`classifierDecisions` and in `routing.classified` telemetry — they are evidence,
not the decision. A classifier *outage* on a scoped round therefore also no
longer forces the full eligible catalog: the scope is computed from the round's
plan and the fix, neither of which came from the classifier. The gate verdict is
unavailable on an outage exactly as it is today (no skip, an `attention` entry).

### D2. The scope is computed from a persisted record, not re-derived

The engine persists one bounded record and reads it at the next round:

```
verificationScope?: {
  round: number;                                  // the round this plan is for
  plan: { role: string; files: string[] }[];      // that round's ownership
  baseline?: { round: number; complete: boolean;
               files: { path: string; raw: string; normalized: string }[] };
  delta?:    { round: number; complete: boolean; threshold: number;
               files: { path: string; substantive: boolean }[] };
  decision?: { round: number; mode: "first-round" | "scoped" | "suite-only" |
                              "full-set";
               reason: string;
               rerun: { role: string; reason: string }[];
               skipped: { role: string; reason: string }[] };
}
```

`round` and `plan` are written by `core.triage`'s completion (the plan is final
there, and the round index is the same `loopCounts + 1` the round's own telemetry
already computes); `baseline` and `delta` are written by the runtime at the
implementation handoff (and the baseline again, as a fallback, at the triage
handoff — see the implementation notes); `decision` is written by the routing
step.

The three round stamps are what makes a measurement trustworthy, and each names
a different round, because each is written on the far side of the fix:

- `plan.round` = the round the plan belongs to = the last completed round
  (`loopCounts["core.verification:round"]`);
- `delta.round` = the round the fix followed = the same last completed round;
- `baseline.round` = the round the record opens = that round + 1, because the
  baseline captured at the implementation handoff is the *post-fix* tree the
  next round will verify.

The record is usable only when all three stamps line up that way and both the
baseline and the delta are `complete`. That guard also covers a repaired or
repinned workflow whose counters moved, and a loop that re-entered verification
without a fix.

*Alternative rejected:* reconstructing ownership from evidence or from the
`classifierDecisions` history — neither carries file ownership, and both would
make the decision depend on parse order and on truncation. A round that reaches
`core.verification` without triage (the suite-only bypass) writes no plan, so the
next round widens; that is correct and needs no extra state.

### D3. Ownership must be unambiguous, or the round widens

A file is attributed when the previous plan assigned it to exactly one role. For
each substantively touched file the scope selects that role; a touched file that
the plan assigned to *no* role, or to *several* roles, means the plan could not
attribute it, and the round takes today's classifier-decided path (D6). The
union of the attributed roles, in catalog order, is the round's role set.

*Alternatives rejected:* re-running every owner of a shared file (cheaper, and
arguably precise) — it assumes a shared file's review is fully covered by the
roles the triage agent happened to list, which is exactly the assumption the plan
does not support; and a `git log`-based owner inference (git archaeology costs
more than the round it saves and attributes by author, not by review scope).

There is deliberately no "roles that reported findings always re-run" floor: the
measurement is "re-run the roles that own the files the fix touched plus the
engine-owned test-verifier", the previous round's findings reach the round that
does run through the forwarded-findings change, and an extra re-run of a
non-owner role is precisely the repetition this change removes. The trade-off is
recorded under Risks and is visible in the record: the decision's skip list names
`not-owner` for those roles.

### D4. Triage still narrows, and cannot widen

The triage step keeps its existing rule: the arriving selection is a lock, the
plan is a subset of it, and the plan must keep at least one role. An owner role
that the triage agent judges irrelevant can therefore still be dropped — that is
the agent's documented job, it stays visible in the round record (the decision's
`rerun` set versus the plan actually produced) and in `triage.plan.selected`, and
it is why the engine does not need to fail a round over a plausible agent
judgement.

*Alternative rejected:* equality instead of "keep at least one" for an
engine-scoped arrival. A triage agent that legitimately considers an owner role's
file irrelevant would fail the round with a `WorkflowRuntimeError`, turning a
cost optimization into an availability risk.

### D5. A bounded minimum changed-file count decides whether a domain round opens

`workflow.min_reverification_changed_files` (integer 0..20, default 1) is the
number of files the fix must have changed in *content* — whitespace-only changes
excluded, an added or removed file counted as substantive — for the round to
open with owners. Below it the round takes the routing step's existing `empty`
outcome: `core.triage` is bypassed and `core.verification` runs the engine-owned
full-suite role only, exactly as a zero-role classification verdict does today.
The workflow also records an `attention` entry naming the below-minimum fix, so a
round that opens without domain roles after a fix is never silent.

A one-line fix changes one file, so the default of 1 never narrows a real fix.
`0` disables the rule (every round opens with ownership). A value outside 0..20
is refused where the runtime resolves it, with
`min_reverification_changed_files must be an integer from 0 to 20` — fail fast
like `max_verification_rounds` does in `registerBuiltins`, but in the runtime
boundary that reads the knob, since the round budget is the only workflow key
that validation needs.

*Alternatives rejected:* counting changed *lines* (`git diff -w --numstat`) —
needs a git ref for the baseline and breaks on untracked files; a content digest
set is exact, works on untracked files, and one file is the granularity that
matters because ownership is per file. Refusing the round outright (an entry
guard on `core.implementation`) — the round would then never run, and the
workflow would have to block or skip: both are excluded. Re-opening the round
with the previous round's finding roles only — a defensible middle ground, but it
is not "no round" and it re-runs exactly the roles the fix did not satisfy.

### D6. Fail-safe widening is the default when the engine cannot attribute the fix

The round is exactly today's classifier-decided round (unconstrained on a
classifier outage) when any of these holds, with the cause recorded in the
decision:

- no previous-round record, or its `round` is not the last completed round (first
  round, a definition without the routing step, a repaired/repinned workflow, a
  suite-only round that wrote no plan);
- no fix delta, a delta from a different round, or a delta that could not be
  measured (git failure, worktree gone, the digest budget exceeded);
- the previous plan assigns no file;
- a substantively touched file with no owner, or with more than one owner (D3).

Everything unreadable or ambiguous therefore widens, and nothing widens silently.

### D7. The fix delta is measured from content digests of the changed manifest

At every `core.implementation` handoff with outcome `complete` — in
`prepareHandoff`, before the writer transaction, where git/fs I/O is already
legal — the runtime:

1. reads the changed-file manifest (`changedFilesIn`, the engine's validated
   observation) and computes two digests per file: `raw` over its bytes and
   `normalized` over its bytes with all ASCII whitespace removed (binary files,
   detected by a NUL byte in the first 8 KiB, use the raw digest for both);
2. compares it against the stored `baseline`: a path whose `raw` digest differs,
   or that appears or disappears, is touched; one whose `raw` digest differs but
   whose `normalized` digest matches is touched but not substantive;
3. stores the `delta` stamped with the round the fix followed, and replaces the
   `baseline` stamped with the round it opens.

Capture is idempotent per round: a baseline already stamped with the upcoming
round is left untouched, so the `blocked`/`failed` self-loops and a second
handoff of the same step cannot reset the reference the delta was measured
against. Caps: 512 manifest entries, 1 MiB per file, 32 MiB in total; any
overflow marks the record `complete: false`, which widens (D6).

*Alternatives rejected:* `git stash create` + `git diff -w --numstat` (the
`debug-requests.ts` baseline shape) needs a dangling commit ref that `git gc` may
prune between rounds, treats tracked and untracked files differently, and would
require exporting module-private helpers; a digest set is self-describing,
survives gc, and covers untracked files because it reads the engine's own
manifest. Digest content is never persisted: only 16-character hashes and paths
the manifest already carries.

### D8. One bounded optional snapshot field, merged by the existing completion path

The record lives on `WorkflowSnapshot.verificationScope` (optional, exact) and is
mirrored in the Effect Schema struct with the caps the other bounded records use.
It is written from two places: the runtime, through
`PreparedHandoffEvidence.verificationScope` carried by the `agent.handoff`
reducer, and the steps layer, through a new bounded
`CompletionResult.verificationScope` that `applyCompletionResult` validates and
merges. The two writers touch disjoint fields, so the merge is a spread over the
existing record. `STORE_SCHEMA_VERSION` stays 6: the snapshot is one JSON column
and the field is optional, so a snapshot written before the change decodes with
no record and takes the first-round path, and `decodeSnapshot`'s
`onExcessProperty: "preserve"` means a snapshot carrying it still decodes on
older code (rollback).

### D9. The record is bounded, content-free telemetry plus bounded engine state

One new engine telemetry event per round that reaches the decision, emitted from
the routing step's completion next to the gate decision:

```
verification_scope
  herdr.verification.scope.round            number
  herdr.verification.scope.mode             first-round | scoped | suite-only | full-set
  herdr.verification.scope.reason           no-previous-round | owner-touched |
                                            below-minimum-diff |
                                            baseline-unusable | delta-unusable |
                                            no-plan-ownership | unowned-touched-file |
                                            shared-touched-file
  herdr.verification.scope.threshold        number
  herdr.verification.scope.touched.count    number (substantive files)
  herdr.verification.scope.touched.changed  number (all touched files)
  herdr.verification.scope.baseline.count   number
  herdr.verification.scope.roles.rerun      role=reason,role=reason (sorted)
  herdr.verification.scope.roles.skipped    role=reason,role=reason (sorted)
```

Role names come from the nine-role catalog and reasons from a closed vocabulary
(`owner-touched`, `not-owner`), so both lists are bounded by construction; no
path, no file body, and no task text is exported. `triage.plan.selected` gains
the source `reverification` when the round's arriving selection came from the
record, and `reverification-empty` for a below-minimum round whose scope selected
no role — read from the persisted decision, not from the arrival output, so the
`Step input` line the prompt renders stays `{roles}`.

### D10. The threshold travels with the delta, not through the snapshot metadata

The routing step is pure domain and cannot load configuration, and the snapshot
metadata is pinned at start and would need a second pinned key. The runtime
already resolves the config when it measures the delta, so it stamps the
effective threshold into `delta.threshold`; a missing delta widens anyway, so no
other reader needs the number.

## Risks / Trade-offs

- **A stale or pruned baseline silently mis-scopes.** The guard is the round
  stamp plus `complete`: a baseline from another round, a pruned worktree, a git
  failure, or a cap overflow all widen. Worst case is today's behaviour, never a
  silently skipped role. → Covered by the routing decision-table test with a
  wrong-round record and an incomplete delta.
- **A no-op fix can end the loop with findings unresolved.** Below the minimum
  changed-file count the round is suite-only, so a suite that passes ends
  verification without rechecking the previous round's findings. Mitigations: the
  `attention` entry, the `below-minimum-diff` decision record and the
  `reverification-empty` source make the round visible instead of silent, a
  non-empty fix always opens the owning roles, and the default threshold of 1
  means only a genuinely empty fix (or a whitespace-only one) can reach this
  path. Rejected alternatives: blocking the workflow, an entry guard on the
  implementation step, or a new outcome — all excluded by the change's
  constraints.
- **No findings floor, so a finding in an untouched file is only rechecked when
  its owner also owns a touched file.** Accepted (D3) because the requirement is
  to re-run touching owners, and the previous round's findings reach the round
  that does run through the forwarded-findings change. The `verification_scope`
  skip list makes the role that did not run visible.
- **Verifier side effects inflate the delta.** A verifier or test run that writes
  files (coverage artifacts, lockfiles, generated files) makes those paths
  touched and, being unowned or shared, widens the next round. Safe, but it can
  make the optimization invisible on a repo whose suite writes artifacts. → The
  record's `touched.changed` versus `touched.count` and the widening reason make
  this measurable per round instead of a mystery.
- **Digest cost per handoff.** Up to 512 files / 32 MiB read twice per round
  (baseline at the implementation handoff, comparison at the next one). Bounded
  by the caps and paid outside the writer transaction; a handoff that would
  exceed the budget widens rather than reads further.
- **Snapshot growth.** Worst case ≈ 512 paths × (path + 2 × 16-byte digests),
  held under ~50 KiB by the caps; the plan and the decision add at most one entry
  per role.
- **Triage may still drop an owner role.** Accepted (D4) and visible in the
  record and in `triage.plan.selected`.
- **Configured threshold above 1 hides small fixes.** An operator who sets
  `min_reverification_changed_files: 3` accepts that a one-file fix opens no
  domain round; the decision record names `below-minimum-diff` and the threshold,
  so it is diagnosable.
- **Acceptance is the backlog's KPI, not absolute units.** `verifier-rounds`
  reports rounds ≥ 2 as a share of round-1 cost, and `verifier-findings` reports
  accepted findings per round (baseline 54 accepted insights). Restated against
  the repaired denominator — 441.9321 units / 34,711 turns, of which later rounds
  are 7.198 units / 745 turns and round 1 is 48.087 units / 10,505 turns — that
  share already *is* 15 % before this change, so the backlog's "< 25 %" cannot be
  the intended target: it is a stale figure (the pre-repair denominator), and
  read literally it would ask this change to make the share worse. The target
  this change is measured against is therefore stated explicitly: the share must
  not rise above the 15 % baseline while accepted findings per round do not fall.
  Recorded as a figure correction rather than raised as a question, because the
  direction of the intended target is unambiguous from the baseline itself.

## Implementation notes

Recorded after implementing the change, where the shape above met the code.

**The decision is computed in the routing step's `onEffectComplete`, not on
entry.** Only a completion can both persist a record and choose an outcome, and
the classifier's answer (which a widened round still uses) only exists at
completion. On a scoped round the answer is therefore read and then not used for
selection, which keeps D1's "evidence, not the decision" literal.

**The baseline is captured twice.** `core.triage`'s handoff captures the tree the
round is about to verify — nothing but verifier side effects separates it from
the round — and `core.implementation`'s handoff captures the same tree after a
fix as its post-fix stamp. The second capture is what makes the `verify` family
(whose round 1 runs triage, but whose fixes come back through
`core.implementation` in review-fix mode) scope from round 2 without a
definition-specific special case. Both handoffs stamp the round they open, and a
baseline already stamped with the upcoming round is left alone, so the
`blocked`/`failed` self-loops and a repeated handoff of one step cannot reset the
reference the delta was measured against.

**A fix folds into the round's delta, it does not replace it.** A round can hand
off `core.implementation` more than once — a fix, a skipped round, a developer
review, another fix — and the second measurement must not replace the first
fix's files: `unionVerificationDelta` folds a path that either measurement saw as
substantive, keeps a foreign round's delta out, and keeps the union incomplete
when either side is incomplete (an incomplete record widens). The baseline is
still re-stamped to the tree the last handoff left, and the delta is measured
against the reference the first measurement used, so a second fix in one round
window widens the run set instead of narrowing it.

**The roles that reported a round's findings are part of the scope.** The round
that follows a fix exists to resolve that round's findings, so
`core.verification`'s `fix` completion records the roles that reported a critical
finding (`reported: { round, roles }`) and `decideReverification` unions them into
the run set with the reason `findings-reported` — in a scoped round, in a
classifier-decided round, and below the changed-file threshold, where the reported
roles are the only domain roles that run. The engine-owned full-suite role is
excluded from the set, because it is not part of the catalog a scope may name and
it runs regardless. A reported role the definition can no longer launch widens the
round (`reported-role-outside-catalog`) rather than being dropped: silently
running one role fewer is exactly the failure mode the floor exists to prevent.
The floor is what keeps the change honest — a scoped round may re-run fewer roles
than today's classifier round, but never fewer than the ones whose findings were
just addressed.

**Files the engine itself writes are excluded.** The store lives inside the
worktree (`.herdr-workflow/<workflow>/telemetry.jsonl`, run artifacts, evidence),
and those paths change on every step. Counting them as "the fix" would widen
every round and make the optimization invisible, so they are dropped from the
digest set — as paths, never by reading them. `changedFilesIn` still reports them
(they are real working-tree changes), and `triage`'s own changed-file count is
unaffected.

**The threshold is resolved where the delta is measured.** `loadConfig()` is a
runtime boundary, so `runtime/reverification.ts` reads
`workflow.min_reverification_changed_files`, refuses a value outside 0..20 with
`min_reverification_changed_files must be an integer from 0 to 20`, and stamps the
effective number into `delta.threshold`. The pure decision uses an explicitly
supplied threshold first (the routing step passes the stamped one, which is the
same number) and falls back to `delta.threshold` and then to the default of 1, so
the decision table is total without a configuration read.

**Two small engine seams were added rather than reusing something adjacent.**
`EffectCompletionContext.definitionId` (the routing step reads its eligible role
catalog from the pinned definition's family traits through the existing
`triageRolesFor`, so there is no second role table); and
`CompletionResult.attention` (appended, redacted, through the same
`applyCompletionResult` path as the rest of a completion), because a below-minimum
round and a scoped round that continued without the classifier both have to be
audible without a new status surface.

**A scoped round that continues without the classifier is audible.** A classifier
outage on a scoped or suite-only round no longer forces the full eligible catalog
(D1), which is a strictly smaller round than today's, so the completion appends an
`attention` entry naming the mode and the reason. The gate verdict is unavailable
on such an outage exactly as today.

**The record is merged field by field, and each writer writes only its own
fields.** The runtime's handoff evidence is merged into the snapshot before the
step's own completion, and `applyCompletionResult` merges the completion's record
over it one field at a time, so the triage handoff (plan, reported roles) and the
routing completion (decision) cannot erase the runtime's baseline and delta or
each other's work. The handoff merge is restricted to the two fields a handoff
observes — `baseline` and `delta` — because a spread of the whole observed record
would let a handoff that measured nothing overwrite a plan a step had already
written. The plan is therefore written *always*, including when its caps force it
to be empty: an omitted field would keep the previous round's ownership under
this round's stamp, while an empty one widens the next round
(`no-plan-ownership`). Every field is shape-checked at that boundary, so a
malformed record is a `reducer-contract` failure rather than a snapshot that
later widens for the wrong reason.

**The measurement reads only bounded, contained regular files.** A changed-file
manifest is git's view of a worktree agents write, so a path in it is untrusted:
`digestFile` resolves the real path and refuses anything outside the worktree (an
untracked symlink to `~/.ssh/id_rsa` is a manifest entry like any other), refuses
anything that is not a regular file (a FIFO or `/dev/zero` never reaches EOF),
and applies the 1 MiB per-file cap before the read. A refusal makes the whole
observation unmeasurable, which widens the round — never a failed handoff and
never a read of something outside the worktree. Whitespace normalization is one
pass into one scratch buffer and one hash, not one hash update per byte.

**A deletion is a change, and the record can express it.** A path the baseline
holds and the tree no longer does is a substantive fix, and omission could not say
so: the observation records it with a reserved digest pair of all zeros, which no
real sha256 prefix reaches. A path neither tree holds is equal, so an
already-absent file is not a change. A manifest or plan path longer than the
record's 1024-byte path bound is unmeasurable rather than written: the record
never carries what its own reader would refuse, so the round widens instead of the
handoff failing.

**Digest-of-low-entropy-content is an accepted risk.** `raw`/`normalized` are
sha256 prefixes of the file's bytes, so a file whose content is a secret could in
principle be confirmed by an attacker who can read the snapshot record and guess
candidates (the record stores a 16-hex-character prefix of a hash of the bytes,
plus the same prefix over the whitespace-stripped bytes). The record lives in the
workflow's own store inside the worktree, is never exported in telemetry (only
counts and role names are), and the alternative — a keyed digest — would need a
key the engine does not have and a second trust boundary. It is recorded here as
a deliberate, bounded exposure rather than an oversight.

**Prior-round findings forwarding is absent on this branch, and nothing here
needs it.** The verification round's `fix` output carries the round's findings to
`core.findings-review`, and the developer's selected comments are what
`core.implementation` receives; nothing forwards a round's findings into the next
round's verifier inputs (`orientation-budget-and-tool-names` owns that). The
selection here depends only on ownership, so it lands before, after, or without
that change — no tentative plumbing was added, because a second forwarding path
would collide with the one that change is building.

## Migration Plan

No data migration and no compatibility shim: the field is optional, absent on
every snapshot already on disk, and a workflow mid-flight reaches its next round
with no record and is decided exactly as it was before this change — mode
`first-round`, reason `no-previous-round`, classifier-decided. A round that does
reach the step with a record it cannot act on — one stamped for another round, or
one whose plan, baseline, or delta is unusable — widens to the full set
(`full-set`) and is classifier-decided too. The narrowing only happens from the
first round after a record this change wrote, if any. Rollback is a revert of one commit: the snapshot decodes with
`onExcessProperty: "preserve"`, and the record influences nothing outside the
routing decision. There is no deploy step, no backfill, and no operator action.

## Open Questions

None blocking. Two deferred items are recorded here so they are not
rediscovered:

- Narrowing the classifier request itself (asking only the scoped role
  questions, or skipping the request when the definition has no gates) would
  remove the per-round classification cost. It needs a routing step that can
  advance without a completion effect, which is a graph/engine change of its own.
- A dashboard surface for the decision (which roles ran why) is a TUI change with
  a keybind-catalog consequence; this change ships the state and the event, and a
  later surface can read them without another schema change.
