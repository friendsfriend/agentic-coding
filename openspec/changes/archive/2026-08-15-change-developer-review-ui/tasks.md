# Tasks

## 1. Data model cleanup (`agentic-coding/src/tui/dash/data.ts`)

- [x] 1.1 Remove `| { label: string; kind: "review" }` from the `RequiredUserActionItem` union type.
- [x] 1.2 In `requiredUserActionFor('developer-review')`, drop the `Start developer review` item and return `items: []` (keep `key` / `title` / `prompt` so the action remains a trigger).

## 2. Entry-path wiring (`agentic-coding/src/tui/dash/App.tsx`)

- [x] 2.1 In `openRequiredUserAction()`: when `requiredUserAction()?.key === "developer-review"`, set `promptedUserActionKey` to the action key, call `openDeveloperReview()`, and return `true` (do not open the generic `ListViewModal`).
- [x] 2.2 In the auto-open `createEffect`: special-case the `developer-review` key the same way (set `promptedUserActionKey`, call `openDeveloperReview()`) instead of `setUserActionOpen(true)` / `modal.active = "user-action"`.
- [x] 2.3 Remove the dead `if (item.kind === "review") { openDeveloperReview(); return; }` branch in `runRequiredUserAction`.

## 3. Popup rendering and embedded mode

- [x] 3.1 In `agentic-coding/src/tui/dash/devenv-ui/components/ChangedFilesView.tsx`: add optional `availableLines?: number` prop. When set, render without the `ContentPanel` wrapper and forward `availableLines` to `ScrollableList` (which prefers it over `reservedLines`); when unset, keep the current full-screen behavior.
- [x] 3.2 In `App.tsx`: replace the full-bleed `<box>` files view with a `GenericModal` popup embedding `ChangedFilesView` with the new `availableLines` (popup height minus modal chrome minus view header/table-header rows). Keep the `reviewOpen() && reviewView() === "files"` guard and keep the `DiffViewModal` render unchanged.
- [x] 3.3 Verify all existing review keys still work from the popup: `j/k` selection, Enter → `openReviewDiff()`, `/` search, `f` finish, `Esc` postpone (all handled by the untouched `developer-review` keymap layer).

## 4. Tests

- [x] 4.1 Update `agentic-coding/test/dash/data.test.ts`: `requiredUserActionFor('developer-review')` no longer exposes a `Start developer review` item (trigger-only, `items` empty).
- [x] 4.2 Update `agentic-coding/test/dash/userActions.test.tsx`: at the developer review step the popup shows `Changed Files (1 files)` and the `src/example.ts` row directly; Enter on the row opens the diff modal (assert demo diff content such as `reviewed();`); Esc returns to the files popup; `f` finishes the review.
- [x] 4.3 Run `bun test` and `bunx tsc --noEmit` from `agentic-coding/`; full suite green (baseline: 141 pass / 0 fail) and no type errors.
