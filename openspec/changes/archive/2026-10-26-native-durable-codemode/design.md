## Context

The current durable host installs a custom `codemode` extension from `src/agent-host/codemode.ts`. It asks the active agent for its tool registrations, builds a `@earendil-works/pi-codemode` sandbox, invokes each nested registration directly, and separately records nested-call arguments, output, errors, details and progress. It also maintains a process-local store map keyed by durable conversation id. `host.ts` registers codemode only when `resolveCodemodeRegistered` finds the user's global Pi setting and excludes the orchestrator. `codemode-assets.ts` and `scripts/build.ts` resolve and embed the QuickJS WASM and worker for source and compiled runs.

The repository's dependency-upgrade notes identify the public `@earendil-works/pi-durable/codemode` extension and `api.executeTool()` as providing native durable nested calls, replay journals, structured output validation, progress and ownership, and recommend replacing the manual execution/call bookkeeping while preserving policy, telemetry, UI details and script results. The installed package source and type declarations are not present in this planning checkout, so exact option names and the precise replay and state contracts must be confirmed against the installed 1.4.0 package during implementation rather than inferred.

## Goals / Non-Goals

**Goals:**

- Make `createCodemodeExtension` from `@earendil-works/pi-durable/codemode` the sole codemode execution implementation.
- Preserve user-local global-settings enablement, supported non-orchestrator host modes, orchestrator exclusion, directly offered tools, per-run callable-tool authorization and read-only restrictions.
- Preserve bounded output, live progress, nested-call failures, cancellation and orderly sandbox/host shutdown where the native API exposes the corresponding hooks.
- Verify native nested-call durability/replay and native `store`/`load` scope and commit/lifetime behavior, and document any intentional difference from the current implementation.
- Verify the sandbox's WASM and worker assets in source execution and the compiled binary; remove obsolete custom code and update focused tests and documentation.

**Non-Goals:**

- Change the local Pi extension/tool bridge, remote MCP configuration, global codemode enablement policy, or workflow/orchestrator tool design.
- Claim nested calls are exactly-once/replay-safe or that stored codemode data survives host restart until the native package contract has been inspected and tested.
- Remove the `pi-codemode` patch solely because the host stops importing its sandbox API.

## Decisions

1. **Use the durable package's native extension, not a second executor.** Install `createCodemodeExtension` through the existing durable `Registry` path and use its documented registration/options. Remove the hand-built `CodemodeSandbox` execution, `nestedTool` execution callback and duplicate nested-call lifecycle once equivalent host integration is covered. A thin adapter may remain only to bridge host-specific registration, bounded progress/result presentation or structured UI details; it must delegate execution and nested calls to the native extension and must not create another sandbox or replay policy. The alternative—retaining the custom executor beside the native extension—would duplicate execution authority, journaling and cancellation.

2. **Filter capability access at the run boundary.** Preserve the current setting-based decision in `resolveCodemodeRegistered` and the orchestrator exclusion. Configure or compose the native extension with the current run's actual offered/authorized tools using its public discovery and execution APIs. Never give the extension a global tool registry and rely only on prompt text or hidden names for safety. If the native API cannot express the current policy, fail closed and resolve that integration before implementation rather than expose unoffered tools. Keep direct tools in addition to codemode. Continue to test readonly `write`/`edit` absence and refusal.

3. **Adopt and describe native nested-call recovery semantics.** Inspect the 1.4.0 public exports and implementation documentation for nested call ownership, persistence, interruption, replayability and error propagation. Test a host interruption around a nested call using temporary storage and a disposable tool, and capture which path is replayed versus reported interrupted. Delegate nested calls to `api.executeTool()` or the exact native API established by source; do not retain manual direct `ToolRegistration.execute` as a fallback. Document the observed and supported policy without promising exactly-once effects beyond the upstream contract.

4. **Use the native store/load contract rather than carrying a misleading map forward.** The existing map is keyed by conversation, is updated only after a successful script, and lives only in the host process; it is not crash-persistent. Inspect native state scope, value restrictions, commit points and crash behavior. Test same-conversation reads/writes, isolation across conversations, failed scripts and host restart. Adopt the native contract, explicitly document any changes, and do not migrate the former ephemeral map into a durable format or describe its behavior as persistent unless tests and upstream documentation support that claim.

