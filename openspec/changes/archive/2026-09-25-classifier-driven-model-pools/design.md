# Design

## Context

The classifier path today (`src/workflow/classifiers.ts`,
`classifier-runner.ts`, `steps/model-selection.ts`) classifies a plan once and
rewrites a single `core.implementation` route from flat preset keys
(`easy|medium|hard|critical`). `startup.ts` resolves every other step from
preset `steps`/`roles`; `core.verification` gets one profile per verifier role;
fusion planners come from `planner-1..5` roles or an explicit
`--fusion-profiles` list. The OpenSpec family is split into parallel
`openspec-full`/`openspec-jev` and `openspec-fusion-full`/`openspec-propose`
definitions with different start points.

The workflow layer is migrated to Effect but pure domain and graph code stays
plain TypeScript (`docs/workflow-effect.md`). Step semantics live in
`src/workflow/steps/`; the runner boundary (`classifier-runner.ts`) is the
plain I/O adapter. See proposal.md for motivation.

Constraints that shape the approach:

- A `core.plan` pool must resolve *before* the plan artifacts exist, but
  downstream pools need those artifacts, so routing cannot be one pass.
- TypeSafe evaluates all questions in one request in parallel, so multi-step
  questions must share one request rather than fan out.
- The preset schema is breaking, and `config migrate` is the only supported
  configuration-cutover path with backup/journal semantics.
- The shared `@ui` `Form` primitive only supports `text`/`select` fields with a
  flat string value map.

## Goals / Non-Goals

**Goals:**

- One pool-driven classifier protocol for every classifiable step, with a
  single request per phase and deterministic default fallback.
- A hard, recoverable config cutover with explicit user messaging.
- Definitions/catalog whose start points match the two routing phases.
- Step-owned classification metadata, read by the runner and reducer.

**Non-Goals:**

- Classifying `no-openspec`, `wiki`, or `research` (no OpenSpec artifacts).
- Mid-loop reclassification/effort escalation, wiki-necessity, or
  blocked-failure classification.
- Extending the shared `Form` primitive with a list field.
- Backward compatibility for the old config shape or old definition ids.

## Decisions

### `pools` replaces flat category/verification preset fields

`PresetConfig`/`RoutingPreset` gain `pools?: Record<string, PoolEntry[]>` with
`PoolEntry = { label: string; profile: string; criteria?: unknown;
default?: boolean }`. `PRESET_CATEGORY_KEYS`, `categoryProfile`, and the
verifier-role editor fields are removed. `criteria` is typed `unknown` (JSON)
so a TypeSafe string, object, array, or null passes through unchanged.
`parseAgentsConfig` validates labels (unique slug per pool), known profiles,
and the default-count rule per step mode, and rejects the removed flat keys and
`roles["core.verification"]`. Removed shapes fail with the provenance file and
the Settings → Presets hint.

Alternative considered: keeping flat categories as an alias for a
single-entry pool. Rejected: the change is an intentional big-bang, and an
alias keeps two sources of truth.

### Classification metadata is step-owned behavior

`StepBehavior` gains an optional `classification?: "single" | "roster"` field.
`core.plan`, `fusion.consolidate`, `core.implementation`, `core.triage`,
`core.verification`, `core.wiki`, and `core.archive` declare `single`;
`fusion.plan` declares `roster`. The route steps and the reducer read the mode
from the registered step definition, so no engine-side step-id table is added.
`steps/model-selection.ts` is replaced by `core.route-plan`/`core.route-apply`
behaviors that enqueue one `model.classify` with
`{ integration: "routing", phase: "plan" | "apply" }`.

Alternative considered: a step-id → mode map in `classifiers.ts`. Rejected per
the repo's "step knowledge belongs in `steps/`" rule.

### One classifier request per phase, one question per classifiable step

`classifier-runner.ts` builds the `questions` map for every classifiable step in
the resolved definition: `core.plan` + `fusion.consolidate` + the `fusion.plan`
roster for the plan phase; implementation/triage/verification/wiki/archive for
the apply phase. The plan phase's state is the task; the apply phase's state is
the plan artifacts. Each question is a TypeSafe `choice` whose criteria are the
pool entries' labels/criteria. The runner returns the full answer shape
(`{ type: "choice", choice, probabilities, confidence }` or
`{ type: "noul" }`) rather than just the choice string.

The legacy `complexity` integration stays registered temporarily so any
already-claimed `{ integration: "complexity" }` payload can drain, and is
deleted afterwards.

### Selection and fallback rules

Single: apply the `choice` when `confidence >= 0.5`; otherwise use the tagged
default and record `attention`. Roster: sort `probabilities` descending, keep
`probability >= 0.2`, de-duplicate profiles, clamp to 2–5; if fewer than two
distinct profiles remain, use tagged defaults and record `attention`. Constants
(0.5, 0.2, 2, 5) are module constants, not config.

