# Design

## Context

See `proposal.md` for the motivation. The state this design builds on:

- **The classifier is already a `model.classify` integration with two shapes.**
  `ROUTING_INTEGRATION` (model pools) and `TRIAGE_INTEGRATION` (verifier roles)
  share one `requestClassifier` helper, one pinned `jev-classifier` profile, and
  one System One endpoint. A `noul` answer carries a necessity value and no
  confidence; `TRIAGE_NOUL_FLOOR = 0.5` is already the only inclusion
  threshold. `classifiers.ts` is the pure protocol, `classifier-runner.ts` the
  bounded I/O, `effect-runner.ts` the effect dispatch, and
  `runtime/reducers/effect-result.ts` the only durable writer of workflow facts.
- **`core.triage-route` is already the per-round system step between
  `core.implementation` and `core.triage`**, registered in its own definition
  tier (`rounds + 500`) so a graph change never mutates an earlier tier. Its
  outcomes are `complete` (carry roles) and `empty` (zero roles, still run the
  full suite). `assertStepBehaviorCoverage` requires a behavior for every step a
  registered definition contains, and `LEGACY_STEP_BASELINE` maps the new step
  for tiers without exact step references.
- **Every failure of the triage integration resolves to a successful fail-open
  result** because `StepBehavior` has no effect-failure hook: a failed effect
  would strand the workflow in attention-required.
- **Audit already has a shape to copy.** `ClassifierDecisionRecord` is a bounded
  optional snapshot field decoded by `schema.ts`, carried by all four `view()`
  return paths, forwarded by `viewToDashboardState`, and rendered by the
  dashboard's conditional Classifier panel. `snapshot.attention` is the other
  established surfacing channel, and it is health, not a blocking status.
- **Config** is layered `agents` in `config.json`. `parseAgentsConfig` copies a
  known key set, `validatePresets` validates each preset and rejects a custom
  preset with no pools, `resolvePreset` produces the `RoutingPreset` a run uses,
  and the reserved `use-default-model` preset may configure only `runtime`.
- **Effect emission.** A step may enqueue only its `allowedEffects`, enforced in
  `kernel.ts` for both `onEnter` and completion results. The durable way to raise
  a notification is the `notification.show` effect; `port.notify` is the port
  call that effect executes. Telemetry is emitted through
  `adapterTelemetryEnvelope` + `telemetrySink` at the effect-runner boundary and
  is explicitly observational.
- **The settings preset editor** is a pure form domain (`agentPresets.ts`:
  field catalog, draft, values, validation, mutation) rendered by
  `AgentPresetsView.tsx` over the shared `text`/`select`/`action` field kinds.
  Preset save replaces the whole preset object, so unedited fields must be
  carried through the draft.

## Goals / Non-Goals

**Goals:**

- One uniform gate mechanism that reuses the existing classifier phase pattern,
  threshold, state-collection bounds, and fail-open shape.
- Every gate is a decision with a durable record, and a skip is observable in
  status, the dashboard, a notification, and telemetry.
- Behavior for a configuration that declares nothing is byte-identical to
  today's stage sequence: every gate is `always`, forces a run, and routes into
  its stage.
- No in-flight workflow is disturbed: the graph change ships in a new
  definition version tier.

**Non-Goals:**

