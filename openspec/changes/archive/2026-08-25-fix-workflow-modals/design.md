## Context

The dashboard's required-user-action mechanism (`requiredUserActionFor` in `agentic-coding/src/tui/dash/data.ts`) computes a `RequiredUserAction` with a `key` that `App.tsx` uses in two places to open the review popups directly instead of the generic action list: the Enter handler path (`openRequiredUserAction`) and the auto-open effect. Both compare `action.key === "developer-review"` / `"plan-review"`.

For the developer review, `requiredUserActionFor` returns `key: phase`. Since workflows report engine step ids as their phase (`view.currentStep.id`, e.g. `core.developer-review`), the key becomes `core.developer-review`, which matches neither direct-open branch. The flow then falls through to the generic user-action ListViewModal, which renders only a title and prompt with an empty item list — the "review is due" notice the user sees. The plan review branch hardcodes `key: "plan-review"`, so it still matches today, but its correctness depends on App.tsx string matching rather than on the data layer's contract.

Existing tests exercise only legacy phase names (the demo profile drives `proposed`/`developer-review`), which is why the regression was not caught.

## Goals / Non-Goals

**Goals:**
- Make review popups (plan approval, developer review) open directly for every gated step, independent of how the phase is named (legacy vs engine step id).
- Make the stable action keys an explicit contract of the data layer instead of an accident of phase strings.
- Prevent recurrence with tests that use engine-style phase names.

**Non-Goals:**
- Changing the popup content, keybindings, or finish/dispatch behavior of either review modal.
- Reworking the user-action model for non-gated steps (`core.completed` etc.) whose generic item lists are intentional.
- Renaming or re-mapping workflow engine step ids.

## Decisions

- **D1: Normalize keys in the data layer.** `requiredUserActionFor` returns fixed keys `"plan-review"` and `"developer-review"` for both legacy and `core.*` phases. Alternative considered: teach App.tsx to strip `core.` prefixes when matching — rejected because it spreads the naming workaround into the UI layer and leaves the data contract ambiguous; and hardening only the two comparison sites would leave any future consumer with the same trap.
- **D2: Keep App.tsx matching unchanged.** With D1, the existing `=== "developer-review"` / `=== "plan-review"` comparisons become correct by construction; no UI-layer edits are needed beyond what D1 implies. Minimal diff, no behavior change for legacy names.
- **D3: Cover engine naming at both test levels.** Unit tests assert identical keys for `developer-review` vs `core.developer-review` (and `proposed` vs `core.plan-approval`); the TUI-level coverage stays on the demo profile since extending it to engine ids would mean touching demo fixtures unrelated to this fix. Unit-level equality plus the unchanged matching logic gives the needed guarantee without fixture churn.

## Risks / Trade-offs

- [A persisted or external consumer relied on the phase-derived key `core.developer-review`] → The `key` is consumed only inside `App.tsx` (verified: no other usages), so normalization is safe; tests pin the new contract.
- [Future gated steps reintroduce phase-derived keys] → Unit tests now assert key stability per gated step; adding a step without a stable key fails review against the spec scenarios.

## Migration Plan

Single-repo change, no persistence or migration. Rollback is reverting the commit.

## Open Questions

None.
