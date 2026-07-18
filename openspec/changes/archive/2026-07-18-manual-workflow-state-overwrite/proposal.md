## Why

A managed Herdr workflow can remain in a phase whose next command no longer matches real workspace state. `phase` deliberately rejects invalid transitions, so developer cannot repair that state through dashboard or CLI.

Recovery has separate contract break: recovery agent is told to "Output plan only" while dashboard only consumes `.herdr-workflow/<change>/reviews/recovery-plan.json`. Agent can emit valid JSON to chat without creating plan artifact, leaving recovery unavailable.

## What Changes

- Add explicit, confirmed manual phase override for active workflows. It writes selected operational phase directly, bypassing normal transition graph, while preserving all other workflow state.
- Add `herdr-workflow override-phase` CLI command and dashboard phase picker/confirmation for same operation.
- Record each override with source and target phase in workflow telemetry.
- Repair recovery plan handoff: recovery prompt/skill require writing exact plan artifact, each recovery run has an identifier, stale or mismatched plans are ignored/rejected, and controller validates plan action against current state before executing it.

## Capabilities

### New Capabilities
- `herdr-workflow-state-override`: Developer can explicitly overwrite active workflow phase through dashboard or CLI after confirmation.
- `herdr-recovery-plan-handoff`: Recovery produces a run-bound file artifact consumed by dashboard/controller rather than chat-only JSON.

## Impact

- `pi/bin/herdr-workflow`: override command, recovery run/plan validation, telemetry.
- `pi/skills/herdr-openspec-recovery/SKILL.md`: file-first recovery-plan contract.
- `agent-dash/src/App.tsx`, `agent-dash/src/data.ts`: phase override picker and valid recovery-plan display.
- Focused workflow regression script plus `agent-dash` type-check.
