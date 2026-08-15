## 1. Engine routing

- [x] 1.1 Add `comments` to the `core.plan-approval` step outcomes in `src/workflow/definitions.ts` (standard manifest: `['approve', 'reject', 'comments']`), keeping `reject` intact
- [x] 1.2 Add the edge `{ from: 'core.plan-approval', outcome: 'comments', to: 'core.plan', loop: { maxAttempts: 3 } }` to the standard workflow edges in `definitions.ts`
- [x] 1.3 Expose `review-comments` (label `Request plan changes`, confirmation `confirm`, input schema `core.review-comments`) in the `core.plan-approval` action list in `src/workflow/runtime.ts` (`actions()`)
- [x] 1.4 Extend the `transition()` mode logic in `runtime.ts` so entering `core.plan` via the `comments` outcome sets `step.mode = 'review-fix'` (mirroring the implementation step), while `approve`/`reject` behavior stays unchanged
- [x] 1.5 Verify the existing bounded `review-comments` validation in `developerAction` already covers the plan gate (no per-step gating added)

## 2. Runtime tests

- [x] 2.1 Update `test/workflow-runtime.test.ts` action-list assertion in the CAS/repair test to `['approve-plan', 'review-comments', 'reject-plan']`
- [x] 2.2 Add a runtime test: dispatching `review-comments` at `core.plan-approval` with a bounded payload transitions to `core.plan`, carries the comments in step context, and sets `review-fix` mode
- [x] 2.3 Add a runtime test: malformed/empty/oversized `review-comments` payloads at the plan gate are rejected without mutation
- [x] 2.4 Add a runtime test: `approve-plan` and `reject-plan` at the plan gate still transition as before (regression guard)

## 3. Data layer

- [x] 3.1 Add `PlanReviewComment` type (artifact path, line, optional start/end range, body) and `loadPlanReviewComments`/`savePlanReview` in `src/tui/dash/data.ts`, writing `reviews/plan-review.json` mirroring `saveDeveloperReview`
- [x] 3.2 Add a `plan-review` trigger-only branch to `requiredUserActionFor` for `core.plan-approval` (and the demo `proposed` phase), mirroring the `developer-review` branch (empty items, popup opens directly)
- [x] 3.3 Update `test/dash/data.test.ts`: replace the old `proposed` item-list assertion with the trigger-only expectation; add a `savePlanReview` serialization test

## 4. Markdown view modal

- [x] 4.1 Create `src/tui/dash/devenv-ui/components/MarkdownViewModal.tsx`: presentational line-based markdown viewer with selectable rows, visual range selection, inline comment threads, comment input row, and `n/N` cycling (mirroring `DiffViewModal`; no diff parsing, no split view)
- [x] 4.2 Reuse the existing `GenericModal` chrome, `ScrollableContent`, `HelpText` formatting, `Discussion` type, and comment-thread rendering style from the diff view

## 5. Dashboard plan review flow

- [x] 5.1 Add a `reviewKind` (`'developer' | 'plan'`) discriminator to the review state in `src/tui/dash/App.tsx` and branch loading: plan mode maps `openSpecArtifacts` to pseudo `ChangeRequestChange` rows (`new_file`, `linesAdded` = line count) for `ChangedFilesView`, and `openSpecArtifact` content feeds the markdown modal
- [x] 5.2 Add `openPlanReview` mirroring `openDeveloperReview` (resets comments/visual state, opens the popup, sets the `plan-review` keymap modal) with demo artifacts/content for the test profile
- [x] 5.3 Route the plan gate: `gate()` and `handleKey` Enter open the plan review for `core.plan-approval`, and the required-user-action auto-open handles the `plan-review` key like `developer-review`
- [x] 5.4 Register the `plan-review` keymap layer mirroring the developer-review layer (files nav, `/` search, Enter opens markdown modal, `c` comment, `v` visual, `n/N` cycle, `f` finish, Esc back/postpone), reusing the shared `review-comment` input layer
- [x] 5.5 Implement `finishPlanReview` (bound to `f`): no comments → `runWorkflow('approve-plan')`; comments → `savePlanReview` + `runWorkflow('review-comments', { comments })` with the developer-review payload shape (`comment`, `file`, `line`, optional `startLine`/`endLine`), guarded by `busy()`
- [x] 5.6 Render the plan review popup (artifact list in `GenericModal`) and the markdown modal (`MarkdownViewModal`), and include the plan review in `anyModalOpen()` and modal-state cleanup

## 6. Planner instruction

- [x] 6.1 Extend `agent-definitions/instructions/planning.md` with review-fix guidance: when step input contains plan review comments, revise the artifacts to address every comment and re-run `openspec validate "$HERDR_CHANGE_ID" --strict` before finishing
- [x] 6.2 Regenerate `src/workflow/embedded.generated.ts` via `bun run scripts/generate-embedded.ts` and confirm instruction digests update without changing step digests

## 7. Dashboard tests

- [x] 7.1 Update `test/dash/userActions.test.tsx`: plan approval now opens the artifact-list popup (not the generic picker); Enter opens the markdown modal; Esc returns to the popup; `f` with no comments dispatches approval and closes
- [x] 7.2 Add a dash test: comment on a markdown line, `f` finishes, and the review closes with the comment flow exercised
- [x] 7.3 Run `bun run type-check`, `bun test` (focused files), and `bun run build` once; confirm no regressions
