# Proposal

## Why

The workflow engine already asks the JEV/System One classifier to pick per-step
model profiles (`classifier-driven-model-pools`) and per-round verifier roles
(`classifier-driven-triage-routing`), but the *stages themselves* are fixed: a
plan is always approved by a developer, a change is always triaged and verified,
a change is always developer-reviewed, and every change is sent to the wiki.
That is the right default and must stay the default, yet it forces the same
human and test-suite cost onto a one-line documentation fix as onto a
permissions change. Today the only way to reduce that cost is to edit the
workflow graph, which also removes the stage from the workflow entirely.

The classifier can already judge necessity per question (a `noul` answer). This
change reuses that exact mechanism to decide whether a stage is needed at all,
per preset, while keeping every skip observable and keeping the two stages that
must never be skipped (`core.archive`, and human review when it is configured
`always`) outside the classifier's reach.

## What Changes

- Add a **stage-gate** mechanism: four independent gates — `planApproval`,
  `verification`, `developerReview`, `wiki` — each a classifier decision that
  may skip the stage it guards, configured per preset.
- Add gate configuration `gates: { planApproval | verification |
  developerReview | wiki: "always" | "auto" }` on a preset, with a global
  `agents.gates` table as fallback and `always` as the final default. `always`
  short-circuits the gate locally and issues **no** classifier request; only
  `auto` allows a skip.
- Add three new system steps, each one classifier decision with outcomes
  `["run", "skip"]` (`core.plan-gate`, `core.review-gate`, `core.wiki-gate`),
  and extend the existing `core.triage-route` with a third outcome
  `skip-verification` driven by one added `needs_verification` necessity
  question. The decision threshold is 0.5 on the necessity value; a `noul`
  answer carries no confidence.
- Reroute the graphs: `core.verification` pass now enters `core.review-gate`;
  `core.developer-review` approve and `core.review-gate` skip both enter
  `core.wiki-gate` (or the archive/delivery target when no wiki gate exists);
  `core.wiki-gate` skip enters `core.archive`. The skip-both safeguard is
  structural: skipping verification always passes through `core.review-gate`,
  which only skips when `developerReview` is itself `auto`.
- Keep `core.archive` **ungated** and always reachable: archiving is mandatory
  for OpenSpec to complete.
- Fail open: a classifier error, a missing credential, or a missing/unusable
  answer for a gate never skips — it forces the run and records attention.
- Record every gate decision (stage, policy, answer value, forced/decided
  verdict) in a bounded per-workflow gate-decision list carried on the snapshot
  and the validated workflow view; on an actual skip also emit a developer
  notification and a telemetry event, and surface the skipped stage in workflow
  status and the dashboard so a skipped test suite or human review is never
  silent.
- Add a **Stage gates** section to the Settings preset editor: one select per
  stage (`always` / `auto`) built from the existing text/select form primitives,
  preserving the existing profile references and pool fields on save.
- Publish the new graph in a new definition-version tier so workflows already
  pinned to an earlier tier keep their graph, digest, and step list.

Explicitly **not** changed: `core.archive` stays ungated; there is no separate
`triage` policy and no verification-without-triage path; per-turn effort
escalation, classifier-driven question routing, and per-step model selection all
stay out of scope (the last one remains the model pools' job).

## Capabilities

### New Capabilities

- `stage-gates`: how a preset's four stage gates are configured, how each gate
  decides, when a stage may be skipped and how the workflow routes around a
  skipped stage, the forced-run and fail-open guarantees, the skip-both
  safeguard, the ungated archive, and the audit trail a skip leaves behind.

### Modified Capabilities

- `triage-verifier-routing`: the per-round routing step additionally asks
  whether independent verification is needed at all, gains a `skip-verification`
  outcome that bypasses both triage and verification, and drops its former
  two-outcome shape.
- `agent-configuration-presets`: a preset accepts a `gates` table, a global
  `agents.gates` table acts as the fallback, invalid gate values are rejected,
  and the Settings preset editor offers one `always`/`auto` select per stage.
- `workflow-definition-registry`: the three new gate steps are registered, each
  definition that owns a guarded stage contains its gate step, the graph shape
  change is published as a new definition version tier, and the propose and
  fusion-propose successful paths include the plan gate.
- `workflow-proposal-only`: both proposal-only definitions route a completed
  plan or consolidation through the plan gate.
- `workflow-plan-fusion`: the fusion definitions route consolidation through the
  plan gate before plan approval.
- `no-openspec-workflow`: the archive-free tail runs the review gate and, when
  the wiki gate is present, the wiki gate.

## Impact

- Workflow domain/config: new `stage-gates` gate protocol, threshold, and
  policy resolution; `PresetConfig.gates` and `AgentsConfig.gates`; gate
  validation in the agents-config parser; `gates` carried on the resolved
  routing preset.
- Step catalog and behavior: three new system steps in
  `definitions/steps.ts`, a new gate step behavior module wired through
  `steps/index.ts`, a third outcome for `core.triage-route`.
- Graphs: `definitions/edges.ts` plus the `openspec`, `fusion`, and
  `no-openspec` graph builders, a new definition version tier in
  `definitions/manifest-policy.ts` / `registerBuiltins.ts`, and the legacy step
  compatibility mapping for the new step ids.
- Classifier runtime: a `gate` integration on `model.classify` in
  `effect-runner.ts`, request building and per-stage state assembly in
  `classifier-runner.ts`, and the skip notification/telemetry emission at the
  same boundary.
- Contracts and reducer: a bounded gate-decision list on the snapshot, its
  schema decoding, its pass-through in the workflow view, and its recording in
  the `effect.result` reducer alongside the existing attention and classifier
  decision records.
- TUI: a Stage gates section in the preset editor
  (`src/tui/settings/agentPresets.ts`, `AgentPresetsView.tsx`) and skipped-stage
  surfacing in the dashboard's classifier/status surface.
- Docs: `agentic-coding/docs/workflow-architecture.md` step list and new tier,
  `agentic-coding/docs/settings-inventory.md`, and the repository `README.md`,
  plus the exact `gates` configuration block a user applies to enable all four
  gates for testing.
- No new runtime dependency, no change to the classifier model, profile, or
  endpoint, and no change to any effect kind's contract beyond the `gate`
  payload of `model.classify`.
