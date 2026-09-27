# Design

## Context

See `proposal.md` — Why, and `specs/` for the behavior contract. The current
state that shapes this design:

- `core.triage` is an agent step whose registered behavior
  (`src/workflow/steps/verification.ts`) validates the agent's emitted
  `roles`/`assignments` against `TRIAGE_ROLES` (the verifier catalog minus
  `test-verifier`, minus `openspec-verifier` for `no-openspec`) and against the
  engine's changed-file manifest. It returns `step.selectedRoles`, and the
  transition hands its output to `core.verification`, whose `onArrive` reads
  `output.roles` into `selectedRoles`.
- `core.verification`'s `roles()` hook resolves `selectedRoles` when non-empty
  and otherwise falls back to `["quality-verifier"]` (or `["test-verifier"]`
  once the suite has run). `verificationCompletion` launches `test-verifier`
  once per round after the other verifiers report.
- Model-pool classification already exists as two System One passes
  (`core.route-plan`, `core.route-apply`) driven by `classifiers.ts` (pure
  protocol) and `classifier-runner.ts` (I/O). `parseClassifierAnswer` currently
  collapses every non-`choice` answer to a bare `{ type: "noul" }`; the request
  builder only emits `choice` questions. The endpoint and profile
  (`jev-classifier`, System One) are already pinned.
- `model.classify` in `effect-runner.ts` only understands
  `integration: "routing"`; `runtime/reducers/effect-result.ts` funnels a
  completed `model.classify` through `applyClassifierRouting`, which records
  `attention` when the integration is unknown and otherwise applies pool
  selections. `StepBehavior` has `onEffectComplete` but no effect-failure hook,
  and a failed effect sets the workflow to `attention-required`.
- Definition versions are registered in tiers (`registerBuiltins.ts` +
  `definitions/manifest-policy.ts`: legacy, `rounds + 100`, `+200`, `+300`,
  `+400`); new starts resolve `definitionVersionForBehaviorPins` (research:
  `+400`). A manifest whose digest no longer matches a pin fails closed
  ("pinned definition digest unavailable"). `registry.ts`'s
  `LEGACY_STEP_BASELINE` maps step ids for tiers that carry no `stepRefs`.
- `changedFilesInAsync` (`runtime/evidence.ts`) is the async form of the manifest
  the engine feeds triage validation and renders in the triage assignment.

Constraints: no new effect kind, no new model provider, no new dependency; step
knowledge stays in `src/workflow/steps/`; pure domain knowledge stays plain
TypeScript in `classifiers.ts` with I/O in `classifier-runner.ts`.

## Goals / Non-Goals

**Goals:**

- Make *which verifier roles run* a deterministic, cheap classifier decision
  recomputed per verification round, while keeping the agent's per-verifier file
  scoping.
- Keep the classifier's view of the change identical to the manifest the engine
  validates, and bounded.
- Make "no domain verifier is needed" a first-class, valid outcome that still
  runs the full suite.
- Guarantee that a classifier outage degrades to today's behaviour and never
  blocks verification.
- Publish the new graph shape without stranding in-flight workflows.

**Non-Goals:**

- Skipping verification or the full suite entirely (a later reduce/skip-stages
  change).
- Replacing triage's scoping with per-file classifier domain tagging (would drop
  the agent; separate change).
- Classifier-driven routing of developer questions (separate change).
- Changing which model a verifier runs on: `core.verification` still uses the
  classifier-selected model pool from design A.

## Decisions

### 1. A dedicated system step, not a role-selection effect inside triage

`core.triage-route` is a system step (outcomes `complete`/`empty`,
`allowedEffects: ["model.classify"]`, `retryLimit: 3`) placed between
`core.implementation` and `core.triage` in the shared loop. `onEnter` enqueues
one `model.classify` with `{ integration: "triage" }`;
`onEffectComplete` reads the effect data and transitions. Because the step
re-runs every round with a constant attempt of 1, its idempotency key carries
the snapshot revision, not the attempt — a per-attempt key collides from round
2 and the outbox's `INSERT OR IGNORE` would silently drop the effect, stranding
the round at a system step with no run and nothing pending.

*Alternative:* run the classification as an entry effect of `core.triage`
itself. Rejected because a zero-role round must skip triage entirely, and
because a separate step keeps the per-round re-classification visible in the
graph and the dashboard.

### 2. `noul` questions with a 0.5 gate, no baseline

