## Context

The workflow registry and CLI already define `plan-fusion`, including the `fusion.plan` fan-out and `fusion.consolidate` step. The dashboard's `NewWorkflowModal` currently offers only `standard`, `direct-apply`, and `quick`. Its in-process start bridge also derives agent roles independently from the CLI and does not currently create the 2–5 planner routes required by `plan-fusion`.

The dashboard `ModelConfigModal` edits preset step assignments and verification roles, but has no fields for fusion planner roles or the consolidator. Presets are persisted through the existing managed `[agents]` configuration path, and routing already supports per-step and per-role assignments.

## Goals / Non-Goals

**Goals:**

- Make `plan-fusion` selectable and startable from the dashboard.
- Make a dashboard-managed preset able to configure the ordered fusion planner profiles and consolidator profile.
- Reuse the existing workflow definition, routing precedence, validation, and engine lifecycle rather than creating a dashboard-specific workflow.
- Keep existing workflow choices, preset formats, and config-default behavior unchanged for workflows other than plan-fusion.

**Non-Goals:**

- Changing the plan-fusion graph, planner draft schema, retry policy, or runtime protocol.
- Adding a second fusion-specific configuration format or CLI flag to the dashboard.
- Redesigning profile editing or model discovery.

## Decisions

1. **Expose the existing definition ID directly.** Add `plan-fusion` to the modal's workflow choices and map it to the existing definition ID, with a display label such as `Plan Fusion`. Keep `quick` mapped to `no-openspec` as today; do not duplicate or rename definitions.

2. **Represent planner fan-out with preset role assignments.** Extend the preset editor with `fusion.plan` roles `planner-1` through `planner-5`, plus a `fusion.consolidate` step assignment. Empty planner fields are omitted, allowing a preset to define 2–5 planners. The start bridge determines the ordered planner count from the configured planner role entries, then uses the shared role-to-route resolution so per-role, step, preset-default, and global fallback precedence remains consistent. It validates that the entries form a supported 2–5 planner set and resolve to distinct profiles before calling the engine.

3. **Share role derivation instead of maintaining two mappings.** Reuse or extract the existing CLI `rolesForDefinition` logic for the dashboard start path, passing the selected planner count for `plan-fusion`. This ensures the dashboard creates `planner-1`…`planner-N` and `consolidator` routes with the same role names used by the engine and CLI.

4. **Preserve arbitrary preset role tables.** The preset editor will continue to preserve role tables it does not edit. Its draft/save handling will add or update the known fusion role entries without collapsing existing verification or other role assignments. Empty optional fields are omitted using the existing `(unset)` behavior.

5. **Fail before launch for unusable fusion configuration.** A dashboard start of `plan-fusion` with fewer than 2 or more than 5 planner assignments, non-contiguous planner roles, duplicate resolved profiles, or an unresolved required route will show the existing workflow-start error and launch no agents. A valid selected preset routes its consolidator through `fusion.consolidate` and the planners through their ordered roles.

### Alternatives considered

- **Add a separate planner-profile wizard to `NewWorkflowModal`:** rejected because it duplicates preset management and would create a second routing configuration surface.
- **Use one `fusion.plan` step assignment for every planner:** rejected because plan-fusion requires distinct per-planner model routings and the existing routing contract already supports role overrides.
- **Change the workflow engine to infer planner count from arbitrary defaults:** rejected because it would make a persisted routing ambiguous and could silently launch duplicate profiles; the dashboard should produce explicit, validated planner routes.

## Risks / Trade-offs

- [A preset can be edited into an invalid planner set] → Validate the ordered count, role shape, and distinct resolved profiles before `engine.start`; retain the engine's existing defensive routing validation.
- [The editor has existing arbitrary role tables] → Preserve unknown tables verbatim and add focused tests for round-trip persistence.
- [A config may contain no usable preset or runtime executable] → Reuse existing preset coverage and profile preflight errors; no workspace or agent effects occur before validation completes.
- [The dashboard and CLI could drift in role derivation] → Share the role derivation helper and test both paths against the same planner role names.

## Migration Plan

No data migration is required. Existing presets remain valid because the new fusion fields are optional and omitted when unset. Users create or edit profiles and a preset from `m`, assign at least two distinct fusion planner roles and a consolidator (or a valid fallback), then select that preset when choosing Plan Fusion from `n`. Rollback is removing the new UI choices and fields; existing config entries and non-fusion workflows remain readable.

## Open Questions

- None blocking implementation; the existing engine's 2–5 distinct-profile contract defines the validation boundary.
