## Context

`src/workflow/profiles.ts` parses an `agents` config object into `AgentsConfig`, which may include an optional `runtime_diversity` list of rules (`{ routes?: string[]; steps?: string[] }`). `resolveRouting` evaluates each rule against the resolved routes: it selects the named routes/steps, checks that their resolved profile runtimes are pairwise distinct, and **throws** (`runtime diversity violated: ...`) when they are not — before any run launches. This is the only mechanism in the codebase that forces distinct agent harnesses between steps/roles (e.g. `core.plan` vs `core.implementation`). It is documented as the "Optional runtime diversity constraints" requirement in `openspec/specs/agent-runtime-routing/spec.md`.

The computed result is also carried as `WorkflowRouting.diversity: { routes: string[]; satisfied: boolean }[]`, persisted in the workflow snapshot (`src/workflow/contracts.ts` `parseSnapshot`) and exposed on `WorkflowView.routing`. No other module reads `diversity` for behavior — it exists solely to report/enforce the constraint computed above (confirmed: only producer is `resolveRouting`, only consumers are the snapshot parser and hard-coded empty-array construction sites in `runtime.ts`; the TUI does not read it).

The user wants complete freedom to assign the same runtime/profile to plan and worker (or any other) phases, i.e. this constraint mechanism should no longer exist.

## Goals / Non-Goals

**Goals:**
- Configuration MUST NOT be able to force distinct runtimes between any steps/roles. Plan and worker (and everything else) can share the exact same profile/runtime with no validation error.
- Remove the now-meaningless `diversity` reporting field so the routing contract only carries data that is still produced and consumed.
- Keep the rest of routing/profile resolution (named profiles, step/role precedence, pinning, capability preflight) unchanged.

**Non-Goals:**
- No change to profile precedence resolution (`profileFor`), capability preflight (`preflightProfile`/`validateProfileRequirements`), or adapter behavior.
- No new configuration surface to express a *softer* diversity hint (e.g. warning-only) — the requirement is removed outright, not weakened.
- No migration tooling for on-disk snapshots; see Migration Plan.

## Decisions

- **Remove `runtime_diversity` from `AgentsConfig` and its evaluation in `resolveRouting`**, rather than downgrading the throw to a warning. Rationale: the proposal and user intent are to eliminate the requirement entirely ("give the user complete freedom"), not soften it. A config field that is parsed but never enforced would be confusing dead surface.
  - Alternative considered: keep `runtime_diversity` parsing but make violations non-fatal (log/attention only). Rejected — leaves a config knob whose only effect was the removed requirement, and keeps parsing/validation code with no behavioral purpose.
- **Drop `WorkflowRouting.diversity` entirely** (type in `contracts.ts`, computation in `profiles.ts`, and the two hard-coded `diversity: []` construction sites in `runtime.ts`) rather than keeping it always-empty. Rationale: an always-empty, always-`true`-or-absent field is dead weight in the persisted contract; removing it keeps the schema minimal and matches "no consumer" analysis above.
  - Alternative considered: keep the field for backward compatibility of persisted snapshots. Rejected — `parseSnapshot` treats `routing.diversity` as an array parsed with `strings()`/`satisfied` boolean checks; making it optional-and-ignored is a smaller, equally safe change, so we make it fully optional-on-read rather than required, and stop writing it.
- **Snapshot compatibility**: change `parseSnapshot` so `routing.diversity` is accepted-but-ignored when present (old snapshots) and not required when absent (new writes). No `schemaVersion` bump needed since the shape only relaxes (was required array of objects; becomes optional and unused) — this is backward compatible for reads and forward compatible because old code never reads a field new code stops writing.
- **Spec update**: remove the "Optional runtime diversity constraints" requirement section from `openspec/specs/agent-runtime-routing/spec.md` via a `## REMOVED Requirements` delta in this change's `specs/agent-runtime-routing/spec.md`, per this repo's delta-spec convention.

## Risks / Trade-offs

- [Risk] Existing persisted workflow snapshots created before this change still contain a `routing.diversity` array on disk. → Mitigation: `parseSnapshot` treats the field as optional/ignored rather than required, so old snapshots continue to load; new snapshots simply omit it.
- [Risk] Any external tooling/dashboards that read `WorkflowView.routing.diversity` for display would silently lose that data. → Mitigation: confirmed via repo-wide search that no TUI/dash code currently reads `.diversity`; this is a safe removal within the codebase scope reviewed.
- [Risk] Users who relied on `runtime_diversity` to *catch misconfiguration* (accidentally routing two roles to the same runtime) lose that guardrail. → Mitigation: this is the explicit, intended outcome of the change (complete user freedom); documented as a **BREAKING** change in the proposal.

## Migration Plan

- No data migration required. Deploy by shipping the code/spec change; new workflow starts stop parsing/enforcing `runtime_diversity` and stop writing `routing.diversity`. In-flight workflows keep their already-pinned routing (pinning behavior is unaffected — diversity was only checked once at routing resolution time, not re-checked on resume).
- Rollback: revert the code/spec change; since no persisted data format became invalid, rollback is a plain revert with no cleanup step.

## Open Questions

None — scope is bounded to removing the identified enforcement mechanism and its associated config/contract surface and spec requirement.