`classifiers.ts` gains a `TRIAGE_INTEGRATION` id, a `TRIAGE_NOUL_FLOOR = 0.5`,
and a `TRIAGE_ROLE_QUESTIONS` table mapping each eligible role to a question id
(`needs_quality_verifier`, `needs_security_verifier`, …) and its `instructions`
text (the role's remit, phrased as a necessity question). One request asks all
eligible roles in parallel; selection is `noul >= 0.5`.

*Alternative:* one `choice` question with role labels as criteria. Rejected: a
single choice cannot express an independent per-role decision, and a
multi-select answer reintroduces a confidence/threshold heuristic the locked
decisions explicitly reject.

*Alternative:* forced baseline (always include `quality-verifier`). Rejected by
decision 1 in the task: a config-only change should be able to select nothing.

### 3. Extend the shared answer parser instead of a second parser

`parseClassifierAnswer` gains the `noul` case: a finite numeric `noul` is
preserved; anything else collapses to a value-less `noul` answer so callers
treat it as unanswered (never as a numeric zero). The request body's question
type widens from `type: "choice"` to a union that also allows
`{ type: "noul", instructions }`. Both the routing and the triage integration
keep sharing one endpoint/profile and one `requestClassifier` helper.

### 4. State = validated manifest + capped diffs, collected by a new pure-ish collector

`classifier-runner.ts` gains a triage state collector that calls
`changedFilesInAsync(snapshot)` (the same observation the engine uses for
triage validation) and renders, per changed file, `git diff` text against
`snapshot.metadata.baseCommit` plus the worktree state. Caps: a per-file diff
cap, a total diff budget mirroring `CLASSIFIER_TOTAL_CAP_BYTES`, and a cap on
how many files are read at all (`CLASSIFIER_FILE_CAP`), so one subprocess per
file cannot stall the drain on a mass rename. The collector walks files in the
manifest's sorted order, truncating per-file text and stopping diff text at the
total cap, but always emitting every path — so truncation is deterministic and
never hides a changed file from the classifier.

Every read is bounded at the source, not after the fact: the git stream is
consumed through a capped reader and the process killed, an untracked file is
read through a fixed-size buffer, and binary content yields no text. Truncation
is byte-accurate (`Buffer`-based) so the charged budget and the emitted text
agree, and each manifest entry is passed to git with `--literal-pathspecs` so a
file literally named `:(glob)**/*` cannot broaden the query to files the
workflow never changed.

*Alternative:* reuse `collectClassifierArtifacts` (OpenSpec artifact reader).
Rejected: the decision is about the code under change, not the plan text, and
the artifact reader is bounded by change id, not by the worktree diff.

*Alternative:* derive paths with `changedFilesIn` (sync). Rejected: the effect
handler is an `Effect`, and the async form is the one the engine already uses
for this manifest.

### 5. Fail open inside the effect handler, attention in the reducer

`StepBehavior` has no effect-failure hook, and a failed `model.classify` effect
would put the workflow into `attention-required` — exactly the blocking
behaviour decision 6 forbids. The triage branch of the `model.classify` handler
therefore catches *any* classifier failure (missing `OPENCODE_API_KEY`, provider
status, unparsable body, unusable answers) and returns a successful result
payload `{ integration: "triage", failOpen: true, reason }`. The step's
`onEffectComplete` sees the fail-open marker and transitions `complete` with no
role constraint; the reducer's triage branch of `applyClassifierRouting` pushes
`reason` onto `snapshot.attention`.

A **partial** answer set is treated the same way. The "Answer without a usable
value" scenario and the fail-open requirement originally conflicted here; the
resolution is that narrowing a verification gate requires a complete, positive
answer set, so a provider that answers one cheap question and truncates the rest
is an outage (full eligible catalog, `attention`) rather than an authoritative
"no domain verifier is needed". A zero-role selection — a legitimate verdict —
is likewise recorded in `attention` so a skipped gate is never silent.

*Alternative:* let the effect fail and handle the failure in a new
`onEffectFailed` hook. Rejected: it is a new engine seam, and after the durable
retry budget is spent the only available states are "block the workflow" or
"strand the step" — neither satisfies fail-open.

*Alternative:* keep `TransientFailure` propagating for provider retries and only
fail open on permanent errors. Rejected: a sustained outage is the realistic
classifier failure and would end in attention-required. Trade-off accepted: a
single transient blip is no longer retried by the outbox for this integration;
the step still declares `retryLimit: 3`, which governs any other effect failure
path.

### 6. Selection reaches triage as arrival state, not as a second output field

`core.triage-route` transitions with output `{ roles: string[] }`
(`{ roles: [] }` for `empty`). `core.triage`'s `onArrive` reads `output.roles`
into `step.selectedRoles` exactly the way `core.verification` already reads its
arriving `output.roles`, and its behavior opts into
`carriesOutputContext` so the rendered triage assignment's step input is the
locked role set. `triageCompletion` validates `output.roles ⊆
snapshot.step.selectedRoles` in addition to today's catalog, duplicate,
assignment-parity, and changed-file checks; when `selectedRoles` is empty (the
fail-open path, or a legacy definition that reaches triage without the routing
step) the catalog check applies alone, i.e. today's behaviour.

*Alternative:* put the selection in `metadata` or re-query the classifier from
triage. Rejected: arrival state is the established mechanism and needs no new
state field.

### 7. Zero roles flows through `core.verification` with an empty selection

The `empty` edge goes to `core.verification` with `{ roles: [] }`, and
`core.verification`'s `roles()` fallback for an empty selection changes from
`["quality-verifier"]` to `["test-verifier"]`. `verificationCompletion` is
unchanged: the auto-launch branch already skips when the completing run *is*
`test-verifier`, so a sole full-suite run transitions to `pass`.

*Alternative:* keep `["quality-verifier"]`. Rejected: it would run a domain
verifier the classifier explicitly declined.

### 8. New definition version tier (`rounds + 500`) for the new graph shape

Adding `core.triage-route` to `COMMON_IMPLEMENTATION_STEPS` and to
`workflowEdges` changes the digest of every registered tier, which would fail
closed for any workflow already pinned to a digest that no longer exists. So:

- `COMMON_IMPLEMENTATION_STEPS` becomes a function of a boolean (or the graph
  builders take an `includeTriageRoute` flag), and `workflowEdges` gains the
  matching parameter, defaulting to the previous shape for the legacy, policy,
  manifest-policy, and behavior-pin tiers.
- A new `definitionVersionForTriageRouting(rounds) = rounds + 500` tier
  registers every family with `stepRefs` (like the `+300`/`+400` tiers) and the
  extended graph.
- `startup.ts` resolves `rounds + 500` for non-research definitions; research
  keeps `rounds + 400` (it has no implementation loop).
- `core.triage-route` is added to `LEGACY_STEP_BASELINE`, so any tier without
  `stepRefs` that references it resolves instead of failing closed.

*Alternative:* mutate all tiers (the `core.route-plan` precedent). Rejected:
in-flight workflows would need an operator migration; the wiki concept
`projects/agentic-coding/workflow-lifecycle` records the opposite precedent —
thread the change behind a parameter so historical tiers keep their graph.

## Risks / Trade-offs

* **The routing step adds latency to every verification round** (one extra
  System One call, typically seconds) → the step is a system step with no agent,
  it runs in parallel with nothing, and its `retryLimit: 3` plus the 300 s
  classifier timeout bound it. If the classifier is slow, the round is slow;
  measured after landing.
- **A wrong `noul` answer silently narrows coverage** → mitigated by 0.5 as the
  only gate, one question per role so answers are independent, by a selection
  being trusted only when *every* question is answered, by a zero-role verdict
  being recorded in `attention`, and by triage still being able to drop (never
  add, never empty) a role.
- **Classifier-directed text inside a change is a new untrusted input to a
  decision gate** → the state is framed as an explicit untrusted JSON corpus
  with a data-not-instruction rule in the request instruction, paths are escaped
  and diffs bounded; the residual risk is that a sufficiently persuasive change
  could still influence the model, which is why an incomplete answer set fails
  open rather than narrowing.
- **The classifier state can mislead on very large changes** (diffs truncated at
  the caps, or no diff text past the file cap) → every path is always present,
  truncation is deterministic in manifest order, and the request says an empty
  diff means "past a read bound", not "unchanged".
- **`noul` parsing is a widening of a shared parser** → `choice` parsing keeps
  its exact behaviour, and the boundary is pinned by tests at the 0.5 threshold.
- **A new version tier increases registry size** (one more manifest family per
  round count) → the tier is registered once per `rounds` like every other tier;
  the repository test suite is the regression check for registration cost.
- **The triage instruction asset changes**, so pinned instruction digests
  change for new workflows → `src/workflow/embedded.generated.ts` is regenerated
  with `bun run build`, never hand-edited, and digests remain presentation pins
  only.

## Migration Plan

1. Implement behind the new step id and the new version tier; no stored state is
   rewritten.
2. Workflows already pinned to an earlier tier keep dispatching against their
   registered definition version and never see `core.triage-route`.
3. New starts resolve `rounds + 500` and run the routing step.
4. Rollback: revert the registration of the new tier; already-started workflows
   pinned to `rounds + 500` then require the same validated migration path the
   engine already provides for a digest that no longer matches.
