## Context

- **Developer review gate** (`core.developer-review`) is the template: a user-action popup renders `ChangedFilesView` inside a `GenericModal`; Enter opens a separate `DiffViewModal`; `c` starts comment input (a dedicated `review-comment` keymap layer); comments render as inline `Discussion` threads; `f` finishes by dispatching `approve-review` (no comments) or `review-comments` (comments saved to `reviews/developer-review.json` first). All keyboard handling lives in App.tsx keymap layers because OpenTUI supports one `useKeyboard` hook per app — modals are presentational.
- **Plan approval gate** (`core.plan-approval`, actor `developer`, outcomes `['approve', 'reject']`) currently shows the generic completed-picker with `approve-plan` (confirm) and `reject-plan` (reason, `core.plan-rejection` input). The engine already validates `review-comments` (bounded: 1–100 comments, non-empty bodies ≤ 4096 bytes) generically in `developerAction` and already carries any transition output into `core.plan` as `step.context`, which the assignment renders as `Step input:` for the planner. Rejection loops back to `core.plan` with `loop.maxAttempts: 3`.
- Artifacts are discovered via `openSpecArtifacts`/`openSpecArtifact` (Bun.Glob `**/*.md` under `openspec/changes/<change>`), already used by the dashboard's OpenSpec panel.
- Step and workflow digests include step outcomes and edges, so any change to them re-pins every definition version. See Risks.

## Goals / Non-Goals

**Goals:**
- Plan approval is reviewed in the modal flow mirroring the developer review: artifact list popup → separate markdown modal → line-anchored comments → `f` finish.
- Finish is comment-aware: no comments → `approve-plan` (worker starts implementation); comments → `review-comments` routed to the planner as step input, with a capped re-review loop.
- Unified finish key `f` across both review gates.
- Planner instructions teach the review-fix round so feedback actually lands in the revised plan.

**Non-Goals:**
- No markdown rendering (headings, tables, highlighting) — the markdown modal is a line-based text view; comments anchor to line numbers, not rendered elements.
- No comment threading (replies, edit, resolve) — one comment per anchor per round, same as the developer review popup.
- No changes to the verification or developer review gates, the OpenSpec tooling, or the dashboard's OpenSpec panel (it stays for viewing artifacts outside the gate).
- `reject-plan` stays in the engine for CLI/backward compatibility; the dashboard simply no longer routes the gate through the generic picker.
- `core.plan-approval` remains a developer-actor gate; approval is never automated.

## Decisions

### D1: Engine — `comments` outcome and `review-comments` action at the plan gate
Add `'comments'` to `core.plan-approval` step outcomes, expose `review-comments` (confirm, `core.review-comments` input schema, same as the developer gate) in `actions()`, and add the edge `core.plan-approval:comments → core.plan` with `loop: { maxAttempts: 3 }` (matching `reject`). The existing bounded validation and the existing `transition` context carry (`['core.plan', ...]` includes `core.plan`) deliver the comments as planner `Step input` unchanged.
- *Alternative rejected:* reuse `reject-plan` with a reason string — cannot carry per-artifact, per-line feedback.
- *Alternative rejected:* introduce a new generic `feedback` action — duplicates `review-comments` semantics already proven at the developer gate.

### D2: Planner re-entry runs in `review-fix` mode with an updated instruction
Extend the `transition` mode logic so entering `core.plan` via the `comments` outcome sets `step.mode = 'review-fix'` (the existing enum already has this value), so the planner assignment objective reads "in review-fix mode" exactly like worker review-fixes. Extend `agent-definitions/instructions/planning.md` with a short paragraph: when step input contains plan review comments, revise the artifacts to address every comment, re-run `openspec validate --strict`, and finish only when the feedback is resolved. Regenerate `embedded.generated.ts` via `bun run scripts/generate-embedded.ts` (instruction assets are excluded from step digests, so this does not re-pin workflows).
- *Alternative rejected:* rely on `Step input` alone — the mode signal and instruction guidance are what make the planner actually treat the round as a revision, mirroring the worker's `review-fix` contract.

