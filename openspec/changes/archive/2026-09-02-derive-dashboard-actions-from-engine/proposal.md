## Why

The dashboard maintains a second, independent source of truth for which developer actions exist. `agentic-coding/src/tui/dash/data.ts:1881 requiredUserActionFor(phase, prCreated, artifacts, definitionId)` re-derives action availability from phase strings and re-implements the engine's allowlists — even though the engine already publishes an authoritative `actions` array on the workflow view, and `dashboard-engine-integration` already requires that "no UI phase list change SHALL be required for basic operation".

The two copies have already drifted, and both divergences are live in the current repository:

- **A dashboard action the engine rejects.** At `core.completed` the engine treats five definitions as close-only (`openspec-propose`, `openspec-fusion-propose`, `wiki`, `wiki-comments`, `research`) and offers no `create-pr` for them. The dashboard's equivalent check is `proposal || wikiOnly` where `wikiOnly = definitionId === "wiki" || definitionId === "research"` — **`wiki-comments` is missing**. A completed `wiki-comments` workflow therefore shows a "Create MR/PR" button that the engine will refuse as an unavailable action.
- **A dashboard action the engine has never heard of.** The same menu offers "Close and delete worktree" dispatching action id `close-clean`. A search across the package finds `close-clean` in exactly one place — that menu. Nothing consumes it, so selecting it dispatches an action the engine does not define.

This is precisely the failure mode described in the original task: a change lands in one place, the duplicate elsewhere is missed, and nothing fails loudly. Stages A–C removed this duplication inside the engine; the dashboard is the last copy.

## What Changes

- `requiredUserActionFor` derives which actions to show from the engine-produced `WorkflowActionView[]` on the workflow view, keyed by action id, instead of re-deriving availability from phase strings and definition-id allowlists.
- All user-facing copy — titles, prompts, item labels, "Not now" — stays in the dashboard, keyed by action id. The engine gains no presentation strings.
- The two divergences are resolved by construction: `wiki-comments` becomes close-only because the engine says so, and `close-clean` is either mapped to a real engine action or removed, decided by the audit in task 2.1.
- `src/tui/dash/App.tsx`'s six `data().state.stepId === "core.*"` checks that select which review popup to open and which submit path to use are replaced by a switch on the required action's key/action id, so a new or renamed approval step needs no `App.tsx` edit.
- A narrow legacy fallback is retained for pre-engine views that carry no `actions` array, so a workflow view from an older store still renders its action.
- **BREAKING (behavioral, intended):** a completed `wiki-comments` workflow no longer offers "Create MR/PR", and "Close and delete worktree" no longer appears unless it is backed by a real engine action. Both are corrections of actions that could not succeed.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `dashboard-engine-integration`: the engine-provided workflow view becomes the single source of action availability for the dashboard, rather than one input the dashboard cross-checks against its own phase table.

## Impact

- **Depends on:** `move-step-semantics-to-behavior-hooks` (stage B), which makes the engine's action list single-sourced per step. Reading `view.actions` before B would read from the duplicated `actions()` ternary, including its two `core.wiki-approval` branches.
- **Code (modified):** `src/tui/dash/data.ts` (`requiredUserActionFor`), `src/tui/dash/App.tsx` (six step-id checks → action-key switch).
- **Tests:** `test/dash/userActions.test.tsx` and `test/dash/data.test.ts` updated to pass engine `actions` arrays; new cases for the two corrected divergences and for the legacy no-actions fallback.
- **Not in scope:** the `core.verification` run/findings grouping in `data.ts` (display grouping, not action semantics), modal components, keybindings, and layout.
- **Risk:** a dropped action is silent — the workflow simply stalls with no offered button. Mitigated by explicit parity coverage rather than by inspection.
