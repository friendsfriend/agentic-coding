# Proposal

## Why

Which model runs a step is decided by a decision model today. Every classifiable
step is preceded by a `core.route-*` system step that asks JEV/System One to
pick one entry out of the selected preset's per-step candidate pool, mid-run.
The intent a user actually has — "run planning on the strong model, the wiki
step on the cheap one" — is therefore not expressible where it is known: the
Orchestrator that starts the workflow cannot say it, and the preset only offers
candidates that a classifier then chooses between. Two consequences are already
visible in the spec set:

- A workflow could not be started by a person (dashboard, CLI) with only a
  preset and no pool for a classifiable step; the "classifier-routed workflow
  requires a preset" failure and the per-step pool coverage rule exist purely to
  feed that routing pass, not to protect anything the run does.
- The recorded routing is a classifier answer keyed by pool labels, so the
  preselected model of every step is invisible to the workflow metadata and to
  telemetry until (and unless) a pass ran and answered.

Moving the choice to start time — where the Orchestrator already chooses the
workflow type, the preset, and the checkout mode — makes the per-step model a
declared property of the run instead of a classification result.

## What Changes

- **Per-step model selection moves to start time.** The per-step routing steps
  (`core.route-implementation`, `core.route-verification`, …) and the `routing`
  classifier integration are removed from every workflow; no decision model
  selects a model any more. Every step's model is pinned when the workflow
  starts, exactly like the preset, the gate policies, and the classifier
  transport already are.
- **Orchestrator-chosen models.** `start_workflow` (and the start wire request)
  gains a `models` input mapping a step id to a profile name — a `2..5`-entry
  list for the fusion roster step — validated against the resolved definition
  and the configured profiles before any agent launches. `list_agent_config`
  grows the discovery surface the choice needs: per-preset step models, the
  configured profiles, the models the configured runtime can run, and which
  step ids a start may choose for. The Orchestrator prompt tells it to ask the
  developer for those choices up front when the request implies one.
- **Presets hold one model per step.** **BREAKING** — a preset `pools` entry is
  a single profile name (`pools["core.plan"] = "smart"`) instead of an ordered
  list of labelled candidates; `fusion.plan` keeps list semantics (2..5 distinct
  profiles) because a fusion run genuinely fans out over several models, and
  `fusion.consolidate` is a single model like every other step. Entry labels,
  per-entry `criteria`, and `default` flags are gone: nothing consumes them once
  no classifier reads the pool. Preset validation, the Settings preset editor,
  the config inventory docs, and migration of existing presets follow.
- **A preset is optional for every start.** The pool coverage rule, the
  `isClassifierRouted` gate, and the `classifier-routed workflow requires a
  preset` diagnostic are removed: a start without a preset resolves through the
  preset/step/role/default chain that already covers non-classifier workflows.
  The one exception is a fusion definition, which needs a planner roster from
  the Orchestrator input or the preset and fails before launching when it has
  neither.
- **Definition version tier.** A new tier registers every family without the
  route steps. Earlier tiers stay registered with their graphs and digests, so
  an in-flight workflow keeps running: its route steps complete without asking
  the classifier and keep the routing already pinned.
- **Observability of the chosen model.** The resolved per-step model and where
  it came from (Orchestrator choice, preset, fallback chain) are pinned into the
  workflow metadata; a start-time telemetry event reports one row per step.
  Routing-pass telemetry (`routing.request`/`routing.response` for routing,
  `routing.classified`) and routing decision records are removed; classifier
  call telemetry and decision records for triage, gates, and file judgment stay.
- **Compatibility and migration.** A preset file with the old list-shaped pools
  still parses: each single-select pool collapses to its `default: true` entry
  and a `fusion.plan` pool keeps its tagged defaults, so an in-flight workflow
  is never stranded by a config-format change; `config migration` rewrites the
  file to the new shape and reports what it converted.

