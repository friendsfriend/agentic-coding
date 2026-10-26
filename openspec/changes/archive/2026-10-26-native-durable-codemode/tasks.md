## 1. Confirm native API and behavior

- [x] 1.1 Inspect the installed `@earendil-works/pi-durable@1.4.0/codemode` exports, declarations and implementation; verify extension configuration, tool discovery namespace, `executeTool`, output/progress, cancellation, nested-call recovery/replay, and `store`/`load` lifetime and commit behavior.
- [x] 1.2 Audit repository and native-extension consumers of `@earendil-works/pi-codemode` and its patched `onOutput` API; record whether the patch remains required and identify the native worker/WASM asset paths.

## 2. Migrate durable host execution

- [x] 2.1 Replace the custom codemode executor with `createCodemodeExtension` while preserving user-global-setting enablement, supported non-orchestrator host modes, orchestrator exclusion, and direct tools.
- [x] 2.2 Bind native tool discovery and execution to each active run's actually offered and authorized registrations; verify read-only runs cannot discover or execute `write` or `edit`, and fail closed if the native API cannot enforce this boundary.
- [x] 2.3 Adapt only host-specific bounded output, live progress, nested-call details and script result presentation that the native extension does not already provide; preserve errors, prevent duplicate streamed output, propagate cancellation and close sandbox work safely.
- [x] 2.4 Remove redundant custom sandbox, nested execution, call journaling and asset code only after the native extension replaces their responsibilities; update build asset wiring as required by verified source and compiled worker/WASM resolution.
- [x] 2.5 Retain or remove the `pi-codemode` patch based on the consumer audit; update `patches/README.md` and codemode/dependency documentation with the decision and verified native nested-call and `store`/`load` behavior.

## 3. Add focused regression coverage

- [x] 3.1 Extend codemode host tests for enabled/disabled user settings, orchestrator exclusion, preservation of direct tools, run-specific discovery and read-only `write`/`edit` refusal.
- [x] 3.2 Add nested-call success/failure, cancellation, bounded output, live progress and shutdown coverage, including assertions that streamed output is not duplicated and UI details remain useful.
- [x] 3.3 Add temporary-storage recovery tests for the native nested-call journal and `store`/`load` behavior, including same-conversation access, cross-conversation isolation, failure/commit semantics and restart behavior; document any intentional change from the old process-local map.
- [x] 3.4 Add a source sandbox initialization smoke test and a compiled-binary smoke test that runs outside the source checkout and proves the native worker and WASM assets load.

## 4. Validate in isolation

- [x] 4.1 Run focused codemode regression tests and source/compiled smoke checks with temporary storage and isolated `HOME`, `AGENTIC_CODING_CONFIG_DIR`, `PI_CODING_AGENT_DIR` and `HERDR_WIKI_DIR`; do not open real workflow stores.
- [x] 4.2 Run `bun run lint`, `bun run type-check`, and `bun run build` from `agentic-coding`; fix all diagnostics and verify compiled sandbox assets in the built executable.
