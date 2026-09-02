## Context

See `proposal.md` — Why. This is stage D of the four-stage sequence recorded in `restructure-repo-for-agent-use/design.md` D7, and the last remaining duplicate of the engine's action knowledge.

Verified in the current repository:

- `src/tui/dash/data.ts:1881` `requiredUserActionFor(phase, prCreated = false, _artifacts = [], definitionId?)` branches on phase strings, accepting both legacy (`proposed`, `wiki-approval`, `developer-review`, `research`, `completed`) and engine (`core.*`) names. The `_artifacts` parameter is already unused.
- The engine's `actions()` close-only allowlist at `core.completed` is `["openspec-propose", "openspec-fusion-propose", "wiki", "wiki-comments", "research"]`. The dashboard's is `proposal || wikiOnly` with `wikiOnly = "wiki" || "research"` — `wiki-comments` is absent, so the dashboard offers `create-pr` where the engine offers none.
- `close-clean` appears exactly once across the package (`data.ts:1979`) and is dispatched through `App.tsx:1455` `workflowActionId(item.value)`, which maps only `apply → approve-plan` and otherwise passes the value through. No engine action, CLI verb, or effect consumes it.
- `App.tsx` branches on `data().state.stepId === "core.*"` at lines 888, 1009, 1105, 1327, 1332, 1337, 1650, and 1654 to decide which review popup opens and which submit path runs.

The engine already publishes `WorkflowActionView[]` on the view with `id`, `label`, `confirmation`, and optional `input` schema — everything needed for availability. What it does not publish, and should not, is dashboard prompt copy.

## Goals / Non-Goals

**Goals:**

- The dashboard cannot offer an action the engine will reject, by construction rather than by keeping two lists in agreement.
- Adding or renaming an approval step requires no `data.ts` or `App.tsx` edit.
- Presentation stays entirely in the dashboard.

**Non-Goals:**

- No engine change. If stage B did its job, the engine's action list is already correct and single-sourced; this stage only stops ignoring it. Any engine action bug found here is recorded and fixed in the engine, not compensated for in the dashboard.
- No change to the `core.verification` run/findings grouping in `data.ts` — that is display grouping, not action semantics.
- No modal component, keybinding, or layout change.
- No removal of the legacy phase-string fallback. It is narrowed to views with no `actions` array, not deleted.

## Decisions

### D1. Availability from the engine, copy from the dashboard

`requiredUserActionFor` takes the view's `actions` array and produces items by looking up dashboard-owned copy keyed by action id. An action id with no copy entry renders with the engine's own `label` as a fallback rather than disappearing — a missing translation should degrade to a usable button, not to a stalled workflow.

Alternative considered: move prompt/title copy into the engine so the dashboard becomes a pure renderer. Rejected — it pushes presentation into the state machine, and the engine would then need to know about modal titles and "Not now" affordances. The split is availability in the engine, wording in the UI.

### D2. `close-clean` is decided by audit, not assumed

It is dispatched but undefined. Two readings are possible: it is dead UI left from a pre-engine dashboard, or it is a genuinely wanted capability (close the workspace *and* delete the worktree) that was never implemented on the engine side. Task 2.1 determines which by checking the git history of that menu item and whether any engine action performs worktree deletion.

- If dead: remove the item.
- If wanted but unimplemented: remove the item **and** record a separate follow-up change to add a real engine action, rather than shipping a button that fails.

Either way it stops being offered in this change. What it must not become is a dashboard-local side effect that bypasses the engine — that would reintroduce exactly the second-state-authority problem this sequence removes.

### D3. The `wiki-comments` divergence is fixed by deletion, not by editing the dashboard list

The correct fix is not to add `wiki-comments` to the dashboard's allowlist. It is to delete the dashboard's allowlist so the engine's is the only one. Adding the missing entry would fix today's symptom and leave the mechanism that produced it.

### D4. `App.tsx` switches on action key, not step id

The six step-id checks resolve to "which review popup and which submit path". Both are functions of the required action's key, which `data.ts` already produces (`plan-review`, `wiki-review`, `developer-review`). Switching on that key means a new approval step that produces a known key needs no `App.tsx` change, and one that produces a new key fails visibly at the switch rather than silently rendering nothing.

### D4a. A third, undocumented divergence surfaced during implementation

