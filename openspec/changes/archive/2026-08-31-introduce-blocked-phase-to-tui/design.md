## Context

The dashboard Change panel currently derives its STATUS badge text from `state.stepLabel` (falling back to `state.phase`) and derives its animation from workflow terminality. When an agent hands off `blocked`, the workflow remains on the same current step, the run is recorded with status `blocked`, and the workflow status becomes `attention-required`. Rendering only the phase label hides the reason progress stopped. Other attention-required causes, such as invalid state or failed effects, do not necessarily represent a blocked phase and must not be mislabeled.

## Goals / Non-Goals

**Goals:**

- Make a blocked current phase immediately visible in the Change panel's phase/status area.
- Keep the current phase label as the primary phase information.
- Keep workflow terminality as the source of the existing phase badge animation.
- Use the existing dashboard projection and run state without changing workflow persistence or APIs.

**Non-Goals:**

- Changing workflow transition, retry, or blocked-handoff semantics.
- Replacing the phase label with an agent role or activity status.
- Labeling every `attention-required` workflow as blocked.
- Adding a new workflow status or external interface.

## Decisions

- **Derive the marker from the current step's committed run state.** The dashboard will identify a blocked phase from a run whose `stepId` matches the current step and whose status is `blocked` (together with the workflow's attention-required state). This avoids treating unrelated attention diagnostics or stale blocked runs from an earlier phase as a current blocked phase. Alternatives considered: using `status === "attention-required"` alone would over-report effect and health issues; using agent observations would confuse runtime activity with committed workflow state.
- **Render a separate static blocked indicator beside the phase badge.** The phase badge continues to show the registry label/raw phase and keeps its existing terminality-based animation. A distinct warning-styled `BLOCKED` indicator communicates attention without replacing the phase or blending in a role name. Alternatives considered: replacing the label loses the user's phase context; appending text to the phase badge makes the phase value and attention state less separable.
- **Test the presentation at the dashboard UI boundary.** Focused tests will render a blocked current-step fixture and verify both the phase label and separate marker, plus verify that ordinary active agents and unrelated attention do not produce the marker. This keeps the behavior change-specific without requiring repository-wide test commands in the worker task.

## Risks / Trade-offs

- [Risk] A blocked run can remain in historical run data after the workflow advances. → Match the run to the current step and attention-required state before showing the marker.
- [Risk] The extra indicator consumes horizontal space in narrow terminals. → Use the existing compact badge component and keep the marker text bounded to `BLOCKED`.
- [Risk] Existing consumers may assume the STATUS row contains only one badge. → Preserve the existing phase badge and add the marker as an adjacent, independently rendered element; update focused snapshots/assertions if needed.
