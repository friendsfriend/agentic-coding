## Context

The workflow engine already persists a resolved runtime on every `WorkflowRun` (`pi`, `opencode`, or the internal `opencode-v2` identifier), and `viewToDashboardState` passes the complete run list into dashboard state. The dashboard's `DashboardData.agents` projection currently retains role, status, model, cost, and metrics but drops runtime. The Agents panel then renders the selected model on the second row, leaving no indication of which runtime executes that agent.

The change is presentation-only: it must use the pinned run metadata, avoid runtime re-resolution, and preserve the existing two-line agent identity area and bounded overflow behavior.

## Goals / Non-Goals

**Goals:**

- Preserve the latest run's runtime in each dashboard agent projection.
- Render a stable, compact runtime/model value on the existing model line.
- Show `opencode-v2` as `opencode2` in the UI while leaving workflow contracts and routing identifiers unchanged.
- Keep model and runtime text truncated by the existing row container.
- Cover projection, label normalization, and rendered panel output with focused tests.

**Non-Goals:**

- Changing runtime routing, adapter behavior, profile configuration, or workflow persistence.
- Renaming the internal `opencode-v2` runtime identifier.
- Adding a third agent-row line, a runtime filter, or a new dashboard panel.
- Displaying runtime in unrelated modals or overview lists.

## Decisions

1. **Reuse the run projection rather than infer runtime from profile or executable.**
   Add an optional runtime field to the dashboard agent view and populate it from the latest run selected for that role. This keeps the display tied to the workflow's pinned routing and works even when executable names are customized. The alternative—deriving it from the executable—would mislabel configured aliases and duplicate routing knowledge in the UI.

2. **Render runtime and model together on the existing identity line.**
   Compose the displayed value as `runtime · model` when both are available, or show whichever value is available. Keep the existing fallback messages when neither is available. This satisfies the same-line requirement without changing panel height; the alternative of a separate runtime line would increase row height and reduce dashboard density.

3. **Normalize only the presentation label for OpenCode V2.**
   Map the internal `opencode-v2` value to `opencode2` at the UI boundary; pass `pi` and `opencode` through unchanged. This matches the requested runtime names while preserving the contract and adapter identifier used by the engine. Unknown runtime strings remain visible rather than being silently discarded, so future runtimes are diagnosable.

4. **Use focused dashboard tests.**
   Extend the data projection fixture/assertion to verify runtime propagation and add an Agents panel rendering assertion covering the runtime/model pair and the OpenCode V2 label. Existing layout and metrics tests remain the regression checks for row bounds and unchanged metric behavior.

## Risks / Trade-offs

- **[Long runtime/model text can consume the identity line]** → Keep the existing `overflow="hidden"`, `flexGrow`, and `minWidth={0}` container; do not add fixed-width runtime columns.
- **[Historical or synthetic runs may omit runtime]** → Make the dashboard field optional and retain the current model/fallback rendering when runtime is absent.
- **[The internal V2 name could leak into the UI]** → Centralize the display mapping at the render boundary and test the `opencode-v2` → `opencode2` case.

## Migration Plan

No data migration or deployment sequencing is required. Deploy the dashboard projection and rendering change together; rollback is a code revert, with existing workflow snapshots remaining compatible because their runtime values and schema are unchanged.

## Open Questions

None.
