# Design: Developer review files list inside the user-action popup

## Context

Current flow in `agentic-coding/src/tui/dash/` when the workflow reaches `core.developer-review`:

1. `data.ts` `requiredUserActionFor('developer-review')` returns `{ key: "developer-review", title: "Action required · Developer review", prompt: "Review changed files before workflow continues.", items: [{ label: "Start developer review", kind: "review" }, { label: "Not now", kind: "dismiss" }] }`.
2. An auto-open `createEffect` in `App.tsx` opens the generic `ListViewModal` (`modal.active = "user-action"`, `user-action` keymap layer, priority 1150) when the phase starts.
3. Enter on `Start developer review` → `runRequiredUserAction` → `openDeveloperReview()`: loads local changes/findings, resets review state, sets `reviewOpen(true)`, `reviewView("files")`, `modal.active = "developer-review"`.
4. The files view renders as a full-bleed `<box>` wrapping `ChangedFilesView` (full-screen `ContentPanel` chrome, hardcoded `reservedLines = 11`). The `developer-review` keymap layer (priority 1100) handles `j/k`, `/` search, `f` finish, `Esc`, Enter → `openReviewDiff()`.
5. Enter on a file → `reviewView("diff")` → `DiffViewModal` (separate modal, unchanged target). `Esc` in diff → back to `reviewView("files")`.

`ScrollableList` already documents and supports `availableLines` ("Use this inside modal dialogs where the available height is `dialogHeight − modalChrome`"), which takes precedence over `reservedLines`. `DiffViewModal` is intentionally not touched.

Baseline verified on the unmodified tree (run from `agentic-coding/`, which is required because `bunfig.toml` provides the `@opentui/solid` preload): `bun test` 141 pass / 0 fail; `bunx tsc --noEmit` clean.

## Goals / Non-Goals

**Goals:**
- Render the changed-files list directly inside the developer review user-action popup.
- Open the diff from the popup in the existing separate `DiffViewModal`, with zero behavior change there.
- Preserve all current review interactions (`j/k`, `/` search, `f` finish, `Esc` postpone) in the popup.
- Keep the change small: one popup render, one embedded-mode prop, entry-path wiring, test updates.

**Non-Goals:**
- Changing the diff modal UX, keys, or layout.
- Changing user actions of other phases (`proposed`, `completed`).
- Changing the review data layer (`loadLocalChanges`, `loadLocalDiff`, `loadDeveloperReviewFindings`, `saveDeveloperReview`).
- Workflow engine, persistence, CLI, or keymap-layer API changes.
- New dependencies or a new keymap layer.

## Decisions

### D1: The popup body is the changed-files view (no `Start developer review` item)

When the developer review user action opens, its popup shows the changed-files list directly. The `Start developer review` item is removed because it is now just an extra click before the same content — the requirement is an explicit merge. The list rows and the `Changed Files (N files)` / `+/-` header come from the existing `ChangedFilesView` so the view is literally "moved into the popup".

Alternative considered: keep the item and only swap the full-screen render for a modal render. Rejected: it preserves the redundant click and contradicts "merged with the changed files view".

### D2: Reuse the existing review state machine and keymap layer

`reviewOpen` / `reviewView` (`"files" | "diff"`) keep driving rendering. Files → popup; diff → `DiffViewModal`. The existing `developer-review` keymap layer (already active for `modal.active = "developer-review"`, which `openDeveloperReview()` sets) keeps handling all keys for both views. No new layer, no changes to the `user-action` layer or other phases.

### D3: All entry paths converge on `openDeveloperReview()`

- `openRequiredUserAction()`: when `requiredUserAction()?.key === "developer-review"`, set `promptedUserActionKey = action.key`, call `openDeveloperReview()`, and return `true` (no generic popup).
- Auto-open `createEffect`: same special-case instead of `setUserActionOpen(true)` / `modal.active = "user-action"`.
- Existing direct paths (`data().state.stepId === "core.developer-review"` in the Enter handler, `gate()` action `"review"`) already call `openDeveloperReview()` and are unchanged.

Setting `promptedUserActionKey` when opening via the required-action path prevents the auto-open effect from immediately re-opening the popup after `Esc`; a later `Enter` still reopens it (the `openRequiredUserAction` guard only short-circuits when `activePanel() !== 0`).

### D4: `ChangedFilesView` gains an optional embedded mode

Add an optional `availableLines?: number` prop. When set:

- Render bare (no `ContentPanel` full-screen chrome — the popup provides its own `bgMantle` panel via `GenericModal`).
- Forward `availableLines` to `ScrollableList` (documented precedence over `reservedLines`).

When absent, current behavior (full-screen `ContentPanel`, `reservedLines = 11`) is unchanged. `App.tsx` renders the files view as a `GenericModal` popup (recommended `heightPercent ≈ 0.75`) embedding `ChangedFilesView` and computes the list's `availableLines` as popup height minus modal chrome (padding, title, help) minus the view's own chrome (header, table header). `ScrollableList` clamps to `Math.max(1, …)`.

### D5: Data model cleanup

- Remove `{ label: string; kind: "review" }` from `RequiredUserActionItem`.
- `requiredUserActionFor('developer-review')` returns `{ key, title, prompt, items: [] }` (trigger-only).
- Remove the now-dead `item.kind === "review"` branch in `runRequiredUserAction`.

## Risks / Trade-offs

- **Popup height math**: the virtual list's visible rows depend on the computed `availableLines`; a wrong value only shrinks/grows the visible window (clamped to ≥ 1), so the risk is cosmetic. Mitigated by the 120×40 render tests and a conservative `heightPercent`.
- **Behavioral regression in the review flow**: mitigated by updating `userActions.test.tsx` to assert popup → diff → back → finish, and by keeping all key handling in the untouched `developer-review` layer.
- **Test runner location**: tests must run from `agentic-coding/` so the bunfig `[test] preload` applies; running from the repo root produces spurious OpenTUI "Orphan text" render failures (verified).
- **Title duplication**: `GenericModal` adds a title row while `ChangedFilesView` keeps its `Changed Files (N files)` header; the plan keeps the view header (carries the stats) and uses the user-action title in the modal title bar.
