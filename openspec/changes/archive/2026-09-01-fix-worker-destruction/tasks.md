## 1. Pane ownership tracking

- [x] 1.1 In `src/workflow/cli.ts`, change `paneForRunFactory`'s return type to `{ paneId: string; tabId?: string; owned: boolean }` and set `owned: false` on the live-agent-reuse return (`resolved.paneId`) and on the `bottomPane(...)` reuse returns (`spare` in the `k === 3` branch); verify by reading the diff that every return statement in the function sets `owned` explicitly.
- [x] 1.2 In the same file, set `owned: true` on every pane obtained via `split(...)` and on the final `tab create` fallback return; verify with `bun run type-check` that the function's return type is consistent across all branches.
- [x] 1.3 In `src/workflow/effect-runner.ts`, update the `AdapterEffectOptions.paneForRun` type signature to include `owned: boolean` in its resolved value, matching the new `paneForRunFactory` shape; verify with `bun run type-check`.

## 2. Gate launch-failure pane cleanup on ownership

- [x] 2.1 In the `agent.launch` handler's `execute` in `src/workflow/effect-runner.ts`, change the `catch` block around `adapter.launch()` so `options.herdr.call("pane", "close", pane.paneId)` is only called when `pane.owned === true`; verify by reading the updated block that a reused pane (`owned: false`) is never passed to `pane close`.

## 3. Regression tests

- [x] 3.1 Add a focused test (in `test/workflow-effects.test.ts`, alongside the existing `agent.launch` coverage) asserting that when `paneForRun` resolves `{ paneId, owned: false }` and the stub adapter's `launch()` throws, no `pane close` call is made to Herdr; verify with `bun test test/workflow-effects.test.ts`.
- [x] 3.2 Add a focused test asserting that when `paneForRun` resolves `{ paneId, owned: true }` and the stub adapter's `launch()` throws, a `pane close` call is made for that pane id; verify with `bun test test/workflow-effects.test.ts`.
- [x] 3.3 Confirm existing normal-path coverage in `test/workflow-cli.test.ts` (`paneForRunFactory` reuse-vs-create tests) and `test/workflow-effects.test.ts` (verification/test-verifier phase advancement) still passes unchanged after the ownership field is added, updating only the literal expected pane-allocation objects if the assertions compare full object equality; verify with `bun test test/workflow-cli.test.ts test/workflow-effects.test.ts`.

## 4. Verification

- [x] 4.1 Run `bun test test/workflow-cli.test.ts test/workflow-effects.test.ts` and confirm all tests pass.
- [x] 4.2 Run `bun run type-check` and confirm it passes.
- [x] 4.3 Run `bun run build` and confirm it succeeds.
