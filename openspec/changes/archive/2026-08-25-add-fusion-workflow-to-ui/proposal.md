## Why

The `plan-fusion` workflow is already registered and supported by the workflow engine, but dashboard users cannot start it from the new workflow modal. Its planner and consolidator routes are also absent from the preset editor, so the workflow cannot be configured through the dashboard's profile/preset management opened with `m`.

## What Changes

- Add `plan-fusion` to the dashboard new-workflow workflow type choices and display it with its user-facing label.
- Make dashboard startup resolve the fusion workflow's planner fan-out and consolidator routes from the selected preset, including the required distinct planner profiles.
- Extend the agent preset editor with the plan-fusion step and role assignments needed to configure its planner and consolidation agents.
- Preserve existing standard, direct-apply, quick, and config-default behavior.
- Add or update dashboard and routing tests for selecting plan-fusion and persisting/using its preset assignments.

## Capabilities

### New Capabilities

### Modified Capabilities

- `workflow-plan-fusion`: Expose the existing plan-fusion workflow through the dashboard workflow-selection flow, with its required UI-start configuration.
- `agent-configuration-presets`: Allow dashboard preset management and preset-based routing to cover the plan-fusion fan-out and consolidation roles.

## Impact

Affected areas are the dashboard new-workflow modal and dashboard start bridge, the model configuration modal's preset fields, and their tests. No workflow engine graph, runtime protocol, or external API changes are intended; the existing `plan-fusion` definition and CLI semantics remain the source of truth.
