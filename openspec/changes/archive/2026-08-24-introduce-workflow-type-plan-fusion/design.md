## Context

The workflow engine registers workflows as explicit, versioned graphs of registered steps (`agentic-coding/src/workflow/definitions.ts`, registry contract in `openspec/specs/workflow-definition-registry/spec.md`). Built-ins today are `standard`, `direct-apply`, and `no-openspec`; all share the tail `core.implementation → … → core.closed`. The persisted-state runtime already supports multiple concurrent active runs created by one step ("Parallel run handoffs arrive", `workflow-state-runtime` spec), and agent routing is resolved per role/profile through the agents config (`profiles.ts`: presets, `steps`, `roles`, `role_routes`). Assignment rendering (`assignment.ts`) pins instruction assets per step via digests and supports structured output contracts (`core.triage-plan@1`, `core.findings@1`) rendered into the assignment envelope. See proposal.md for motivation and specs/ for behavior contracts.

## Goals / Non-Goals

**Goals:**
- Additive built-in definition `plan-fusion` composed mostly of existing steps.
- True parallelism at the fan-out step using the existing multi-run-per-step state machinery.
- A prompt-engineered, machine-validated shared output style for planner drafts (`core.plan-draft@1`).
- Consolidation receives *all* validated drafts as declared inputs, deterministically ordered.
- Configurable model list (2–5) resolved through the existing profile/route surface — no new adapter concepts.

**Non-Goals:**
- Changing any existing workflow's graph, versions, or pins.
- Voting/scoring mechanisms between drafts (consolidation is qualitative, done by one agent).
- New effects, capabilities, or adapter kinds.
- Automatic model selection or fallback model substitution when a planner fails repeatedly.

## Decisions

### D1: Two new steps, reuse the standard tail
Add `fusion.plan` (actor `agent`, fan-out) and `fusion.consolidate` (actor `agent`) to the step catalog. The `plan-fusion` manifest is:

```
fusion.plan → fusion.consolidate → core.plan-approval → [standard tail unchanged]
```

Edges beyond the two new steps are identical to `standard`'s. Alternatives considered:
- One combined step that both fans out and consolidates — rejected: mixing parallel handoff collection and synthesis in one step complicates the reducer and hides the consolidation artifact boundary from review.
- A plugin-style extension inserting steps before `core.plan` — rejected: this release has no automatic extension insertion; explicit composition is the registry contract.

### D2: Fan-out via N active runs keyed by planner roles
On activation, `fusion.plan` creates N active runs (N = configured model count, 2–5) with roles `planner-1` … `planner-N`. Role names exist only so `role_routes` can bind each role to a distinct profile/model; every assignment renders identical objective, permissions, checks, and output schema (the role placeholder in the envelope differs, nothing else). This relies directly on the existing "parallel run handoffs" semantics: the step's reducer counts validated `complete` handoffs and only emits the step transition when all N have arrived. Alternatives:
- Sequential planners — simpler, but defeats the purpose (latency ×N and no true independence).
- Fixed five roles with optional skips — rejected: silent subsets contradict the "no drafts silently dropped" requirement and complicate completion counting.

### D3: Model list is start-time configuration over existing routing
Workflow start for `plan-fusion` takes an ordered list of 2–5 profile names; the engine maps position i → role `planner-i` → profile via the same resolution path as `role_routes`, rejecting out-of-range counts, unknown profiles, and duplicates before launch. No schema change to profiles; the list lives in start parameters recorded in the snapshot (so retries/restarts re-resolve identically). Alternative: a static agents-config field — rejected: model choice is per-workflow-task, not per-repo.

### D4: `core.plan-draft@1` structured contract
New output contract alongside `triage`/`findings`: `{ approach: string, files: [{ path, change }], risks: [{ detail }], questions: [{ detail }] }`. Validation mirrors `core.triage-plan`: non-empty arrays where required, repository-relative non-escaping paths, bounded string lengths, overall byte cap. The prose "output style" guidance lives in the instruction asset `planning-fusion.md` (pinned by digest like all assets); the schema guarantees the machine-checkable skeleton so consolidation input is uniform. Alternatives:
- Markdown-only drafts with style enforced purely by prompt — rejected: unvalidatable, and consolidation would parse N free-form documents.
- Reusing passthrough — rejected: no defined output style, violating the task's prompt-engineering requirement.

### D5: Consolidation inputs are recorded draft artifacts
When the last planner hands off, the reducer records every accepted draft (path + digest, stable order by role number) into the step context. `fusion.consolidate`'s assignment lists them under **Inputs**; its instruction asset `fusion-consolidation.md` directs: reconcile conflicting approaches, prefer convergent choices, document rejected alternatives in the proposal, then create the openspec change artifacts exactly as `core.plan` does today (same allowed effects incl. `openspec.validate`). Output contract: passthrough (the durable artifact is the openspec change directory itself). Alternative: emit a consolidated intermediate JSON — rejected: redundant with the openspec artifacts that review actually reads.

### D6: Review revisions re-enter consolidation
`core.plan-approval` `comments`/`reject` route to `fusion.consolidate` (loop max 3), not straight back to fan-out: comments almost always target the consolidated proposal, and full re-fanning is expensive. A developer who wants fresh perspectives can restart the workflow. Alternative: route to `fusion.plan` — rejected as default for cost; revisit if plan review feedback shows recurring divergent-draft problems.

### D7: Labels and dashboards treat the new steps as first-class registered steps
Step definitions carry labels ("Fusion planning", "Plan fusion"); dashboard phase rendering keys off registered step identity already, so changes there are limited to label/phase-list additions — no engine plumbing changes.

## Risks / Trade-offs

- [Concurrent adapter launches exceed local resource or rate limits] → Profiles already bound executable/model; document that heavy fan-outs should use smaller models; N ≤ 5 bounds worst case. No queueing mechanism added (YAGNI).
- [Dashboard/runtime views assume a single active run per workflow] → Multi-run handoffs are already a validated state-runtime scenario, but view code may render only one run; tasks include verifying/extending run listing for `fusion.plan`.
- [One persistently failing planner stalls fusion] → Pinned retry limit (3) per planner role; exhausted role follows the step's failed routing without discarding surviving drafts, so a restart of the failed role resumes collection rather than re-fanning everyone.
- [Consolidator lazily copies one draft] → Instruction asset requires explicit reconciliation notes; plan review is the human gate and can bounce the result (D6).
- [Draft schema too rigid for exploratory features] → `questions` array is the sanctioned escape hatch; schema evolution would be `core.plan-draft@2` behind a new definition version.

## Migration Plan

Purely additive: register new steps and the `plan-fusion` definition at engine start; regenerate `embedded.generated.ts` via build; no persisted-state migration (existing workflows pin their current definitions). Rollback = stop offering `plan-fusion` at start; in-flight plan-fusion workflows finish against their pinned digest.

## Open Questions

None blocking. (Exact CLI surface for passing the model list at start can follow the existing start-command flag conventions during implementation without changing specs.)
