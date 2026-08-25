## 1. Data layer

- [x] 1.1 In `agentic-coding/src/tui/dash/data.ts`, make `requiredUserActionFor` return the stable key `"developer-review"` for both `developer-review` and `core.developer-review`, and keep `"plan-review"` for both `proposed` and `core.plan-approval`; verify with a quick read of the returned objects (no phase-derived keys remain for gated steps).

## 2. Tests

- [x] 2.1 In `agentic-coding/test/dash/data.test.ts`, add assertions that `requiredUserActionFor("developer-review")?.key === requiredUserActionFor("core.developer-review")?.key === "developer-review"` and `requiredUserActionFor("proposed")?.key === requiredUserActionFor("core.plan-approval")?.key === "plan-review"`; verify with `bun test test/dash/data.test.ts`.
- [x] 2.2 In `agentic-coding/test/dash/userActions.test.tsx`, keep existing demo-profile flows passing unchanged (they cover the popup content and finish flow); run the full dash suite with `bun test test/dash/`.

## 3. Verification

- [x] 3.1 Run `bun run lint` and `bun run type-check` in `agentic-coding/`; both must pass.
- [x] 3.2 Confirm against the spec deltas: engine step id phases (`core.*`) open the review popups directly and never render the generic empty-item notice modal, per `specs/dashboard-developer-review-popup/spec.md` and `specs/dashboard-plan-review-comments/spec.md` scenarios.
