## 1. Implementation

- [x] 1.1 Add pinned `@earendil-works/pi-codemode` and a durable `codemode` tool injecting only the run's offered tools
  - `src/agent-host/codemode.ts` builds the tool on `CodemodeSandbox`; it is an
    *additional* tool (the run keeps its direct tools) and a script reaches
    exactly the tools the run was offered.
  - `src/agent-host/codemode-assets.ts` + `scripts/build.ts` embed the QuickJS
    wasm and the sandbox worker for the compiled binary; an unembeddable build
    reports the tool unavailable instead of failing the run.
- [ ] 1.2 Add `tool_search`
  - Global-settings enablement resolution is done (`globalPiTools` in
    `src/agent-host/host.ts`). `tool_search` itself is not implemented: the
    durable host offers no large/MCP tool catalog for it to search.

## 2. Verification

- [x] 2.1 Focused tests: enablement rules, read-only run cannot reach edit/write through codemode
  - `test/agent-host-codemode.test.ts`
- [x] 2.2 Compile smoke test running a codemode call from the compiled executable
  - `test/agent-host-compiled-smoke.test.ts` (embedded wasm + worker)
