# Proposal

## Why

The JEV classifier currently classifies a plan once and picks a single worker
profile. Every other classifiable step (`core.plan`, triage, verification,
wiki, archive, fusion consolidation) is routed by static preset fields, and the
nine verifier roles each need their own preset assignment. Users cannot express
"for this step I prepared these labelled model choices; let the classifier pick
one", and the verification editor has nine near-identical fields.

This change makes the classifier the routing brain for every classifiable
workflow step: each step gets a user-defined list of labelled profiles (a
*pool*), and one System One request per phase picks the fitting entry (or a
planning roster for fusion). It also makes the JEV path the default and only
OpenSpec path and removes the parallel non-classified OpenSpec/fusion
definitions.

## What Changes

- **BREAKING** Config key `pools` replaces the flat complexity keys. Each
  classifiable step maps to one ordered list of entries
  `{ label, profile, criteria?, default? }`; `criteria` accepts a TypeSafe
  string, object, array, or null. Verifiers share one `core.verification` pool.
- Exactly one `default: true` entry is required for single-select steps; the
  `fusion.plan` roster pool requires 2–5 `default: true` entries. A classifiable
  step with no valid pool is a hard config error pointing at Settings →
  Presets.
- Two classification passes replace the single classify step:
  `core.route-plan` (state = task) resolves the `core.plan` and
  `fusion.consolidate` pools plus the fusion planner roster; `core.route-apply`
  (state = plan artifacts) resolves the implementation, triage, verification,
  wiki, and archive pools. Each pass is one `model.classify` request holding
  all its step questions in parallel.
- Single-select steps use a TypeSafe `choice` question and honor the `choice`
  answer only when `confidence` ≥ 0.5. The fusion roster sorts
  `probabilities` descending, keeps every entry ≥ 0.2, de-duplicates profiles,
  and clamps to 2–5.
- Fallback is the entry/entries tagged `default: true`; a low-confidence single
  answer or an empty/duplicate-only roster also records `attention`.
- The workflow catalog becomes `openspec`, `openspec-apply`,
  `openspec-propose`, `openspec-fusion`, and `openspec-fusion-propose`, all
  starting with the routing pass they need. `openspec-full`, the old
  `openspec-apply`, `openspec-fusion-full`, the old
  `openspec-fusion-propose`, `openspec-jev`, and `openspec-jev-apply` are
  unregistered with a clear removed-definition diagnostic instead of a generic
  pin error.
- **BREAKING** `config migrate` deletes every stored preset (profiles stay) and
  tells the user to recreate them as pools; the TUI shows a persistent banner
  while the effective config has no custom presets, and a JEV start with no
  preset fails with the Settings hint.
- The Settings preset editor replaces the fixed complexity fields and the nine
  verifier-role fields with, per classifiable step, a comma-separated label
  field plus one profile select per current label; `fusion.plan` entries get a
  default toggle. Deleting or renaming a profile referenced by a pool entry is
  refused.
- The explicit `--fusion-profiles` start override is removed; the fusion roster
  is classified, with the pool defaults as the start-time fallback.
- The two unarchived drafts `add-complexity-model-routing-to-preset-editor`
  (flat category editor) and `add-openspec-jev-apply-change-picker` (targets a
  removed id) are superseded and removed.

## Capabilities

### New Capabilities

- `classifier-model-pools`: per-step labelled profile pools, the two-pass
  System One routing protocol, single-select confidence gating, fusion roster
  probability selection, default fallback and attention recording, and pool
  validation/coverage.

### Modified Capabilities

- `agent-configuration-presets`: the editor edits per-step pools (including the
  fusion default toggle) instead of fixed complexity/verifier-role fields; the
  parser rejects the old shape and `config migrate` strips presets; profile
  references include pool entries.
- `agent-runtime-routing`: step routing resolves through the pool selected by
  the classifier, with the tagged default as fallback, and preflight covers
  every resolved pool profile.
- `workflow-plan-fusion`: registers `openspec-fusion` and
  `openspec-fusion-propose` starting at `core.route-plan`, and derives the
  planner fan-out count/roster from the classifier instead of preset
  `planner-1..5` roles or `--fusion-profiles`.
- `workflow-proposal-only`: `openspec-propose` and `openspec-fusion-propose`
  run the routing pass before planning.
- `direct-apply-workflow`: `openspec-apply` starts at `core.route-apply`
  before implementation while keeping its artifact validation.
- `workflow-verifier-role-coverage`: all verifier roles resolve through the one
  `core.verification` pool; the per-role preset editor requirement is replaced.
- `workflow-definition-registry`: the removed definitions are unregistered and
  a removed/unknown definition produces an actionable diagnostic.
- `contextual-workflow-launch`: the new-workflow form exposes the new workflow
  ids and drops the removed ones.
- `workflow-engine-runtime`: shared startup drops the explicit fusion-profile
  override and validates pool coverage for the resolved definition.

## Impact

- Config/parser/migration: `src/workflow/profiles.ts`, `src/config-migration.ts`,
  `src/workflow/effects.ts` (`config migrate` command output).
- Classifier: `src/workflow/classifiers.ts`, `src/workflow/classifier-runner.ts`,
  `src/workflow/steps/model-selection.ts` (replaced by route-plan/route-apply).
- Steps/graphs/catalog: `src/workflow/definitions/steps.ts`,
  `src/workflow/definitions/graphs/{openspec,fusion,openspec-jev}.ts`,
  `src/workflow/definitions/catalog.ts`,
  `src/workflow/definitions/registerBuiltins.ts`,
  `src/workflow/steps/index.ts` (new step behaviors).
- Routing reducer/startup: `src/workflow/runtime/reducers/effect-result.ts`,
  `src/workflow/startup.ts`, `src/workflow/runtime/kernel.ts` (routing
  validation), CLI `start`/help/schema.
- Settings TUI: `src/tui/settings/agentPresets.ts`,
  `src/tui/settings/AgentPresetsView.tsx`, dashboard banner.
- Docs: `docs/workflow-architecture.md`, `README.md`, config/settings
  inventories.
- Tests: classifier, steps, registry, model-config, settings, app view,
  catalog, config-migration, startup, plan-fusion.
- Superseded changes: delete `openspec/changes/add-complexity-model-routing-to-preset-editor/`
  and `openspec/changes/add-openspec-jev-apply-change-picker/`.
