# Design

## Context

All run-to-pane allocation goes through `paneForRunFactory` in `agentic-coding/src/workflow/cli/pane.ts`. It reads the run's `StepBehavior` from the step registry, derives a layout group, tries to resolve an existing live agent by canonical identity, and only then allocates a pane. When a round-scoped group has two or more live siblings it splits panes into a grid; otherwise it creates a tab labeled `agentTabLabel(group ?? run.role, run.status)`.

Today `roundScoped` is overloaded: it drives both canonical agent naming (`canonicalAgentName` / `legacyRunName` in `effect-runner.ts`) and the layout group. `core.verification` declares `roundScoped: true, paneGroup: "verification"`, so every verifier role shares one group and the grid branch packs them into short stacked panes. `core.triage` declares `roundScoped: true, paneGroup: "triage"`, which is already a de facto per-step group with a single role.

Agent identity is derived from `workflowId` / `definitionId` / `stepId` / `role` (a SHA-256 digest), not from the pane group, so identity is already stable across rounds. See proposal.md for the motivation.

## Goals / Non-Goals

**Goals:**

- Give each verifier role its own full-height Herdr tab labeled `<status glyph> <role>`, allocated through the existing `paneForRunFactory` path.
- Preserve `core.verification`'s stable cross-round agent identity so in-flight verifier agents are not orphaned and later rounds reuse their existing tab.
- Keep triage on its own `triage` tab and keep `syncAgentTabLabels` semantics unchanged.

**Non-Goals:**

- Adding a tab-group/folder primitive to Herdr or a new dependency.
- Changing `canonicalAgentName` / `legacyRunName` shapes or the `roundScoped` naming flag.
- Forcibly relocating an in-flight verifier agent out of a legacy shared `verification` tab.
- Touching dashboard/git tab creation or the Herdr sidebar integration.

## Decisions

### Add an explicit `groupByRole` layout-group flag

`StepBehavior` gains `groupByRole?: boolean`. `paneGroup(behavior, role)` resolves a group as: `undefined` for non-round-scoped steps; the run's `role` when `groupByRole === true`; otherwise `behavior.paneGroup ?? "verification"`. `core.verification` keeps `roundScoped: true` and `paneGroup: "verification"` but adds `groupByRole: true`. `core.triage` is unchanged (`paneGroup: "triage"`, no `groupByRole`).

Alternative considered: make `paneGroup` a function of the run (e.g. `paneGroup: ({ role }) => role`). Rejected because `StepBehavior` maps are declarative data consumed by several readers (registry, dashboard, docs); a boolean flag keeps them inspectable and serializable, and the only per-run variation needed today is "use the role".

### Decouple layout grouping from the `roundScoped` naming flag

`roundScoped` stays `true` on `core.verification`. It continues to control the short canonical/legacy name prefix, which is what makes a verifier's identity stable across rounds; removing it would change `canonicalAgentName` and `legacyRunName` shapes and could orphan in-flight agents. Layout is decoupled by letting `groupByRole` override the group while naming is untouched.

Result: for `core.verification`, `group === run.role`. The round-scoped sibling filter — which compares candidate groups against the launching run's group — now only matches runs for the same role. A role's group therefore always has exactly one member, so the `n >= 2` grid branch is never entered and allocation falls through to `tab create` with base `group ?? run.role`, i.e. the role name.

### Thread the run's role through both `paneGroup` call sites

`paneGroup()` gains a `role` parameter, and the `paneForRunFactory` sibling filter passes each candidate run's `item.role` when computing its group, so the group comparison is per-role for `groupByRole` steps and per-constant-group for others. No other reader of the group concept changes.

### Keep the generic grid allocation path

The grid/split machinery (`bottomPane`, the `n >= 2` branches, `verificationPosition`) is left in place as a generic engine capability for any step that still opts into one shared constant group. No built-in definition uses a multi-role shared group after this change (triage is a single role), so the path is no longer exercised by `openspec-full`; focused tests keep it covered with a synthetic shared-group behavior and cover the new per-role behavior through `openspec-full`.

Alternative considered: delete the grid path and `verificationPosition` as dead code. Rejected because it is a larger, riskier diff that is not required by the behavior change, and the task's recommended approach explicitly retains the sibling-filter/grid call site.

### Labeling and reconcile stay role/tab driven

`agentTabLabel`, `latestStatusesByTab`, and `syncAgentTabLabels` are unchanged. Because each verifier role now occupies its own tab, per-tab aggregation collapses to that role's latest status, and the reused-pane handle (which already carries `tabId`) reconciles each run onto the tab it occupies. Only the now-stale "verification shares one tab" comment in `tab-status.ts` is updated.

## Risks / Trade-offs

- [An in-flight workflow started before this change already has verifier roles sharing a legacy `verification` tab; reuse-before-spawn keeps them there until the workspace closes] → Accept as a transition artifact: this change governs new allocations and new workflows; forcing a running agent into a new tab would require stopping/recreating it, which the lifecycle contract forbids. New workflows get per-role tabs immediately, and the migration is complete for workspaces created after the change.
- [The round-scoped sibling filter now yields a single-member group per verifier role, so a genuinely concurrent re-entry for the same role in the same attempt would still create a second tab rather than reusing a sibling] → This is the existing reuse-before-spawn guarantee: `resolveLiveAgentAsync` runs before grouping and reuses the live canonical agent, so a same-role re-entry resolves the existing pane and never reaches tab creation.
- [A stale recorded per-role tab id could be targeted after the tab closes] → Unchanged handling: the resolver only adopts confirmed-live agents, and the fallback creates a fresh tab for the role, still excluding tabs owned by dashboard, git, worker, planner, recovery, or archive.

## Migration Plan

No data or store migration. Agent names are unchanged, so in-flight verifier agents keep resolving. Deploy the code and spec/docs updates together; rollback is reverting the behavior flag and `paneGroup` signature, which restores the shared-group split for subsequent allocations.
