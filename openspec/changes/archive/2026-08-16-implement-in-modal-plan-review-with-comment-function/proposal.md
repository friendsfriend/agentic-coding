## Why

The plan approval gate has no real review UX: artifacts are read one at a time in a plain verdict modal and approval/rejection happens through a generic action picker, so feedback cannot be anchored to the plan text. The developer review gate already ships a modal review flow (artifact-style file list popup, separate detail modal, line-anchored comments, `f` to finish) — plan review should mirror that approach so plan feedback is just as precise.

## What Changes

- The plan approval gate opens a plan review popup that lists **all OpenSpec artifacts created by the planner** (`proposal.md`, `design.md`, `tasks.md`, and every `specs/**/*.md` delta) instead of the generic action picker.
- Enter on an artifact opens a **separate markdown modal** that renders the artifact with selectable lines.
- Comments can be **anchored to markdown lines** (`c` to comment, `v` for visual range selection, inline comment threads, `n/N` to cycle), mirroring the developer review diff view.
- The review **finishes with `f`** (unified with the developer review): if no comments exist the workflow dispatches `approve-plan` and the worker starts implementation; if comments exist the workflow dispatches `review-comments` and the planner receives the feedback and adjusts the plan (re-review loop capped like the existing rejection loop).
- The engine's `core.plan-approval` step gains a `comments` outcome (and the `review-comments` developer action at that gate) that routes back to `core.plan` with the comments carried as planner step input; the planning instruction is extended so the planner knows to revise the plan against that feedback.
- Review comments are persisted per round to `reviews/plan-review.json`, mirroring `reviews/developer-review.json`.
- Esc postpones the review without dispatching any action.

## Capabilities

### New Capabilities
- `dashboard-plan-review-comments`: the plan approval gate is reviewed through the modal flow — artifact list popup, separate markdown view modal with line-anchored comments, and a comment-aware finish that approves or sends feedback to the planner.

### Modified Capabilities
- `workflow-engine-runtime`: the plan approval gate accepts bounded `review-comments` and routes the `comments` outcome back to the planner as step input, so planner feedback flows through the engine contract like the developer review gate does.

## Impact

- `agentic-coding/src/tui/dash/App.tsx`: plan review popup/modal flow, `f` finish dispatch, plan-review keymap layer (mirrors the developer-review layer); gate and user-action routing for `core.plan-approval`.
- `agentic-coding/src/tui/dash/data.ts`: plan review comment persistence (`reviews/plan-review.json`), plan review artifact loading, `requiredUserActionFor` plan gate branch.
- `agentic-coding/src/tui/dash/devenv-ui/components/MarkdownViewModal.tsx` (new): presentational line-based markdown modal mirroring `DiffViewModal`.
- `agentic-coding/src/workflow/runtime.ts` + `definitions.ts`: `review-comments` action at `core.plan-approval`, `comments` outcome, edge `core.plan-approval:comments → core.plan` (loop, capped like `reject`), `review-fix` mode on plan re-entry.
- `agent-definitions/instructions/planning.md` (+ regenerate `embedded.generated.ts`): planner feedback guidance for review comments.
- Tests: `test/workflow-runtime.test.ts`, `test/dash/userActions.test.tsx`, `test/dash/data.test.ts`.
