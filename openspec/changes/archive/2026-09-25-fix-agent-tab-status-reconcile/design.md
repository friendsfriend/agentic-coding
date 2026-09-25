# Design

## Context

See `proposal.md` for motivation and `specs/agent-tab-status/spec.md` for the behavior contract.

Current state that shapes the approach:

- `WorkflowView.runs` is the full run history for a workflow, ordered by creation (`rowid`) — `runs()` in `src/workflow/runtime/store.ts`. Every run that shared an agent identity can appear on the same `tabId`.
- `syncAgentTabLabels` (`src/workflow/tab-sync.ts`) groups **all** of those runs by `tabId` and aggregates their raw statuses with `aggregateAgentTabStatus` (`src/workflow/tab-status.ts`). Its priority order is `working > pending > failed > blocked > completed > expired`, so any historical `failed`/`blocked`/`working` run outlives a newer terminal run.
- The dashboard already projects one run per role with `latestRunsByRole` (`src/workflow/run-projections.ts`), documented as the single per-role projection shared by the pane map (`viewToDashboardState`) and the agent list (`loadDashboard`). The tab reconcile does not use it, so the two surfaces can disagree.
- `paneForRunFactory` (`src/workflow/cli/pane.ts`) resolves a live agent with `resolveLiveAgentAsync`, whose `LiveAgent` carries `tabId`, but the reuse branch returns only `{ paneId, owned: false }`. The `agent.launch` observe path does persist `tabId` on reuse, so the drop only surfaces on a launch race or any other allocation caller, but a run with no `tabId` is invisible to the reconcile.

## Goals / Non-Goals

**Goals:**

- Make the tab glyph depend only on the current (latest) run per role on that tab, so superseded attempts, generations, and rounds cannot pin it.
- Keep tab naming and dashboard agent status derived from the same per-role notion of "current run".
- Ensure a run that reuses an existing agent pane still records its tab so it is reconciled.
- Keep the change pure/local: no engine, store, schema, or effect-contract changes.

**Non-Goals:**

- Changing the glyph map, the urgency order, or the tab-label rendering (`tab-status.ts`'s `TAB_STATUS_GLYPHS`/`TAB_STATUS_PRIORITY` stay).
- Tracking live Herdr agent process status (idle/working) independently of workflow run status.
- Fixing the reconcile cost of listing every workflow on every drain, or owning tab-close lifecycle.
- Changing `latestRunsByRole`'s role-only keying across steps (pre-existing dashboard behavior).

## Decisions

### Reduce to the latest run per role within each tab, not per tab across the workflow

`syncAgentTabLabels` will group runs by `tabId`, then within each tab keep the last run per `role` in `view.runs` order (creation order), and aggregate those statuses. This mirrors the dashboard's "latest run per role" while staying local to the tab: grouping per tab first preserves a tab's only run even when the same role later runs in a different step/tab, whereas applying `latestRunsByRole` globally could drop that tab's run and leave it un-reconciled.

Alternative considered: reuse `latestRunsByRole(view.runs)` directly. Rejected because it keys by role across the whole workflow and picks by `attempt`; a role that also runs in a later step could mask an earlier step's tab, and a same-attempt re-entry relies on iteration order that the global helper only approximates.

Alternative considered: filter out `expired` runs. Rejected because it does not address `failed`/`blocked`/`working` superseding a newer `completed`.

Alternative considered: change the priority order so `completed` outranks `failed`/`blocked`. Rejected because a genuinely failed latest run must stay visible, and aggregated shared tabs need the existing urgency semantics.

The pure selection lives beside the existing pure mapping. A helper in `src/workflow/tab-status.ts` takes the run slice (`role`, `status`, optional `tabId`) and returns `tabId -> latest status per role[]`; `tab-sync.ts` then runs `aggregateAgentTabStatus` on each list. Keeping it pure keeps it unit-testable without Herdr or the engine.

### Record the adopted tab id in the allocation result

The reuse branch of `paneForRunFactory` will spread the resolved `tabId` into its `{ paneId, owned: false }` result, matching the fresh-launch branch that already returns the created `root_pane.tab_id`. This makes the `agent.launch` execute path persist the same tab id the observe-reuse path already persists, closing the race where a reused run has a pane but no tab.

Alternative considered: copy the tab id from a prior run of the same role. Rejected because the allocation boundary already has the live agent's authoritative `tab_id`; duplicating it from history would drift when the agent moved tabs.

### Leave the drain-boundary trigger where it is

The reconcile stays in `drainEffects` (`src/workflow/operations.ts`), after the drain that commits status transitions, as the one boundary owning both the engine and the Herdr port. No new effect kind or outbox record is introduced, so no step's pinned effect contract changes.

## Risks / Trade-offs

- **A tab whose only runs are superseded by a later step's role is skipped.** → Accepted: that tab keeps its last rendered label, which is its correct terminal state; the alternative (global `latestRunsByRole`) risks un-reconciled tabs.
- **`pnpm`/CI tests that assert the exact reuse result shape may need updating.** → The existing `paneForRunFactory` reuse test asserts `{ paneId, owned }`; it will be extended to have the fake live agent return a `tab_id` and assert the `tabId`, and the fresh-launch assertions are unchanged.
- **`view.runs` must stay creation-ordered for "last wins per role".** → It is produced by a `rowid`-ordered query; the helper documents the ordering and the tests feed runs in creation order. If engine ordering ever changes, the helper should switch to an explicit recency key.
- **Reconcile still lists every workflow each drain.** → Pre-existing (`QUALITY-002`); out of scope for this change.

## Migration Plan

No data or schema migration. Deploying the new build changes only how tab labels are computed and persisted; the next drain re-renders each tab from the latest-per-role status. Rollback is reverting the build; labels re-render from the same stored runs.

## Open Questions

None that affect the spec, approach, or task breakdown.
