# Proposal

## Why

`core.triage` currently asks one agent to do two unrelated jobs: decide *which
verifier roles run* and decide *which changed files each of those roles must
see*. Role selection is a coarse, high-leverage judgement that the triage agent
makes from a prose summary of the change, and it is re-made by a different agent
run in every verification round with no cheap, deterministic oracle. The JEV
classifier already decides model routing from a bounded, machine-readable view of
the change, so it can answer "does this change touch correctness / security /
performance / … surfaces?" far more cheaply and reproducibly than an agent
prompted to fill both jobs at once. Splitting the two jobs keeps the per-verifier
context slimming (triage still scopes files) while making *which verifiers run*
deterministic, and it makes a config-only change able to select no domain
verifier at all instead of always paying for a `quality-verifier` pass.

## What Changes

- Add a new system step `core.triage-route` immediately before `core.triage` in
  the shared implementation loop, so it re-runs on every verification round. It
  enqueues one `model.classify` effect (`integration: "triage"`, `retryLimit: 3`)
  and transitions `complete` (at least one role) or `empty` (zero roles, which
  bypasses triage and goes straight to `core.verification`).
- Add a `triage` classifier integration that asks one independent `noul`
  question per eligible verifier role in a single System One request. A role is
  selected when its `noul` answer is `>= 0.5`; there is no forced baseline, so
  `quality-verifier` and `openspec-verifier` are classifier-decided too.
  `test-verifier` is never a question — the engine still auto-launches it.
- Eligible roles are the registered verifier catalog minus `test-verifier`
  (`openspec-verifier` additionally removed for the `no-openspec` definition).
  Zero selected roles is a valid outcome.
- Narrow the triage agent to file scoping: its emitted `roles` must be a subset
  of the classifier selection (it may drop a role with no relevant files, never
  add one). Only the surviving roles reach `core.verification`.
- Change `core.verification`'s empty-selection fallback from
  `["quality-verifier"]` to `["test-verifier"]`, so a zero-role round runs the
  complete suite and passes.
- Assemble the classifier state from the engine's own changed-file manifest plus
  capped per-file diffs, reusing `changedFilesInAsync` so the state matches
  exactly what triage validation enforces. Paths are always complete even when
  diff text truncates.
- Fail open: any classifier error (missing key, provider error, invalid JSON or
  answers) runs `core.triage` unconstrained, exactly as today, and records
  `attention`. Verification is never blocked by a classifier outage.
- Register the new graph shape under a new definition version tier so already
  started workflows keep resolving their pinned definition digest, and add the
  step to the registry's explicit legacy step mapping.
- Rewrite `agent-definitions/instructions/triage.md`: the agent receives the
  locked role set and scopes files, instead of choosing roles from a table.

## Capabilities

### New Capabilities
- `triage-verifier-routing`: classifier-driven per-round selection of verifier
  roles, the `core.triage-route` step, the `noul` question protocol, bounded
  changed-file/diff state assembly, the subset-only triage contract, zero-role
  behavior, and classifier fail-open.

### Modified Capabilities
- `classifier-model-pools`: the pool-routing passes stay the only *model pool*
  classification; a second, pool-independent `triage` integration asks role
  presence questions and resolves no model, so the System One answer parsing
  gains the `noul` shape without affecting pool selection.
- `workflow-verifier-role-coverage`: triage selection becomes a subset of a
  classifier selection, the selection catalog is the single source of eligible
  roles for both the questions and validation, and an empty selection resolves
  to `test-verifier` only.
- `workflow-definition-registry`: the graph shape that routes verification
  through `core.triage-route` registers under a new definition version tier and
  a legacy step mapping, so in-flight pins keep resolving.
- `no-openspec-workflow`: the `no-openspec` definition never asks the
  `openspec-verifier` question and still reaches triage and verification.

## Impact

- `agentic-coding/src/workflow/classifiers.ts` (new `triage` integration
  questions, `noul` answer parsing, 0.5 gate), `classifier-runner.ts` (`noul`
  question requests, bounded triage state collection),
  `effect-runner.ts` (`model.classify` triage branch, fail-open mapping).
- `agentic-coding/src/workflow/steps/` (new `core.triage-route` behavior,
  `core.triage` subset validation, `core.verification` empty fallback),
  `definitions/steps.ts` (step registration), `definitions/edges.ts` and
  `definitions/graphs/*` (edges and the new version tier),
  `definitions/manifest-policy.ts`, `registerBuiltins.ts`, `registry.ts`
  (legacy mapping), `startup.ts` (new-start version resolution).
- `runtime/reducers/effect-result.ts` (triage selection applied to the arriving
  step, attention on fail-open).
- `agent-definitions/instructions/triage.md` and the regenerated
  `src/workflow/embedded.generated.ts` (instruction digests are presentation
  pins).
- No new effect kind, no new model provider, no new dependency: the classifier
  reuses the existing System One endpoint and `jev-classifier` profile.