### `applyClassifierRouting` becomes phase-aware and replaces whole steps

`runtime/reducers/effect-result.ts` selects the pool set from the effect
payload's `phase`, resolves single selections for every classifiable step, and
recomputes the fusion roster (via `rolesForDefinition(..., roster.length, ...)`,
planner-K overrides, `validateFusionRouting`, preflight,
`enforceReadOnlySteps`). `profiles.ts`'s `resolveRouting` changes from the
current single `findIndex` replacement to replacing **every** route of a
selected step, which is what lets one `core.verification` pool cover all
verifier roles. Any failure keeps the tagged default, records `attention`, and
never strands the run.

Alternative considered: rejecting the pass on failure. Rejected: the effect
already completed, so failing strands the workflow.

### Coverage validation at start and preset switch

`validatePresetCoverage` is reworked to require a valid pool for every
classifiable step in the resolved definition, and `startup.ts` +
`switch-preset` both call it (fixing the existing gap where `switch-preset`
never validated coverage). A classifier-routed start without a preset fails
before launching agents with the Settings hint.

### Definition/graph overhaul with a removed-definition diagnostic

`definitions/graphs/*` registers `openspec`, `openspec-apply`,
`openspec-propose`, `openspec-fusion`, `openspec-fusion-propose`, each starting
at the routing phase it needs; `openspec-jev.ts` is folded into `openspec.ts`.
The removed ids are unregistered, and the status/drain/start path maps an
unresolvable definition to an `unknown/removed definition` diagnostic naming the
id and a registered alternative instead of a generic pin error.

Alternative considered: keeping the old ids as aliases. Rejected: locked
decision 8 (hard cut).

### Remove `--fusion-profiles`

The `fusion.plan` pool's tagged defaults seed the start-time fan-out, and the
plan-phase classifier replaces them. `parseFusionProfiles`, the CLI flag, and
its help/schema/tests are removed. (Developer-confirmed.)

### Migration strips presets and surfaces a banner

`config-migration.ts` gains a `strip-presets` action: `planMigration` detects
`agents.presets` in the canonical JSON (parsing a pending legacy TOML first) and
`applyMigration` deletes the presets table while retaining `profiles`,
`default_profile`, `routes`, `role_routes`, and `definition_defaults`. It
reuses the existing backup/journal/staged-rename machinery and is idempotent.
`config migrate` reports `Removed N presets; recreate them as model pools in
Settings → Presets.`; the TUI shows a persistent banner while the effective
config has no custom presets; the hard-start error repeats the hint.

### Settings editor uses labels + per-label selects

`agentPresets.ts` replaces the fixed complexity fields and the nine
verifier-role fields with, per classifiable step, a `pool:<step>:labels`
comma-separated text field plus one `pool:<step>:<label>` profile select per
current label, derived live from the draft (`fields()` already recomputes each
render). `fusion.plan` entries get a default toggle and 2–5 enforcement on save.
`profileReferences` scans pool entries so delete/rename of a referenced profile
is refused. The shared `Form` primitive is not extended.

### Superseded change drafts

`openspec/changes/add-complexity-model-routing-to-preset-editor/` (flat
category editor) and `openspec/changes/add-openspec-jev-apply-change-picker/`
(targets the removed `openspec-jev-apply`) are deleted in this change.
(Developer-confirmed.)

## Risks / Trade-offs

- [A user's stored presets disappear on migration] → migration is preview-first,
  backed up, journaled, and reports the removal; `use-default-model` and all
  profiles survive, and the banner + start error repeat the recovery path.
- [In-flight `openspec-jev`/`openspec-full` runs reference removed definitions
  and steps] → the hard cut accepts this; those runs surface the
  `unknown/removed definition` diagnostic rather than a confusing pin error.
- [A pool profile fails preflight during a routing pass after the effect
  completed] → keep the tagged default and record `attention`; the run stays
  runnable.
- [The Settings form recomputes per-label fields each render, so a label edit
  can remount fields] → the draft is the single source of truth and
  `fields()`/`values()` are pure; tests assert label-driven field derivation.
- [Removing `--fusion-profiles` is a breaking CLI change] → documented in the
  proposal and covered by the removed-definition/unknown-option diagnostics.
- [The editor's label text can produce duplicate or invalid slugs] → validate on
  save and surface field errors, mirroring the existing name validation.

## Migration Plan

1. Land the config schema, parser hard break, `strip-presets` migration,
   notification/banner, and Settings editor.
2. Land the runner protocol and answer parsing.
3. Land the steps/e graphs/catalog overhaul and removed-definition diagnostic.
4. Land the reducer routing changes and coverage validation.
5. Land tests and docs; delete the two superseded change drafts.

Rollback: the config migration is backup/journal-protected and has no automatic
down migration; reverting the binary requires a verified pre-migration backup or
a manually restored preset table. No store schema changes.