- Gating `core.archive`, per-turn effort escalation, classifier-driven question
  routing, and per-step model selection (that remains the model pools' job).
- Combining the developer-review and wiki decisions into one classifier call.
- Any change to the classifier model, profile, endpoint, or the `ClassifierAnswer`
  parse contract beyond what the gate integration already needs.

## Decisions

### D1. Gate policy lives on the preset, with a global table, resolved once per run

`PresetConfig.gates?: Record<GateStage, GatePolicy>` and
`AgentsConfig.gates?: Record<GateStage, GatePolicy>`;
`GatePolicy = "always" | "auto"`. The stage vocabulary (`GATE_STAGES`,
`GATE_POLICIES`, `GATE_QUESTIONS`) is pure protocol and lives in
`classifiers.ts`, which `profiles.ts` already imports for `PoolEntry` — this
keeps the existing domain edge instead of creating a new one. `profiles.ts` owns
the config types, `validateGates` (rejects an unknown stage or a value outside
the vocabulary with the stage and value named), the `parseAgentsConfig` copy of
the global table, and `resolveGatePolicies(agents, presetName): Record<GateStage,
GatePolicy>` which returns preset entry → global entry → `"always"`.

The resolved table is **pinned at start** into `snapshot.metadata.gatePolicies`
beside `selectedPreset` and `executionSettings`, and classification reads only
that table. Resolving it live from the config document at each decision would
have let a user edit `agents.gates` between rounds and change what an in-flight
workflow is allowed to skip, which the spec forbids. A snapshot with no pinned
table (a pre-gate workflow already on disk) resolves from the configuration, and
an unreadable or invalid document falls back to `always` for every stage, so no
failure can widen a gate.

*Alternative considered:* a single global `agents.gates` with no preset
override. Rejected: the user asked for per-preset control, and a preset is the
only place the rest of the routing vocabulary lives.

### D2. The graph change ships in a new definition version tier

`definitionVersionForStageGates(rounds) = rounds + 600` in
`manifest-policy.ts`, registered in `registerBuiltins.ts` for the same families
the triage tier registers (`openspec`, `openspec-apply`, `openspec-propose`,
`openspec-fusion`, `openspec-fusion-propose`, `no-openspec`, `wiki`) with
`wikiGate: true, wikiBeforeArchive: true`, exact `stepRefs`, and manifest policy
as today. `startup.ts` resolves this tier for non-research starts, importing the
function from `./definitions/manifest-policy.ts` directly (as it already does for
`definitionVersionForResearchTools`) so the `definitions.ts` barrel and its frozen
export-surface fixture stay untouched. The three new step ids join
`LEGACY_STEP_BASELINE`.

The graph builders take a new `stageGates` boolean alongside the existing
`includeTriageRoute` flag, and `workflowEdges` grows one more positional flag;
every earlier tier passes the default and therefore registers byte-identical
manifests. The verification gate rides on the existing `core.triage-route` step,
so no new flag is needed for it beyond what the tier already threads.

*Alternative considered:* mutate the `rounds + 500` tier. Rejected by the
repo's documented rule — a digest spreads the whole manifest, so editing a
registered version silently strands every workflow pinned to it.

### D3. The gate topology and its skip targets

Gate steps are added exactly where the guarded stage exists, and every skip
target is the guarded stage's own approval/completion target, so a skip is
shape-identical to an approval:

```
core.plan ──complete──▶ core.plan-gate ──run──▶ core.plan-approval ──approve──▶ (route-apply | completed)
                                 └──skip────────▶ (route-apply | completed)

core.verification ──pass──▶ core.review-gate ──run──▶ core.developer-review
                                     └──skip──────────▶ core.wiki-gate        (no wiki gate: archive/delivery)
core.developer-review ──approve──▶ core.wiki-gate   (no wiki gate: archive/delivery)
core.wiki-gate ──run──▶ core.wiki ──▶ core.wiki-approval ──▶ core.archive ──▶ core.delivery
             └──skip──▶ core.archive   (no archive: core.delivery)
```

`workflowEdges` already derives the tail target (`approved`) from
`archive`/`wikiGate`/`wikiBeforeArchive`; the gate builders derive the same
target once and reuse it for `core.developer-review approve` and the review
gate's skip, so the two cannot diverge. `core.wiki-gate` is only added when
`wikiGate`; the plan gate is only added by the graph builders (openspec,
fusion) that own a `core.plan-approval` step, because only they know the
approval target. `core.archive` gains no incoming gate edge.

**Scope of the gates.** The gates guard the *implementation-loop* families
(`openspec`, `openspec-apply`, `openspec-propose`, `openspec-fusion`,
`openspec-fusion-propose`, `no-openspec`). The `wiki` and `wiki-comments`
families are registered unchanged in the new tier: their `core.wiki` step is the
whole workflow, and a wiki gate in front of it would have nothing to fall
through to, while the gate's evidence (a plan and a changed-file corpus) does not
exist in a documentation-only run. `research` has no gated stage either. The
`wiki` policy in configuration therefore applies to the wiki step of an
implementation-loop family, not to the standalone wiki workflow.

### D4. One shared behavior factory for the three gate steps

`src/workflow/steps/gates.ts` exports `gateBehaviors` with one entry per gate
step. Each is the existing `routingBehavior` shape generalized: `onEnter`
enqueues one `model.classify` with `{ integration: GATE_INTEGRATION, stage }`;
`onEffectComplete` maps the decided outcome to `run`/`skip`. An unrecognized or
missing result resolves to `run` — a system step must always transition. The
three steps are registered in `definitions/steps.ts` with
`allowedEffects: ["model.classify"]`, `retryLimit: 3`, actor `system`, no
instruction assets, and no input/output contract, and wired through
`steps/index.ts`.

*Alternative considered:* one `stage-gate` step reused for all three stages with
the stage in the edge. Rejected: the three gates sit in different positions with
different skip targets, and a step id that appears three times in one step list
is not expressible in the manifest model.

### D5. Effect idempotency keys carry the snapshot revision

Every gate key is `gate:<workflowId>:<stage>:<currentStep>:<snapshot.revision>`
(and the triage key keeps its `triage:` prefix plus the revision). The outbox
uses `INSERT OR IGNORE`, so a per-attempt key collides on the second visit and
silently strands the step with no run and nothing pending. This is exactly the
defect `core.triage-route` already documents, and the review gate has the same
shape because verification loops back to implementation and re-enters it every
round.

### D6. The `gate` integration is a new payload on the existing effect kind

`{ integration: "gate", stage }` on `model.classify`; no new effect kind, no
change to `EffectKind`, `registerBuiltins`' effect list, or the store's effect
table. The `model.classify` handler dispatches the triage integration first
(unchanged), then the gate integration, and fails with the same
`unknown model.classify integration` diagnostic for anything else. The result
payload is
`{ integration, stage, policy, decision: "run" | "skip", noul?, forced, model?, state? }`.

The reducer branches on `integration === GATE_INTEGRATION` next to the existing
triage branch, records the decision, and returns before the pool-routing path,
so the pinned model routing is never touched by a gate. A record whose
`decision` is `skip`, **or** whose `reason` is present, appends an `attention`
entry: a forced run because the decision *failed* must be as audible as a skip,
while a locally-decided `always` run and an answered run carry no reason and stay
attention-free. The stage is derived from `snapshot.currentStep`, not from the
effect payload, so a payload naming a different stage is an unusable decision that
forces the run with a reason rather than letting one stage's question and policy
decide another.

### D7. `always` is decided locally, `auto` asks one question

Under `always` the runner returns a forced `run` for the stage and performs no
HTTP request — one fewer round trip than today for every gated stage, and the
only cost of the default configuration. Under `auto` it builds the single
`noul` question for the stage and reuses `requestClassifier` with the same
profile, endpoint, timeout, and framing rules as the other integrations.

The stage question texts are fixed constants in `classifiers.ts`
(`GATE_QUESTIONS`): plan approval asks whether a developer should review and
approve the plan before implementation, developer review asks whether a developer
should review the change before it is archived and delivered, and wiki asks
whether the change requires a wiki documentation update. The verification gate's
question — whether the change requires independent verification before it is
archived — belongs to the triage request (D8), not to the gate integration.

### D8. The verification gate is one question inside the existing triage request

`core.triage-route` keeps its single request. Under `auto` the request carries the
eligible role questions **and** the `needs_verification` question; under `always`
the gate question is simply not added and the round's continuing outcome is
taken without asking. The result payload gains the gate verdict alongside the
roles, and `triageRouteCompletion` resolves in a fixed order:

1. gate decision `skip` → `skip-verification` (regardless of roles);
2. fail-open or unusable gate answer → forced `run` → `complete`/`empty` as today,
   with the fail-open reason recorded as attention;
   the same complete-answer rule also guards the gate itself: a response that
   does not answer *every* question the round asked is a truncated outage, not a
   verdict, so it can never produce a `skip`. Without that rule a response
   answering only `needs_verification` would skip triage *and* verification while
   omitting the security verifier — strictly less verification from a less
   complete answer, the inversion the role selector exists to prevent;
3. otherwise roles non-empty → `complete` with `{ roles }`; empty → `empty`.

The zero-role path stays a *reduction* (full suite only), never a skip, which is
what keeps "gated down" and "gated off" distinguishable in the audit record.

### D9. The threshold is the existing necessity floor

Gate decisions use `TRIAGE_NOUL_FLOOR` (0.5) — the same constant — through one
`selectGateDecision(stage, policy, answer)` pure function: `run` at or above the
floor, `skip` strictly below, `forced: true` with no `noul` when the policy is
`always` or the answer carries no usable value. No confidence field is consulted
because a `noul` answer has none; adding a second threshold would create a
second thing to tune for no additional signal.

### D10. Fail-open is a successful forced run, never a skip

Every failure mode of the gate integration (missing `OPENCODE_API_KEY`, provider
status, unparsable body, an answer with no usable value, even an unreadable
worktree) resolves to a **successful** result with `decision: "run"` and
`forced: true`, plus the reason. The alternative — failing the effect — is
forbidden by the same constraint B4 documented: a failed effect puts the
workflow into attention-required, which is precisely the blocking behavior a
gate must never cause. The reducer records the reason as an `attention` entry.

### D11. The skip-both safeguard is structural, not a rule in code

No code checks "are both gates auto?". The graph produces it: the only edge out
of a `skip-verification` outcome is into `core.review-gate`, and the review gate
skips only when the developer-review policy is `auto`. A test asserts the
developer-review stage is entered for a verification skip under
`developerReview: always`; there is deliberately no branch that could route a
skipped verification straight to the wiki gate or archive.

### D12. A skip is announced from the effect boundary, recorded in the reducer

The gate step's `allowedEffects` is locked to `["model.classify"]`, so the step
may not enqueue `notification.show` — `kernel.ts` rejects a forbidden effect kind
from a completion result. The skip is already known where the classification
returns, so the `model.classify` handler calls the same `port.notify` boundary
the `notification.show` effect calls and emits a `gate.skip` telemetry event
through the existing envelope/sink. Both are best-effort and swallowed, exactly
like the routing telemetry. The *durable* record is the reducer's, and it is the
guarantee that a skip is never silent.

### D13. The audit record is a new bounded `gateDecisions` list, not step context

`gateDecisions?: GateDecisionRecord[]` is added as an optional snapshot field
alongside `classifierDecisions`, with its own record-count and aggregate-size
bounds and `schema.ts` decoding, `view()` pass-through on all four paths,
`viewToDashboardState` forwarding, and reducer-side append that shifts the
oldest record first inside an empty `catch` (recording is diagnostic; it must
never fail the effect). Each record carries `id`, `at`, `stepId`, `stage`,
`policy`, `decision`, `forced`, optional `noul`, and an optional `reason`.

*Alternatives considered:*
- *Only `snapshot.attention` strings.* Rejected: `attention` is unbounded free
  text, cannot answer "which stage, which policy, which value", and is the
  wrong channel for a routine `always` decision.
- *Reuse `ClassifierDecisionRecord` with `integration: "gate"`.* Rejected: its
  `options: { label, profile }` and `result.profiles` vocabulary is model-pool
  shaped; a gate has neither, and forcing it in would make the panel render
  empty option tables.
- *`snapshot.step.context`.* Rejected: the step is reset on every arrival, and
  the four gates are four different steps — the record would not survive to
  status or the dashboard.

Every skip additionally appends an `attention` entry naming the stage, mirroring
B4's zero-role attention, which is what makes `workflow status` show it without
any new status surface.

### D14. Stage state is assembled from the stage's own bounded material

- `planApproval` → the change's planning artifacts through the existing
  `collectClassifierArtifacts` collector and the routing state envelope.
- `verification` → the existing `collectTriageClassifierState` (task, plan
  summary, engine manifest, capped diffs) — no new collector.
- `developerReview` → the capped changed-file diffs plus the round's verification
  results. The results reach the gate through the mechanism the registry already
  owns: `verificationCompletion` puts the round's own bounded `step.results` on
  the `pass` transition output, and the review gate's `onArrive` adopts it as
  `arrival.results` (steps declare their own arrival state; `snapshot.step` is
  already fresh when the hook runs). That array is one entry per verifier role in
  the round and is not the workflow's evidence list; the collector reduces it to
  `{ role, critical }` before it reaches the classifier, so no finding body, no
  evidence, and no output digest is ever sent.
- `wiki` → the plan summary plus the changed-file path list, with no diff text,
  because "does this need a wiki update" is a question about shape, not diffs.

All reused collectors keep their caps (`CLASSIFIER_ARTIFACT_CAP_BYTES`,
`CLASSIFIER_DIFF_CAP_BYTES`, `CLASSIFIER_TOTAL_CAP_BYTES`,
`CLASSIFIER_FILE_CAP`), their `--literal-pathspecs` handling, and their
list-every-path truncation rule.

`renderGateState` puts **every** repository-controlled string — the task, the
change id, the plan summary, the artifact bodies, the paths, and the diffs —
inside one JSON envelope introduced by a "this is untrusted data" preamble line.
The task and the plan summary are as repository-controlled as a diff, and a gate
decides whether a human ever sees the change, so none of them may sit in the
instruction area where a newline could start a line that reads as
engine-authored. `renderTriageState` predates this and still interpolates the
plan summary into its header; that is left alone here because narrowing a role
set is guarded by the complete-answer rule in `selectTriageRoles`, while a gate
decides a skip directly. Closing it is follow-up work on the triage renderer, not
part of this change.

### D15. The Settings editor adds four selects and no new field kind

`agentPresets.ts` gains a `GATE_EDITOR_STAGES` display list and
`gateItemsKey(stage)`-style field keys; `presetFields` appends one
`{ kind: "select", options: ["always", "auto"] }` per stage after the pool
fields, and `PresetDraft.gates` round-trips `gates` through
`presetDraft` / `draftValues` / `applyDraftValue` / `presetMutation` so an
unstaged value is preserved verbatim like `steps` and `roles` already are. A
stage the draft does not set is shown as its resolved default (`always`) and is
not persisted unless the user changes it.

*Alternative considered:* a new `multiselect` or segmented field kind. Rejected
by the task's own constraint and by the renderer's key dispatch.

## Risks / Trade-offs

- **A skip notification is not durable.** It is raised at the effect boundary
  outside the outbox, so a crash between the decision and the notification loses
  the notification. → The reducer's bounded record plus the `attention` entry is
  the guarantee; a lost notification cannot lose the decision.
- **Under `always`, a gated stage gains one extra system step per round.** The
  graph is no longer byte-identical for new workflows, so step timings, tab
  activity, and the step list shown in the dashboard differ slightly for the same
  work. → It is a local short-circuit with no HTTP request, and the audit record
  makes the extra step legible rather than mysterious.
- **The `developerReview` state depends on the verification transition carrying a
  summary.** If a future change alters the pass transition's output, the review
  gate silently sees no results and the classifier decides with less context. →
  The review gate's behavior declares the adoption, and a test asserts the
  summary reaches the classifier state.
- **Four new decisions per run add snapshot growth.** → The record list has its
  own count and byte bound and shifts the oldest records; a recording failure
  never fails the effect.
- **A `noul` classifier is a weak instrument for "is a human needed".** It may
  confidently say no on a change that a human would want to see. → `always` is
  the default everywhere, a skip is never silent, and the wiki and verification
  gates keep the most consequential stages (`archive`) or their mandatory
  fallbacks.
- **The gate vocabulary is duplicated in three places** (types, validation,
  question text). → All three read the single `GATE_STAGES`/`GATE_QUESTIONS`
  table, and the `always`-default resolution is a single pure function with a
  matrix test.
- **Extending the frozen `definitions.ts` export surface would break
  `workflow-module-exports.test.ts`.** → Import the new tier function from
  `manifest-policy.ts` directly; the barrel and its fixture stay unchanged.

## Migration Plan

1. Ship the pure protocol, config resolution and validation, and the audit
   contract first (no behavior change: every policy resolves to `always`).
2. Register the new step definitions, behaviors, edges, and the `rounds + 600`
   tier; point `startup.ts` at the new tier. Everything is inert until a
   workflow resolves that tier.
3. Add the `gate` integration dispatch, the triage gate question, the reducer
   record, the notification, and the telemetry event.
4. Add the four selects to the preset editor.
5. Rollback: point `startup.ts` back at `definitionVersionForTriageRouting` and
   leave the tier registered. Workflows already running on `rounds + 600` keep
   dispatching; the gate steps are always-resolved unless a user configured
   `auto`.

No stored data is rewritten and no configuration migration is required: a
configuration without `gates` is valid and resolves to `always`.

## Open Questions

- Should the dashboard render gate decisions as extra rows in the existing
  conditional Classifier panel, or as a compact "skipped stages" line in the
  Change panel's status area? Either satisfies the spec; the row rendering
  reuses the projection and the existing detail modal, so it is the lower-risk
  default and can be decided during implementation without changing the specs.
- Notification wording for a skip is not pinned by any spec and can be chosen
  during implementation.
