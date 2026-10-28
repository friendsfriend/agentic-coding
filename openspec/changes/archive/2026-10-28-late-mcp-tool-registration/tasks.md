## 1. API Review and Safe Catalog Propagation

- [x] 1.1 Inspect the pinned Pi MCP/extension catalog-change hooks and pi-durable conversation-selection, deferred-search, and codemode catalog APIs; record the supported public mechanism or bounded turn-admission fallback before coding. If neither supports safe propagation, stop and request a decision rather than using private hooks, upgrading/patching dependencies, polling, or extending startup waits.
- [x] 1.2 Implement owner-scoped catalog reconciliation and refresh the owning conversation's explicit policy-filtered selection through supported serialized admission: additive-only updates may commit while busy with prior names/definitions preserved; non-additive changes wait for an atomic full-idle boundary; propagate supported additions/removals/definition changes to direct, deferred, and native codemode surfaces without a manual refresh.
- [x] 1.3 Detach and settle owner-scoped notifications/work on disposal, eviction and shutdown; ensure active calls retain their execution state and updates cannot resurrect a closing owner or leak across conversations.

## 2. Regression and Boundary Coverage

- [x] 2.1 Add a deterministic generic fake fast+delayed MCP regression that demonstrates the existing failure before the fix, keeps fast tools promptly usable, and makes late tools available to the same durable conversation after the fix without re-creating it or manually refreshing the bridge.
- [x] 2.2 Exercise the late path through model-visible direct/deferred discovery and an actual native codemode nested call in an orchestrator with codemode enabled and no imported-tool allow-list; verify result/schema identity and declared exposure.
- [x] 2.3 Verify registration during active model/tool/codemode execution is deferred/coalesced safely, does not invalidate an active call, and preserves cancellation behavior; verify restricted policy, hidden/model-only/codemode exposure, authoritative collisions and no cross-owner catalog leakage.
- [x] 2.4 Verify never-ready server boundedness and unrelated-tool availability, plus late notifications during/after owner disposal/eviction and shutdown without leaked listeners, background tasks or owner resurrection.
- [x] 2.5 Use only generic fake MCP servers and isolated test configuration; all test and CLI-smoke invocations SHALL set `HOME`, `AGENTIC_CODING_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, `HERDR_WIKI_DIR`, and temporary storage to isolated paths and SHALL NOT use live credentials, stores or Azure/Wiz/GitLab integrations.

## 3. Documentation and Focused Validation

- [x] 3.1 Keep the `local-pi-tool-bridge` OpenSpec delta aligned with the implementation and update `agentic-coding/docs/settings-inventory.md` to document late MCP availability while retaining the distinction that unsupported dynamic Pi extension registration fails closed.
- [x] 3.2 Run the focused `agent-host-pi-tool-bridge` regression under isolated environment paths, a Biome check on changed source/test files, and `bun run type-check`; do not run or require the complete repository test suite as an implementation task.

## Validation Evidence

- Original-source negative control: temporarily reverse only the implementation diff, retain the new test, run `bun test test/agent-host-pi-tool-bridge.test.ts -t 'late direct MCP tools reach'`; fails at late catalog convergence. Restore the exact implementation patch afterwards.
- Final focused test: **25 passed, 0 failed, 131 assertions**. Gated HTTP MCP fixtures cover direct/deferred/codemode additions during an active imported call (including native codemode), queued same-conversation follow-up, native deferred tool search, raw Pi output-schema identity, shared-registry isolation, SSE schema/removal updates at idle, late read-only denial, never-ready startup and late responses after shutdown. Existing tests retain exposure, collision, active-owner eviction, cancellation and sanitized-diagnostic coverage; model and codemode admission use the same public `LiveDoc.run` busy predicate.
- `bun run lint`: zero Biome diagnostics and **71 boundary tests passed**. `bun run type-check`: zero errors after correcting the public API types (async watch callback, stop result, full registered tools for `configure`). `bun run build`: succeeded once; no generated source diff. `openspec validate late-mcp-tool-registration --strict --no-interactive` and `git diff --check`: passed.
- Every test run used isolated HOME/config/Pi/wiki/temp paths and generic fixtures only. Two non-test help/format invocations earlier in the attempt lacked the isolation envelope; neither intentionally opened a store, started an app or used a real integration. Subsequent validation used the full isolation envelope. No full repository suite, dependency upgrade, private production API, service restart, commit or push.
