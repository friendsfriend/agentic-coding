## Context

The dashboard's `NewWorkflowModal` builds its wizard fields dynamically. It currently inserts the multiline `task` field only for `standard` and `quick`; `plan-fusion` falls through to the shorter base sequence. The modal already owns a `task` value, and `Home` passes the completed input to `startWorkflow`. The dashboard engine's `startArgs` and in-process startup already forward a non-empty task into workflow metadata, where the fusion planner assignment renderer can use it as the objective.

## Goals / Non-Goals

**Goals:**

- Make the task field available in the plan-fusion wizard using the same multiline editing and navigation behavior as standard and quick.
- Preserve the entered task through the existing `NewWorkflowInput` → dashboard startup → workflow metadata path.
- Verify both modal submission and startup argument forwarding with focused regression tests.

**Non-Goals:**

- Do not alter workflow graph composition, fusion routing, planner count validation, or runtime task rendering.
- Do not add a task field to direct-apply.
- Do not change task validation, persistence, APIs, or agent configuration.

## Decisions

- **Treat plan-fusion as task-driven in the existing field-selection branch.** Add `plan-fusion` to the condition that includes `task`, rather than creating a separate wizard flow. This reuses established textarea behavior, help text, ordering, and summary rendering while keeping direct-apply on the existing base sequence.
- **Reuse the existing startup plumbing.** Keep `Home`, `startWorkflow`, `startArgs`, and workflow runtime contracts unchanged because they already accept and forward `task`; the implementation only needs to ensure the modal collects it for plan-fusion. Tests will assert the existing forwarding contract so a future regression cannot silently discard the objective.
- **Extend the plan-fusion modal regression path.** Update the plan-fusion selection test to enter a representative task and account for the additional wizard step, then assert the submitted task. Add or extend a dashboard data/start-argument test if needed to demonstrate that this value reaches startup unchanged.

## Risks / Trade-offs

- [Risk] Adding a wizard step changes keyboard navigation for plan-fusion users → Mitigation: use the same task placement and controls already used by standard and quick, and update focused modal tests.
- [Risk] A blank task remains possible because the existing task field is optional → Mitigation: preserve existing standard/quick semantics; the workflow's current validation and objective handling remain authoritative.

## Migration Plan

No migration is required. Existing plan-fusion starts without task metadata remain valid. Deploy the modal and regression-test change together; rollback is limited to reverting the field-selection condition and test update.

## Open Questions

None.
