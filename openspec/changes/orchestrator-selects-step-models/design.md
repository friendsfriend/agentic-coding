## Context

Today a step's model is a mid-run classification result. Each classifiable step
is preceded by a `core.route-*` system step (`steps/routing.ts`,
`STEP_ROUTES`) that enqueues one `model.classify` effect carrying
`{integration: "routing", stepId}`; `effect-runner.ts` builds one TypeSafe
`choice` question from that step's pool entries in
`preset.pools[stepId]` (`profiles.ts`), and
`runtime/reducers/effect-result.ts` applies the answer onto the pinned routing.
Presets therefore hold *candidate lists* (`PoolEntry[]` with `label`,
`profile`, `criteria`, `default`), and two rules exist only to feed the pass:
`validatePresetCoverage` (every classifiable step needs a pool) and
`resolveRoutingForStart`'s `isClassifierRouted(definition) && !preset` failure
("classifier-routed workflow requires a preset").

Everything else at start is already explicit and pinned: the preset, the gate
policies (`resolveGatePolicies`, forced human reviews for orchestrator starts),
the classifier transport, and the execution settings. The per-step model is the
last routing input that is not.

The Orchestrator (`agent-host/orchestrator.ts`) already chooses the workflow
type, the blueprint, the preset, and the checkout mode, and its
`list_agent_config` tool already reads the agents config. It has no way to say
which model runs which step, and no discovery surface for the models it could
name.

## Goals / Non-Goals

**Goals:**

- No decision model selects a model: the `routing` integration and the
  `core.route-*` steps are gone from every workflow, and nothing in the config
  format describes a set of candidates to choose between.
- The Orchestrator can name the model of each step of a workflow it starts, and
  that choice is validated, pinned, observable, and reported back through the
  workflow view.
- A person-started workflow keeps working with a preset alone, with the
  preset's single model per step as the answer for every step the Orchestrator
  did not name.
- Fusion keeps fanning out over several models, from the Orchestrator's roster
  or the preset's list.
- In-flight workflows pinned to a tier that carries route steps keep running
  across the upgrade.

**Non-Goals:**

- `core.triage-route` (per-round verifier-role selection) and the four stage
  gates stay classifier-decided. They never select a model, so removing them is
  a different change; the request names "triage-route style steps" only as far
  as they pick a model pool entry, which `core.triage-route` does not do.
- The per-file judgment sweep, the classifier transport/provider config, and
  `classifierDecisions` as a whole are untouched.
- No new dashboard editor for per-step models in this change: the wire field is
  accepted from any authenticated start, and the Orchestrator is the surface
  that gathers the choice. The new-workflow form keeps its preset step.
- No mid-run model change: the choice is pinned at start (a preset switch
  re-applies it, it does not invent one).

## Decisions

### D1 — Retire the routing steps behind a new definition version tier

`definitionVersionForModelSelection(rounds) = rounds + 900` is registered for
every family next to the family-traits tier (`definitions/manifest-policy.ts`,
`definitions/registerBuiltins.ts`). Its graphs are the family-traits graphs
without the per-step routing insertion, registered through the same
transform/flag thread the earlier tiers use, so the tiers below keep their
graph, digest, and step list. `steps/routing.ts`'s `STEP_ROUTES` /
`LEGACY_ROUTE_STEPS` and `edges.ts`'s `routeEntry` / `ROUTE_STEP_FOR_TARGET`
retire from the newest tier's build path. The route *step definitions* stay
registered so a pinned definition still resolves its steps.