5. **Keep host presentation bounded and non-duplicative.** Use the native output/progress callbacks and durable result/details path. Preserve the existing bounded output tail and live nested-call progress required by the dashboard; ensure streamed text appears once in the final result and errors remain errors. Reuse only result/presentation projection code that remains needed after native call records become authoritative. Close or cancel native sandbox work on its documented lifecycle boundary, and verify cancellation and shutdown leave no worker/task behind.

6. **Resolve sandbox assets from the native package for both deployments.** Inspect native package exports and its worker/WASM loading path. Adjust `codemode-assets.ts` and `scripts/build.ts` only as required by that path; source execution must resolve installed package assets and compiled binaries must embed/point to the native package's exact worker and WASM assets. If the native extension owns asset resolution, remove redundant host resolvers and build entries. Run both a source sandbox smoke test and a compiled executable smoke test outside the source checkout.

7. **Assess the patched `pi-codemode` package as a dependency consumer.** Search repository imports and inspect the native extension's package implementation for use of the patched `onOutput` API. Keep the patch and its documentation if native streaming still depends on it or any other consumer needs it. Remove it only after confirming no package consumer requires the patch and focused streaming/output tests pass. The alternative—removing it based only on deleting the old direct import—could silently lose native live output.

8. **Isolate validation storage and identities.** All new or changed tests and smoke checks must use temporary storage and isolated `HOME`, `AGENTIC_CODING_CONFIG_DIR`, `PI_CODING_AGENT_DIR` and `HERDR_WIKI_DIR` as applicable. Do not open real workflow stores. The worker runs focused regression tests and source/compiled asset checks; the workflow's test-verifier owns the complete configured repository suite, so no complete-suite implementation task is added here.

## Risks / Trade-offs

- [The 1.4.0 native package's exact options and recovery/state semantics are not in the checked-out dependency tree.] → Inspect its published public exports, declarations and implementation before coding; record actual semantics in docs and cover them with temporary-storage tests.
- [Native tool discovery could expose a broader registry than the current run's policy.] → Bind native discovery/execution to the per-run offered tool set, assert unavailable tools are absent and refuse to ship if the public API cannot enforce this boundary.
- [The native result shape or progress granularity may differ from the dashboard's codemode call detail model.] → Keep a small presentation-only adapter and test the final transcript/detail projection and no-duplicate output.
- [Native worker packaging may use a different path than the current embedded `pi-codemode` worker.] → Verify source and compiled binary smoke tests independently before deleting or changing existing asset setup.
- [The `pi-codemode` patch may still be required through the native extension's transitive use.] → Inspect all current and transitive consumers and retain the patch unless that audit proves it unnecessary.

## Migration Plan

1. Inspect the installed `@earendil-works/pi-durable@1.4.0/codemode` exports, types, extension setup, tool discovery, `executeTool`, output, cancellation, nested-call recovery/replay and store/load implementation; record verified behavior before adapting the host.
2. Replace the custom executor with the native extension while preserving global-settings gating, orchestrator exclusion and run-scoped tool authorization. Bridge only host-specific output/progress/details that the native API does not supply.
3. Remove custom execution and asset machinery only where the native implementation makes it redundant. Reassess the pi-codemode patch from all package consumers and update its README/docs accordingly.
4. Add focused regression tests for extension visibility, run-specific tool discovery, read-only refusal, nested error/recovery/cancellation, output/progress bounds, store/load behavior and sandbox initialization. Use isolated temporary configuration and storage.
5. Run the focused codemode tests, build/type/lint checks required for changed files, source sandbox smoke, and compiled binary sandbox smoke from an isolated temporary environment. Do not use real workflow stores or restart running services.
6. Rollback is source-level: restore the prior host adapter/build asset wiring if native compatibility or policy tests fail; do not run a data migration because the old codemode store was process-local and the new store must follow the verified native contract.

## Open Questions

- What are the exact public extension options and tool discovery/identifier namespace in the installed 1.4.0 package, and can those APIs enforce per-run tool selection without a second executor?
- Which nested calls are journaled/replayed after interruption, and how are errors, cancellation and non-replayable calls represented?
- What is the native `store`/`load` scope, lifetime and commit behavior relative to the former process-local success-committed map?
- Does the native extension consume patched `@earendil-works/pi-codemode` `onOutput`, and which worker/WASM asset path must the compiled build embed?