### D3: UI — generalize the existing review state with a `reviewKind` discriminator
Extend the existing review signals with `reviewKind: 'developer' | 'plan'` instead of duplicating ~300 lines of parallel state. The two reviews never overlap (one modal at a time), so shared comment-input state (`reviewCommentMode`, `reviewCommentText`, `reviewSourceRange`) and the shared `review-comment` keymap layer work for both. Kind-specific parts: loading (changed files + diff vs. artifacts + markdown content), discussion sources (verifier findings + comments vs. artifact comments), and finish dispatch.
- *Alternative rejected:* fully parallel `planReview*` signal set — doubles state/handlers and risks drift.
- *Alternative rejected:* extract a generic review framework — over-engineering for two consumers.

### D4: Artifact list reuses the files popup pattern
Map artifacts to pseudo `ChangeRequestChange` rows (`new_path` = artifact path, `new_file: true`, `linesAdded` = artifact line count) so the existing `ChangedFilesView` (inside `GenericModal`, with `/` search) renders the plan artifact list with useful size stats and the established `(N files)` header.
- *Alternative rejected:* a dedicated artifact list component — duplicates the popup chrome, search, and list behavior.

### D5: New presentational `MarkdownViewModal` mirroring `DiffViewModal`
New `devenv-ui/components/MarkdownViewModal.tsx` renders artifact lines as selectable rows with: `j/k` navigation, `v` visual range selection, `c` comment input row, inline `Discussion` threads, `n/N` comment cycling, and the same footer help style — but no diff parsing, split view, or finding markers. Keyboard stays in App.tsx via a new `plan-review` keymap layer that mirrors the `developer-review` layer's handler branching on `reviewKind`. Comment input reuses the existing `review-comment` layer.
- *Alternative rejected:* render markdown through a formatter — out of scope (Non-Goals) and would complicate line anchoring.

### D6: Persistence per round, fresh comments on open
`savePlanReview`/`loadPlanReviewComments` write/read `reviews/plan-review.json` (same shape as `developer-review.json`); the popup clears comments on open, mirroring `openDeveloperReview`. The engine's feedback is the action payload — the file is the per-round record (and the demo/test assertion surface).
- *Alternative rejected:* reload persisted comments on reopen — anchors go stale as soon as the planner rewrites artifacts; one-shot round feedback is clearer.

### D7: Finish dispatch mirrors the developer gate
`f` → gather comments (no findings analog at the plan gate): none → `runWorkflow('approve-plan')`; some → `savePlanReview` + `runWorkflow('review-comments', {comments: [{comment, file, line, startLine?, endLine?}]})`. `busy()` guards and message feedback match `finishDeveloperReview`.

### D8: Definition digests change in place
Adding the outcome and edge changes step/workflow digests at the existing definition versions (no version bump), following the established pattern of prior gate changes. Running workflows pinned to the old digest surface `pin-mismatch` until they complete; workflows in this repo are short-lived (minutes per step), so impact is bounded. See Risks.

## Risks / Trade-offs

- [Definition digest re-pin breaks in-flight pinned workflows] → Mitigation: in-place change is the established pattern; gates run minutes, and `view()` degrades to an attention-required diagnostic rather than crashing the CLI.
- [Markdown line anchors go stale after the planner rewrites artifacts] → Mitigation: comments are per-round and cleared on open; the planner receives them once as step input and the next review round starts fresh.
- [`ChangedFilesView` stats semantics don't match artifacts] → Mitigation: artifacts map to `new_file` rows with `linesAdded` = line count, so the header/rows remain meaningful (`+N`).
- [Keymap layer surface grows and drifts from the developer layer] → Mitigation: single handler function branching on `reviewKind` inside the `plan-review` layer; the `review-comment` layer is shared.
- [Existing tests assert the old gate actions] → Mitigation: update `test/workflow-runtime.test.ts` action-list assertion to include `review-comments`; add runtime, data, and dash tests for the new flow (tasks list them).

## Migration Plan

- No data migration: the change is additive — `approve-plan`/`reject-plan` remain valid engine actions, so CLI-driven flows and the completed-picker fallback for other gates keep working.
- Rollback: revert the edge/outcome/action additions and the App.tsx gate routing; the generic picker remains as the fallback path, so no gate is left unactionable.
- Order of work: engine + tests first (routing exists before the UI dispatches it), then data layer, then the markdown modal + popup, then instruction update + regeneration, then dash tests.
