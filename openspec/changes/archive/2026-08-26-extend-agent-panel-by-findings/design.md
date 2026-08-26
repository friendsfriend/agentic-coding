## Context

The dash already loads and validates committed `core.findings` artifacts in `src/tui/dash/data.ts`, and `FindingsModal` can display their individual entries. `DashboardData.agents` currently carries role, status, model, cost, and telemetry metrics, while `App.tsx` renders each agent as a bounded selectable row. The verifier result lookup is scoped to the current `verificationRound`, so it provides the correct source for an inline summary without changing workflow state or verifier contracts.

The panel has a fixed layout and a scrollable agent list. Existing rows use a role/status line, a model/verdict line, and an optional metrics line. The new summary must not make the panel wider or introduce a second source of truth for findings.

## Goals / Non-Goals

**Goals:**

- Expose current-round committed verifier finding totals by `critical`, `warning`, and `info` on the corresponding Agents-panel rows.
- Preserve the distinction between a committed verifier result containing zero findings and a verifier result that is not available yet.
- Render severity totals with the dashboard's theme-backed error, warning, and info colors.
- Keep summaries bounded within the existing scrollable Agents panel and retain existing metrics and `v` result-popup behavior.
- Cover data derivation and visible rendering with focused dashboard tests and demo data.

**Non-Goals:**

- Changing `core.findings` validation, verifier verdict calculation, workflow state, telemetry aggregation, or persisted artifacts.
- Adding a new findings popup, navigation command, filtering behavior, or per-finding interaction.
- Summarizing findings from prior verification rounds or non-verifier agents.
- Changing the existing cost/metric display contract.

## Decisions

### Store a typed count summary on each agent

Add an optional `findingCounts` value to the dashboard agent view with numeric `critical`, `warning`, and `info` fields. In `loadDashboard`, derive it from `committedVerifierOutput(state, role)` for verifier roles in the current round, counting each validated finding exactly once. Return `undefined` when there is no committed, digest-valid result yet; return all three zero-capable counters when a committed result has no findings.

This keeps the UI presentation independent from artifact parsing and makes the distinction between unavailable and zero explicit. Calculating counts in the JSX would couple rendering to workflow artifact details and invite duplicate filtering logic. The existing test dashboard will provide typed fixture counts because it has no filesystem-backed committed artifacts.

### Render one compact severity summary per available verifier result

Add a small render helper/component in the Agents-panel path that emits `critical`, `warning`, and `info` labels/counts in a stable order. Use `uiColors.error`, `uiColors.warning`, and `uiColors.info` respectively, with separate text nodes so each severity retains its color. Render the summary only when `findingCounts` is present; do not show zero placeholders for an unavailable verifier result.

Place the summary in one bounded row within each agent card, alongside the existing row structure or as the single additional optional row needed by the card. Keep `width="100%"`, `minWidth={0}`, and overflow behavior so long content cannot affect the grid. The selectable list remains responsible for scrolling when the additional row reduces the number of visible agents.

### Use current-round committed artifacts as the source of truth

Reuse `committedVerifierOutput` rather than reading raw output files a second time or using `verifierTimeline` verdicts. The helper already enforces completed status, output existence, digest matching, envelope identity/version, and finding shape. This ensures counts cannot be shown for stale, malformed, or prior-round results and does not alter the existing popup behavior.

### Extend demo fixtures and focused tests

Add representative count values to the demo verifier rows, including non-zero counts for all severities and a zero-count severity, plus an agent without a committed-result summary. Test the count derivation independently from a committed findings payload where practical, and test the rendered frame for labels/counts and existing metric preservation. Use the existing theme color mapping in the implementation; tests should assert the semantic rendering behavior without hard-coding a theme palette.

## Risks / Trade-offs

- **Additional row height can show fewer agents at once.** → Keep the summary to one compact line, retain the fixed panel dimensions, and rely on the existing selectable-list scrolling; verify rendering at the focused dashboard test width.
- **No committed result means no visible count, which may be mistaken for zero.** → Treat unavailable and empty results differently in the data model, and test both states; the existing verifier status still communicates run availability.
- **Theme colors may vary by configured theme.** → Use only `uiColors.error`, `uiColors.warning`, and `uiColors.info`, never hard-coded RGB values.
- **Malformed or stale artifacts could otherwise leak counts.** → Reuse the existing committed-output validation path and leave invalid output as unavailable.

## Migration Plan

No migration or deployment step is required. Implement the optional dashboard field and UI, run focused dashboard tests plus type-check/lint, and ship. Rollback is a code revert; existing artifacts and workflow state remain compatible because the new field is derived and optional.

## Open Questions

None. The summary is current-round only, and unavailable verifier outputs are intentionally omitted rather than rendered as zero.
