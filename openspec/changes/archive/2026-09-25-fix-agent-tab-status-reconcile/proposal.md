# Proposal

## Why

Managed agents live for the whole workspace and are reused across attempts, rounds, and generations, but the Herdr tab-status reconcile aggregates **every run that ever shared a tab**. A superseded `failed`/`blocked` run therefore keeps the tab stuck on ■/✗ after a later run completes, so an agent that "finishes and starts working again" never shows the new state. A second, related gap: when pane allocation adopts an existing live agent's pane it drops the resolved tab id, so that reused run can never be reconciled onto its tab at all. The dashboard already projects the latest run per role, so the tab and the dashboard disagree about the same agent.

## What Changes

- Reconcile each agent tab from the **latest run per role on that tab** instead of every historical run, so a superseded attempt, generation, or round can no longer pin the glyph. This matches the dashboard's per-role projection.
- Persist the adopted pane's **tab id** when a launch reuses an existing live agent, so the reused run is visible to the tab reconcile.
- Keep the reconcile idempotent, best-effort, and driven from the same post-drain boundary so a status transition is reflected in the tab name.
- Add focused tests for the latest-run-per-role aggregation, the reused-tab-id handle, and the drain-boundary reconcile.

## Capabilities

### New Capabilities
- `agent-tab-status`: the one-glyph Herdr tab label that shows the current run status for each role on a tab, and the post-drain reconcile that keeps it in sync with persisted run status.

### Modified Capabilities
<!-- No existing capability's requirements change; the reused-pane tab identity is a new concern of the new capability. -->

## Impact

- `agentic-coding/src/workflow/tab-sync.ts` — aggregate the latest run per role per tab.
- `agentic-coding/src/workflow/tab-status.ts` — pure selection/aggregation helper for the per-tab, per-role run set.
- `agentic-coding/src/workflow/cli/pane.ts` — return the adopted pane's `tabId` on reuse.
- Tests: `agentic-coding/test/workflow-tab-sync.test.ts`, `agentic-coding/test/workflow-tab-status.test.ts`, `agentic-coding/test/workflow-cli.test.ts`.
- No API, schema, or dependency changes; the glyph map and reconcile trigger stay as they are.
