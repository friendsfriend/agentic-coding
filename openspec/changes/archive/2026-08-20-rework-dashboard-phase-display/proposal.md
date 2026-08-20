## Why

The dashboard's Change panel STATUS row currently blends two different signals into one label: the workflow's current phase and whether some agent happens to be busy right now (overriding the phase label with "Planning"/"Verifying"/"Applying" whenever any agent is "working"). Agent activity is already shown per-role in the Agents panel, so this overlay is redundant and makes the STATUS row lie about the actual workflow phase (e.g. showing "Verifying" while the phase is really `developer-review` once the last verifier agent finishes but the memo re-evaluates). Removing the overlay makes STATUS a trustworthy, single-purpose readout of workflow phase.

## What Changes

- Remove the agent-status overlay from the dashboard's Change panel STATUS row (`workflowStatus` in `src/tui/dash/App.tsx`): it currently substitutes the phase label with "Planning"/"Verifying"/"Applying" whenever it finds an agent with `status === "working"`.
- STATUS row displays only the workflow phase label (`state.stepLabel ?? state.phase`), matching how phase is already shown in the header and in the Home overview list.
- The badge's "working" (animated) visual state is now derived purely from whether the workflow phase is non-terminal (i.e. not `completed`/`closed`), not from any individual agent's busy state.
- **BREAKING** (test-visible only): the demo/test dashboard profile no longer surfaces "Planning"/"Verifying"/"Applying" text in the STATUS row; it shows the raw phase value (e.g. `verify`) instead. Existing dashboard tests asserting on those transient labels must be updated to assert on the phase value.

## Capabilities

### New Capabilities
- `dashboard-phase-status`: The dashboard Change panel STATUS row shows only the workflow's current phase, independent of any agent's activity status.

### Modified Capabilities
(none — no existing spec capability currently documents this behavior)

## Impact

- Affected code: `src/tui/dash/App.tsx` (`workflowStatus` memo and its Badge usage in the Change panel).
- Affected tests: `test/dash/userActions.test.tsx` (asserts on the transient "Verifying" label produced by the old overlay) needs updating to assert on the phase value shown after the change.
- No API, persistence, or workflow-engine changes; purely a dashboard TUI rendering change.
