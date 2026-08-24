## 1. Identity derivation

- [x] 1.1 In `src/workflow/effect-runner.ts`, change `canonicalAgentName` so round-scoped steps derive `<shortrole>-<hash8>` (no `run.id` suffix); keep the shortrole clamp and the 32-char/charset guarantees; update the function's doc comment
- [x] 1.2 Keep `legacyRunName` unchanged (run-id-suffixed for round-scoped) and verify the `legacy === canonical` early-out still holds for all shapes

## 2. Grouped-round geometry

- [x] 2.1 In `paneForRunFactory` (`src/workflow/cli.ts`), remove the `if (!sibling.handle) continue;` guard: resolve every same-step sibling through `resolveLiveAgent` and collect resolved panes regardless of handle presence
- [x] 2.2 Update the `roundScoped` usage/comments so it only controls split-layout geometry, not identity

## 3. Tests

- [x] 3.1 Update `test/workflow-effects.test.ts`: replace round-isolation expectation with round-stability (same stepId+role across different run ids → identical name); keep collision, length, charset, and persistent-role stability assertions
- [x] 3.2 Add test: grouped-round siblings without handles resolve by canonical name in `resolveLiveAgent`/`paneForRunFactory` path (fake herdr)
- [x] 3.3 Add test: a verifier run whose canonical-name agent is live resolves to that agent's pane instead of falling through to tab create

## 4. Validation

- [x] 4.1 Run focused workflow tests, `bun run type-check`, `bun run build`, and `bun run lint`; full suite is delegated to the test-verifier