Out of scope on purpose: `core.triage-route` (verifier-role selection plus the
verification gate) and the four stage gates stay classifier-decided. They never
select a model, so they are unchanged — the request names "triage-route style
steps" only as far as they pick a model pool entry, which `core.triage-route`
does not.

## Capabilities

### New Capabilities
- `orchestrator-step-model-selection`: the start-time per-step model selection —
  the `start_workflow`/wire `models` input and its validation, the discovery
  surface the Orchestrator chooses from, the fallback when a step is not named,
  the fusion roster rule, non-orchestrator starts, the pinned selection and its
  telemetry, and the Orchestrator prompt/tool descriptions that gather the
  choice.

### Modified Capabilities
- `classifier-model-pools`: a step's pool is a single model (a list only for
  `fusion.plan`); the classifier-routing requirements (two passes, roster
  probability selection, atomic routing update, coverage validation, System One
  answer shapes, single-select choice) are removed.
- `agent-configuration-presets`: preset validation, routing resolution, coverage
  validation, the Settings preset editor, and plan-fusion pool handling follow
  the single-model pool shape; the preset migration converts instead of
  stripping.
- `classifier-routing-telemetry`: the routing-pass decision record is removed
  and the classifier call telemetry is re-scoped to the integrations that
  remain.
- `classifier-decision-records`: routing no longer produces decision records;
  triage, gate, and file-judgment records keep their contract.
- `workflow-engine-runtime`: shared startup resolves per-step models from the
  pinned selection and the preset without pool coverage validation or a fusion
  classification pass.
- `workflow-definition-registry`: the registered family graphs carry no route
  steps in the newest tier, and the tier is published as a new definition
  version.
- `workflow-blueprints`: the compiler and the blueprint step catalog stop
  treating `core.route-*` as insertable machinery.
- `custom-workflow-definitions`: the newest-tier invariant no longer requires a
  routing step before implementation.
- `direct-apply-workflow`, `workflow-proposal-only`, `workflow-plan-fusion`:
  their entry steps and pinned graph paths lose the routing steps.
- `contextual-workflow-launch`: the launch form and catalog describe the
  OpenSpec family without classifier routing, and starting one no longer
  requires a preset.

## Impact

- Engine and domain: `src/workflow/profiles.ts` (pool shape, validation,
  coverage removal, `profileFor`), `startup.ts`, `classifiers.ts`,
  `effect-runner.ts` (routing integration and telemetry),
  `runtime/reducers/effect-result.ts`, `runtime/reducers/developer-action.ts`
  (preset switch), `runtime.ts` (fusion routing validation).
- Definitions: `definitions/manifest-policy.ts` (new tier),
  `definitions/registerBuiltins.ts`, `definitions/edges.ts`,
  `definitions/graphs/*.ts`, `definitions/steps.ts`,
  `steps/routing.ts`, `steps/index.ts`, `steps/types.ts`, and the step modules
  that declare a classification mode.
- Contracts and server: `contracts/actions.ts` (start request `models`),
  `contracts/workflow.ts` (pinned selection in metadata and snapshot),
  `server/operations/engine.ts`, `server/app.ts`, `server/config.ts`.
- Orchestrator: `src/agent-host/orchestrator.ts` (`start_workflow` and
  `list_agent_config` inputs/descriptions, the system prompt),
  `docs/orchestrator.md`, `agent-definitions/` orchestrator briefs if they name
  model routing.
- Settings and migration: `src/tui/settings/agentPresets.ts`,
  `AgentPresetsView.tsx`, `items.ts`, `catalog.ts`, `src/config-migration.ts`.
- Docs: `docs/workflow-architecture.md` (the routing section),
  `docs/config-inventory.md`, `docs/settings-inventory.md`.
- Presets and fixtures: any shipped or test preset with list-shaped pools
  (`pi/herdr-workflow.json`, test fixtures) must parse or migrate; the fusion
  fixtures keep a 2..5-entry roster.
- Behavior change for users: a preset's losing pool entries are no longer
  reachable; the model a step runs on is fixed at start (a preset switch
  re-pins and re-applies the pinned Orchestrator choices).