Migrating the Enter-key handler's post-`openRequiredUserAction()` fallback (task 4.2) from `data().state.stepId === "core.plan-approval" | "core.developer-review"` to the required action's key exposed a real behavioral gap that predates this change: for an engine-driven view (where `stepId` genuinely equals those `core.*` strings), that fallback already bypassed `openRequiredUserAction`'s dismissal guard (`promptedUserActionKey === action.key && activePanel() !== 0`) and force-reopened the review popup on every Enter press, on any panel. The dashboard's demo/test profile never exercised this because its legacy phase strings (`"proposed"`, `"developer-review"`) never equal the `core.*` literals, so the guard was the only thing ever observed there, and `test/dash/userActions.test.tsx`'s "dismissed plan review stays closed during panel interactions" only ever tested the demo path.

Asked which behavior to standardize on, the developer chose to keep the dismissal-respecting behavior everywhere rather than adopt the force-reopen one: the redundant fallback is deleted outright, leaving `openRequiredUserAction()` (which already honors the guard) as the sole mechanism for reopening a review popup on Enter, for both legacy and engine-driven views. This is a small, additional bug fix bundled into task 4.2 rather than a new divergence to preserve.

### D5. Parity is asserted against captured values, not reasoned about

A dropped action is silent: the workflow stalls with no button and no error. So the test captures the current rendered item list for every phase × definition id × `prCreated` combination *before* the change, and asserts the new implementation produces the same list — except for the two divergences, which are asserted to change in the specific documented way. Everything that is not one of those two cases must be byte-identical.

## Task 2.1 audit finding: `close-clean` is dead UI, not an unimplemented capability

Current-repository evidence (no git history consulted): `close-clean` appeared in exactly one place, `data.ts`'s `core.completed` item list, dispatched through `App.tsx`'s `workflowActionId` passthrough to an action id the engine never defines. Searching the engine for anything that deletes a worktree finds `workspace.cleanup` (`effect-runner.ts`), which runs `git worktree remove --force` (skipping wiki/research targets, which have no worktree). That effect is not dormant or half-built: `runtime.ts`'s effect-completion handler unconditionally enqueues `workspace.cleanup` immediately after every `workspace.close` effect completes, for every repository-backed workflow. In other words, the ordinary "Close Herdr workspace" action (`close`) already deletes the worktree as part of closing — automatically, not on request.

So `close-clean` was never a wanted-but-unimplemented capability; the capability it names already exists and already fires on plain `close`. It is dead UI: a second button promising a behavior the first button already performs unconditionally. Resolution per D2's dead-UI branch: delete the item outright (task 2.2), with no follow-up change needed — there is nothing left to implement.

## Risks / Trade-offs

- **A required action is silently dropped and the workflow stalls** → D5's captured-value parity across every phase, definition id, and `prCreated` combination, with the two intended differences asserted explicitly rather than allowed as drift.
- **The engine's action list is itself wrong for some case, and the dashboard was masking it** → the parity test surfaces every difference; each is triaged as "engine bug, fix in engine" or "intended correction" before the dashboard change lands. This is a benefit of the ordering, not an obstacle: masked engine bugs become visible.
- **A legacy view with no `actions` array loses its action** → the fallback is retained and covered by a dedicated case; it is narrowed to the no-actions condition only, so it cannot shadow a present-but-empty array (a genuinely empty action list must render no actions).
- **Removing "Close and delete worktree" removes a capability someone uses** → D2's audit; if it is wanted, a follow-up adds it as a real engine action rather than restoring a button that cannot work.
- **`App.tsx`'s switch misses a key and a popup stops opening** → the switch is exhaustive over the known keys with an explicit default that surfaces the unknown key, and `test/dash/userActions.test.tsx` covers each approval path.

## Migration Plan

No data or schema change. Deployment is an ordinary build.

Order: capture parity baseline → audit `close-clean` → derive availability from the view → narrow the legacy fallback → switch `App.tsx` on action key → update tests. The parity baseline is captured first so every later step is measured against it.

Rollback: revert. The change is confined to two dashboard files.

## Open Questions

- Whether the legacy phase-string fallback can be deleted outright in a later change once no store produces a view without an `actions` array. Deferrable — it costs one branch and removing it now risks a blank action panel on an older store.
- Whether `requiredUserActionFor`'s already-unused `_artifacts` parameter should be dropped from the signature. Cosmetic; it touches call sites and tests, so it is better done in a separate tidy-up than mixed into a behavior change.
