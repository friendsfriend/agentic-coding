# Tasks

## 1. Decision record contract

- [x] 1.1 Add the decision record types (`integration`, `questionId`, `phase?`, `model`, `input`, `inputTruncated`, `options`, `answer`, `result`, `id`, `at`) to `agentic-coding/src/contracts/workflow.ts`; add the optional `classifierDecisions` field to `WorkflowSnapshot`, `WorkflowView` and `WorkflowState`, and the matching optional field in `workflowViewSchema`. Verify with the existing contract suites: `cd agentic-coding && bun test test/contracts`.
- [x] 1.2 Declare the record in `WorkflowSnapshotSchema` in `agentic-coding/src/workflow/schema.ts` and enforce the aggregate content bound for `classifierDecisions` in `decodeSnapshot` (`agentic-coding/src/workflow/contracts.ts`) the way the developer-dialogue bound is enforced. Verify with a new test asserting that a snapshot without the field still decodes and that a snapshot over the bound is rejected.

## 2. Recording the decisions

- [x] 2.1 Change `invokeRoutingClassifier` in `agentic-coding/src/workflow/classifier-runner.ts` to also return the classifier model and the rendered `state` it sent, and return them from the `model.classify` handler in `agentic-coding/src/workflow/effect-runner.ts` alongside `integration`, `phase` and `answers`. Verify the existing routing-request and runner tests still pass: `bun test test/workflow-classifiers.test.ts`.
- [x] 2.2 Build one decision record per answered question inside `applyPoolRouting` in `agentic-coding/src/workflow/runtime/reducers/effect-result.ts`, re-deriving each question's options from the preset already loaded there, and append it to `snapshot.classifierDecisions`. Verify with tests that a routing pass records one record per classified step, that the record's applied profiles equal the profiles the workflow pinned, and that a step whose answer was below the confidence floor records `applied: false` with the kept profiles and the attention note.
- [x] 2.3 Bound the recording: truncate the stored classifier input to a per-record cap with `inputTruncated`, and drop the oldest records when the count or aggregate cap would be exceeded. Verify with tests for truncation, the count bound, and that a record which cannot be stored does not fail the `model.classify` effect or strand the run at the routing step.

## 3. Exposing the records

- [x] 3.1 Expose `classifierDecisions` from `agentic-coding/src/workflow/runtime/view.ts` on every return path (normal, pin-mismatch and unavailable) and pass it through `viewToDashboardState` in `agentic-coding/src/server/operations/engine.ts`; a workflow with no decisions yields an empty list. Verify with a test that reads a workflow view for a run that classified and for one that did not.

## 4. Dashboard classifier decision panel

- [x] 4.1 Add pure `classifierDecisionRows` and `classifierDecisionDetail` projections to `agentic-coding/src/tui/dash/projections.ts` (row = integration, question, applied result; detail = metadata, per-option answer, applied result and attention note, truncation note, and the verbatim input section) and verify them with `bun test test/dash/projections.test.ts`.
- [x] 4.2 Add `agentic-coding/src/tui/dash/panels/ClassifierPanel.tsx` mirroring `OpenSpecPanel` (bounded `visibleRows` viewport, every decision selectable, no keybinding text in the body), render it in the left column of `App.tsx` only when the workflow exposes decisions, and add its selection to `createPanelState` with clamping. Verify with a render test in `test/dash/` covering the rows, the bounded viewport, and the absent-panel case.
- [x] 4.3 Extend `agentic-coding/src/tui/dash/panel-grid.ts` to a 2-column, 3-row grid (Change, OpenSpec, Classifier in the left column; Agents spanning the right column) with the Classifier cell occupied only while decisions exist, and update `movePanel` call sites and `PanelState` clamping. Verify with `bun test test/dash/panelGrid.test.ts` and `bun test test/dash/panelNavigation.test.tsx`, including that a grid with no decisions navigates exactly as before.
- [x] 4.4 Wire the focused-panel keys in `agentic-coding/src/tui/dash/handlers/keys.ts`: unshifted `j`/`k`/`↑`/`↓` move the decision selection, and Enter opens the selected decision in the existing scrollable verdict modal with Markdown content and `verdictOffset` scrolling. Verify with a test that Enter opens the detail view for the selected decision and that closing it leaves the selection unchanged.
- [x] 4.5 Add the Classifier panel context and section to `agentic-coding/src/tui/dash/keybinds.ts` (footer label `decision`, action "View selected classifier decision"), shown only while the panel is rendered. Verify with `bun test test/dash/keybindCatalog.test.tsx`, `bun test test/dash/dashboardFooter.test.tsx` and `bun test test/dash/modalHelp.test.tsx`, and check the footer and `?` help in a running dash.

## 5. Fixtures and validation

- [x] 5.1 Add decision records to the `testDashboard` demo fixture in `agentic-coding/src/tui/dash/demo.ts` so `--profile test` renders exercise the panel, and verify `bun test test/app/dashboardRoot.test.tsx`.
- [x] 5.2 Run the change-relevant checks: `bun test test/workflow-classifiers.test.ts test/workflow-runtime.test.ts test/workflow-steps.test.ts test/dash`, `bun run type-check` and `bun run lint`; then `openspec validate show-jev-decisions-in-dash --strict` from the repository root.
