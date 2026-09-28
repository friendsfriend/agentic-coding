# Tasks

## 1. Port contract and Herdr adapter extraction

- [x] 1.1 Add `src/multiplexer/port.ts` defining the Effect-native `MultiplexerPort` (workspace, worktree, tab, pane, agent, notification, and scoped event operations), the normalized result types, and the `MultiplexerError` kind discriminator; verify `bun run type-check` passes with no `Promise` method, optional method, capability flag, or raw-argument method on the interface.
- [x] 1.2 Move the Herdr subprocess boundary and envelope parsing into `src/multiplexer/herdr/cli.ts` and the Herdr Effect Schemas into `src/multiplexer/herdr/schema.ts`, re-exporting `parseHerdrResult`, `decodeHerdrResult`, and the geometry helpers from their previous paths; verify `test/herdr-client.test.ts` passes unchanged.
- [x] 1.3 Move `HerdrLifecycle` and the runtime adapters into `src/multiplexer/herdr/index.ts`, keep `HerdrPort` as a deprecated alias, and implement the port over the moved CLI boundary with identical command argument arrays; verify `test/workflow-adapters.test.ts` passes unchanged.
- [x] 1.4 Map Herdr `not found`/`unknown workspace` diagnostics to the absent kind for `workspaceGet`, `paneGet`, and `agentGet`, and map other failures to the unavailable kind; verify a focused test asserts absent-versus-unavailable classification for each getter.
- [x] 1.5 Verify the Herdr behavior oracle before any caller migration: run `scripts/test-herdr-manager.sh`, `scripts/test-herdr-workflow.sh`, `bun test test/herdr-client.test.ts test/workflow-adapters.test.ts`, and `bun run lint`.

## 2. Runtime selection

- [x] 2.1 Add the top-level `multiplexer` selector to the configuration schema and reject unsupported values with the supported identifiers; verify a focused configuration test covers default, configured, invalid, and environment-override resolution.
- [x] 2.2 Add `src/multiplexer/factory.ts` resolving `AGENTIC_CODING_MULTIPLEXER` over configuration with a `herdr` default, and failing loudly when the selected runtime cannot be constructed; verify a test asserts no fallback occurs when the selected runtime is unavailable.
- [x] 2.3 Forward `AGENTIC_CODING_MULTIPLEXER` and the selected runtime's connection variables through the detached drain environment allowlist in `src/workflow/cli/drain.ts`; verify a focused test asserts the child allowlist contains the selector and `LUVUS_*` variables.

## 3. Workflow execution migration

- [x] 3.1 Replace the `HerdrPort`/`herdrCallEffect` usage in `src/workflow/adapters.ts` with the injected `MultiplexerPort` and port-based agent lifecycle calls, preserving launch confirmation, retry, and identity behavior; verify `test/workflow-adapters.test.ts` and `test/herdr-client.test.ts` pass.
- [x] 3.2 Migrate `src/workflow/effect-runner.ts` workspace/worktree setup, live-agent resolution, launch prompt delivery, notification, and workspace-close handlers to port operations, keeping failure classification (`transient`/`permanent`/`ownership`/`interrupted`/`defect`) unchanged; verify `bun test test/workflow-execution.test.ts test/workflow-effects.test.ts` passes.
- [x] 3.3 Migrate `src/workflow/cli/pane.ts` allocation, reuse-before-spawn resolution, and split geometry to port operations, keeping the `owned` flag semantics for launch-failure cleanup; verify `bun test test/workflow-execution.test.ts` covers reused-pane and newly-created-pane launch failure.
- [x] 3.4 Migrate `src/workflow/tab-sync.ts` tab listing and renaming to port operations, keeping best-effort non-throwing behavior; verify `test/workflow-tab-sync.test.ts` passes against a fake port.
- [x] 3.5 Migrate `src/workflow/notification-sync.ts` notification delivery and dashboard focus to port operations, keeping the delivery outcome vocabulary and skip-not-fail focus semantics; verify `test/workflow-notification-sync.test.ts` and `test/workflow-notification-observer.test.ts` pass.
- [x] 3.6 Confirm `src/workflow/sidebar-sync.ts` still uses Herdr `agent.view` calls and is not routed through the port; verify `bun test test/workflow-sidebar-sync.test.ts test/workflow-sidebar-observer.test.ts` passes and no port method mentions sidebar or custom view.

## 4. Dashboard migration

- [x] 4.1 Migrate `src/server/operations/observations.ts` workspace listing, focus, pane lookup/layout/focus, tab creation, and pane-run calls to the injected port, preserving the existing focus traversal behavior; verify `bun test test/server-api.test.ts test/server/operationsOwnership.test.ts` passes.
- [x] 4.2 Replace the Herdr socket subscription in `src/server/herdr-events.ts` with a scoped port event subscription that decodes normalized events and resumes with bounded backoff; verify `bun test test/dash/herdr-events.test.ts` passes against a fake subscription and covers a dropped stream.

## 5. Luvus adapter

- [x] 5.1 Add `src/multiplexer/luvus/{cli.ts,uhp.ts,schema.ts}` implementing the UHP request/response transport over the Luvus socket with session selection and Luvus-specific Effect Schemas; verify a focused test decodes a recorded envelope and rejects a mismatched shape as a bounded error.
- [x] 5.2 Implement `src/multiplexer/luvus/index.ts` covering every port operation, including worktree creation paired with its workspace, `pane.focus`, `pane.processes`, atomic agent start/prompt, and normalized agent status; verify a test asserts the exact UHP method and params emitted for each operation.
- [x] 5.3 Implement notification delivery through the Luvus presentation operation, choosing the needs-attention level and treating unauthorized or refused delivery as a recorded outcome; verify a test covers shown, refused, and unavailable delivery outcomes without retry loops.
- [x] 5.4 Implement the scoped Luvus event subscription with sequence resume on reconnect; verify a test asserts the subscription is released when its scope ends and that a resumed stream does not replay already-applied events.

## 6. Conformance and verification

- [x] 6.1 Add a shared adapter conformance suite parameterized over both runtimes covering every port operation, normalized identities, absent-versus-unavailable classification, launch retry, and notification outcomes; verify the suite runs for both adapters in one test file.
- [x] 6.2 Add runtime-specific request assertions for Herdr command argument arrays and Luvus UHP requests; verify each adapter's emitted requests are asserted separately from the shared suite.
- [x] 6.3 Add a focus test for a live Luvus agent launch and prompt against the installed `0.14.2` binary, skipped with an explicit reason when the binary or socket is unavailable; verify the skip condition is reported rather than silently passing.
- [x] 6.4 Run the focused change suite and the static gates: `bun test` for the touched files, `bun run type-check`, `bun run lint`, and the unchanged `scripts/test-herdr-manager.sh` and `scripts/test-herdr-workflow.sh`.
- [x] 6.5 Confirm the documentation deltas: `docs/workflow-architecture.md` and `docs/workflow-effect.md` describe the multiplexer boundary and the selector, and no documentation claims Herdr is the only supported runtime.