Alternative: edit the family-traits tier in place. Rejected — it changes a
published tier's digest and strands every workflow pinned to it, which
`workflow-definition-registry` already forbids ("A built-in graph shape change
is published as a new definition version tier").

### D2 — Route steps of pinned tiers become pass-throughs

A route step registered by an earlier tier must still be enterable (loops
re-enter it). Its behavior becomes: `carriesOutputContext: true`, no `enqueue`
on entry, and `onEffectComplete` still completing on `model.classify`. An
effect enqueued before the upgrade still drains: the runner's `routing` branch
short-circuits locally from the snapshot's already-pinned route for that step
instead of calling the classifier, so the step completes, the pinned routing is
unchanged, and no `attention` is recorded.

Alternative: fail an unknown/late `routing` effect. Rejected — a pending effect
would park the step with no run and nothing pending, the exact state the
fail-open contract exists to avoid.

### D3 — `pools` holds one model per step; the value is a profile name

```jsonc
"presets": { "mine": { "pools": {
  "core.plan": "smart",
  "core.verification": "smart",
  "fusion.plan": ["fast", "smart", "cheap"],   // roster: 2..5 distinct
  "fusion.consolidate": "smart"
} } }
```

Nothing reads `label`, `criteria`, or `default` once no classifier sees the
pool, so they are dropped with the candidate list: a single step is a profile
name string, a roster step is a list of profile names. Validation keeps the
existing hard-error style (preset, step, `Settings → Presets` hint): each value
names an existing profile; a list is legal only for a step whose registered
behavior declares the `roster` mode, must hold 2..5 entries, and must name
distinct profiles; a custom preset still declares at least one pool.

Alternatives: (a) keep a one-element `PoolEntry[]` with `default: true` — keeps
vocabulary nothing consumes and invites a second entry by hand; (b) fold pools
into `steps` — the requirement explicitly keeps per-step pools, and the
`single`/`roster` distinction must survive somewhere.

### D4 — The parser normalizes the legacy list shape

`parseAgentsConfig` accepts a legacy list-shaped pool and collapses it: a
single-select pool takes its entry tagged `default: true` (then the sole entry,
then the first), a roster pool takes its tagged defaults clamped to 2..5. The
normalized value is what the runtime reads, which is what keeps a workflow that
is mid-run and still has a route step — and its `pools` lookup in the runner
and the reducer — working across the upgrade. Only config migration rewrites
the file (D12).

Alternative: a hard break like the earlier `easy`/`medium`/`hard` removal.
Rejected — a live run re-reads the agents config on every routing effect and on
a preset switch, so a hard break would strand in-flight work for a cosmetic
reason.

### D5 — The Orchestrator's choice is `models: Record<stepId, string | string[]>`

- Wire/server: `workflowStartRequestSchema.models` (optional) →
  `WorkflowStartRequest.models` → `resolveRoutingForStart`; the CLI accepts the
  same value as a JSON flag, and the dashboard/blueprint paths pass it through
  unchanged.
- Validation happens before any agent launch and fails closed with a diagnostic
  naming the offending key or value: every key is an `actor: "agent"` step of
  the *resolved* definition; every value names a configured profile (or the
  built-in one); an array is legal only for the definition's roster step and
  holds 2..5 distinct profiles; every resolved profile passes
  `enforceReadOnlySteps` and `preflightProfile` for its step, so a
  capability-less or unavailable-model choice fails the start rather than the
  run.
- One field covers single steps and the roster, mirrors the preset's own shape
  (D3), and lands in the one place that already builds the pinned routing.

### D6 — Precedence and pinning

Per step: explicit `models[stepId]` (or the roster list) → `preset.pools[stepId]`
→ the existing chain (`preset.roles[step][role]` → `preset.steps[step]` →
`preset.default_profile` → `config.role_routes` → `config.routes` →
`config.definition_defaults` → `definition.defaultProfile` →
`config.default_profile` → built-in `use-default-model`). `profileFor` /
`resolveRouting` keep that order; the pool lookup simply yields one profile
instead of a tagged default.

`metadata.modelSelections` is pinned once at start alongside `selectedPreset`,
`gatePolicies`, and `classifier`, and records per step the resolved profile name
and its source (`orchestrator` | `preset` | `fallback`). Because it is pinned,
a mid-run config edit cannot change what a running workflow launches, and the
view/telemetry have one authoritative answer for "which model will this step
run on".

### D7 — Preset switch re-applies, never invents

`switch-preset` keeps its existing shape (re-resolve from the new preset,
re-seed the fusion roster from the new `fusion.plan` list, stop and re-create
the affected runs). On top of that it re-applies the *pinned* Orchestrator
selections for steps still present in the definition, and refreshes their
source. A pinned selection whose profile no longer resolves, or whose roster no
longer satisfies 2..5 distinct profiles, is dropped with an `attention` entry
rather than failing the switch: the config was edited after the run started.
`validatePresetCoverage` and the `isClassifierRouted` failure are deleted from
both this path and startup.

### D8 — Fusion needs a roster, from either source

A definition with `traits.planning === "fusion"` needs 2..5 distinct planner
profiles, taken from `models["fusion.plan"]` when the Orchestrator supplied a
roster, else from `preset.pools["fusion.plan"]`. With neither, the start fails
before any agent launch with a diagnostic naming both remedies (name
`models["fusion.plan"]`, or configure the pool in `Settings → Presets`).
`fusionPlannerRoleNames` / `applyFusionRoster` keep their "recompute
`planner-1..N`" contract; `validateFusionRouting` moves to the start and preset
switch paths because no pass replaces the roster any more.

### D9 — `list_agent_config` is the discovery surface

The tool returns presets (name, description, gates, and the resolved per-step
model), profiles (runtime + model), `defaultProfile`, the available model ids
of the configured runtime, and the agent steps a start may select for, each
with its pool mode. The available-model read reuses the in-process
`configuredModelList()` path (`agent-host/configured-models.ts`, the same one
the Settings profile editor uses) so the tool spawns nothing.

Alternative: a separate `list_models` tool. Rejected — two round trips for one
decision and a second place to keep in sync.

### D10 — Telemetry and records follow the selection

- One `models.selected` event on the engine telemetry layer at start: workflow
  id, one row per resolved step (`step`, `profile`, `source`, roster flag),
  counts. Content-free, redacted and bounded like every other payload,
  observational only (a telemetry failure never fails a start).
- `routing.classified` is removed with the pass. `routing.request` /
  `routing.response` stay for the classifier calls that remain (triage, gates,
  file judgment), with the routing-specific payload keys (`phase`,
  `steps.asked`, `entries.offered`) replaced by integration-neutral ones.
- Routing decision records disappear; `classifierDecisions` keeps triage, gate,
  and file-judgment records, so the classifier decision panel simply shows no
  routing rows.
- The per-run model already reaches telemetry and the view through the run row,
  so per-step observability is unchanged for a launched run.

### D11 — Settings editor follows the vocabulary

Each pool step renders one profile select; the roster step renders an ordered
2..5 distinct-profile selection. The comma-separated label list, the per-entry
default toggles, and criteria preservation go away with the vocabulary the
editor was mirroring. The draft keeps carrying `description`, `steps`, `roles`,
and `gates` verbatim, and deleting or renaming a profile referenced by a pool or
route is still refused with the referencing entries named.
`docs/settings-inventory.md` and `docs/config-inventory.md` are updated in the
same change.

### D12 — Migration converts presets instead of stripping them

`config-migration.ts` gains a preset-pool normalization pass inside the existing
preview/apply/backup/journal/staged-rename machinery: it rewrites only presets
whose pools use the legacy list shape, reports how many presets were converted
and which steps were collapsed, and is idempotent (a second run reports
nothing). It no longer strips presets, and it leaves profiles,
`default_profile`, routes, `role_routes`, and `definition_defaults` alone.

## Risks / Trade-offs

- [A fusion start with no roster now fails at start] → The diagnostic names both
  remedies, and the Orchestrator prompt rule (new capability) makes gathering
  the roster a pre-start step rather than a mid-run surprise.
- [Losing pool entries silently drops a model a user relied on] → Migration
  reports every collapsed step, and the survivor is the entry the classifier
  already fell back to (`default: true`), so the run's model is unchanged.
- [A legacy pending `routing` effect could park a step] → D2's pass-through
  keeps `onEffectComplete` and short-circuits the call; a focused resume test
  covers a workflow paused at a route step.
- [Orchestrator names a profile whose model is unavailable] → The start
  preflights every resolved profile, so the choice fails the start with the
  existing model-availability diagnostic instead of launching and failing the
  run.
- [Tier drift: a graph change without a new tier] → The existing registry
  invariant (every family resolves at the newest tier; an earlier pin keeps its
  digest and steps) is asserted in a focused registry test.
- [Partial presets become legal again] → A start that names no preset and no
  models for a step resolves through `use-default-model` exactly as a
  non-classifier family does today; nothing silently invents a model, it is
  recorded as source `fallback`.

## Migration Plan

1. Parser accepts and normalizes the legacy pool shape (no behavior change).
2. New definition tier plus pass-through route behaviors; verify an in-flight
   pinned workflow resumes and runs.
3. Start-time selection end to end: contract field, server validation, pinning
   into metadata, telemetry event, Orchestrator tool and prompt.
4. Settings editor for the new pool shape, then `config-migration` conversion;
   run the migration over a fixture config twice (idempotence).
5. Update `docs/workflow-architecture.md`, `docs/config-inventory.md`,
   `docs/settings-inventory.md`, `docs/orchestrator.md`, and archive the
   change's spec deltas.

Rollback: reverting the tier registration stops new workflows from using the
new shape; workflows pinned to older tiers (with their route steps) were never
touched, so only runs started at the new tier are affected.

## Open Questions

- Should the dashboard's new-workflow form expose per-step models too (the wire
  field accepts them from any authenticated start)?
- Should `pools` eventually merge into the preset's `steps` table now that no
  step is "classifiable" in the old sense?
- Should the Orchestrator be able to change a step's model mid-run (a
  `set-step-model` action)? This design pins the choice at start.
