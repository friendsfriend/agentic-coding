## Why

Over time, workflow agents stop reusing their existing panes and spawn in fresh tabs instead. The root cause is fragile identification: agent names truncate the change ID against Herdr's 32-character cap (allowing cross-workflow collisions), pane reuse depends entirely on a single name-based lookup that silently falls through to "create a new tab", and persisted handles mix two identity domains (agent name vs pane id) so any staleness produces a relaunch rather than a reuse.

## What Changes

- Introduce a single, collision-free agent naming scheme: every workflow-scoped identity (change + step + role [+ round]) maps deterministically to one unique agent name within Herdr's constraints, without lossy truncation of the discriminating part.
- Make pane reuse authoritative: launching a run SHALL first resolve any live agent for the same workflow identity (via the engine-persisted handle, then the canonical agent name) and reuse its pane; a new tab/pane SHALL be created only when no live agent exists.
- Separate identity domains cleanly: agent handles record both agent name and pane id, and lookups distinguish "find the agent" (by name) from "talk to the agent" (by its live pane id); a dead pane invalidates the handle without discarding the agent identity.
- Fix the Pi telemetry bridge's run-environment recovery so it derives the run identity from the same naming scheme instead of assuming an 8-hex-char name suffix (which persistent-role names never had).
- Remove ad-hoc geometry heuristics from identity decisions: verification pane-ordering logic keys off verified live sibling agents, never raw stored pane ids alone.

## Capabilities

### New Capabilities
- `agent-pane-identity`: Deterministic, collision-free agent naming and pane reuse rules for workflow-managed agents — how identities are derived, how live agents/panes are resolved before spawning new ones, and how stale handles recover.

### Modified Capabilities
(none — existing specs describe assignment delivery and lifecycle authority, which stay unchanged)

## Impact

- `agentic-coding/src/workflow/effect-runner.ts` (`runName`, `agent.launch` observe/execute)
- `agentic-coding/src/workflow/cli.ts` (`paneForRun`)
- `agentic-coding/src/workflow/adapters.ts` (`HerdrLifecycle.start`, handle construction)
- `agentic-coding/src/workflow/embedded.generated.ts` (pi-telemetry bridge name parsing — regenerated, not hand-edited)
- Existing running workflows keep working: legacy names remain resolvable during a transition window, but newly launched agents use the new scheme.
