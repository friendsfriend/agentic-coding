## 1. Approval and public API gate — no implementation before approval

- [x] 1.1 Obtain developer approval of proposal/design/specs and incremental implementation plan; retain current checkout/branch, no worktree/merge/push, and preserve unrelated work. Approval of artifacts alone SHALL NOT imply approval of an unspecified dependency upgrade.
- [ ] 1.2 Establish a safe public-only user-level loading/config/auth composition on approved 1.5.2, or present the exact minimal upstream API/release/dependency changes for separate approval. Prove user-only selection, actual cwd, no package install/config writes and no Pi session/model; do not deep-import internal loaders or assume 1.5.2 resolves the documented gap. Stop if unresolved.
- [ ] 1.3 Record approved direct dependency ownership/version plan for pi-codemode, pi-mcp and WASM assets; make only explicitly approved manifest/lock changes. Capture exact feature baseline/changed-file scope and build a requirements-to-tests matrix before implementation.

- [x] 1.4 Apply explicitly developer-approved dependency-only upgrade of existing chord/pi-ai/pi-coding-agent/pi-durable pins and lockfile to 1.5.2 without lifecycle scripts or integration initialization; confirm transitive pi-codemode/pi-mcp resolve to 1.5.2.
- [x] 1.5 After implementation approval, migrate existing call sites to 1.5.2 public APIs: task status changes, WatchCall envelopes, Context import location, removed watchEvents and changed promotion test API. Re-run unfiltered checks before adding feature behavior; see design upgrade evidence. Already completed in checkout commit 87bda0743a1f1e90f3c379b32ceb711ad694f6f6 before this apply session; fresh unfiltered type-check passes. Commit records passing lint/build/full suite; not independently rerun in this gate-only session.

## 2. Native codemode and one durable surface — unit first

- [ ] 2.1 Add fake-model unit fixtures for root/project orchestrators, interactive workflows, nested worker/verifier/fixer and explicit standalone no-tools chat; prove parity and no extra session/process/model/runtime.
- [ ] 2.2 Compose native codemode and native tool-search extensions through one v2 surface policy at runtime/orchestrator and post-workspace task child configuration points, including persisted conversations. Use native nested execution/discovery/replay and disable optional model helpers; do not role-filter tools.
- [ ] 2.3 Add source WASM/worker resolution and bounded actual-exit worker accounting using public sandbox APIs; test native discovery, structured output, cancellation and nested native invocation.

## 3. Inert config and bounded conversation owners

- [ ] 3.1 Add isolated config fixtures and unit tests for supported Pi dir override/fallback, global-only enablement/settings, untrusted project exclusion and empty/disabled zero processes/network/extension execution.
- [ ] 3.2 Implement the approved read-only public config/loading composition; preserve existing credential references, prevent package install/login/credential commands, and keep logs/cache/state v2-owned. Report unsupported configured cases rather than pretend absence.
- [ ] 3.3 Add an explicit maintenance mode and actual stopped-host cleanup CLI sentinel test proving no integration loader/client/extension/worker/agent initialization; do not rely solely on resume:false.
- [ ] 3.4 Implement owner identity/generation fencing, isolated extension runtime/event bus, bounded admission/idle eviction and idempotent disposal primitives. Unit-test no active-owner eviction, no cross-owner mutable-state leakage and actual cwd changes.

## 4. Direct MCP and headless extension adapters

- [ ] 4.1 Add local mock stdio/HTTP MCP and synthetic extension fixtures with controllable event/barrier completion, mixed outputs and lifecycle counters; use no real user extensions/config/services.
- [ ] 4.2 Implement direct public MCP client/transports, cancellation/progress and closure with bounded connection admission and supported read-only auth; test sanitized unsupported/auth/unavailable diagnostics and no auto-login or secret persistence.
- [ ] 4.3 Implement headless extension runtime bindings and honest lifecycle/tool context; test actual cwd, native call identity/signal and ctx.executeTool through native executor. Diagnose UI-only metadata without blanket rejection; fail dependent tools closed for unsupported safety/session/provider/prompt semantics rather than fake behavior.
- [ ] 4.4 Implement deterministic imported identities/reverse mapping with native-name precedence and source/normalized/JavaScript-identifier collision tests independent of event order.
- [ ] 4.5 Map all five exposures, activation and schemas into native callers/deferred/output contracts; test real native search/describe and invocation, hidden rejection and model-only script exclusion.
- [ ] 4.6 Preserve bounded text/image/structured/errors/details/progress with traversal-before-serialization limits; test huge containers/images, malformed outcomes, structured errors, excessive progress, nested-call depth/count and cancellation followed by late success.
- [ ] 4.7 Default imported calls to replay:unsafe regardless of remote annotations. Add deterministic native restart tests for completed-result reuse and unsafe nested codemode interruption refusal with exactly one mock issuance; never simulate replay by calling a raw adapter callback.

## 5. Event-driven catalog updates and lifecycle joins

- [ ] 5.1 Subscribe to extension MCP registry changes, tool-refresh events and MCP list-change notifications; coalesce synchronous batches and maintain desired/applied generations without sleeps/polling/session/client recreation.
- [ ] 5.2 Reconcile registry and explicit owning-conversation selections at proven supported safe boundaries; test late tools in the same conversation, activation/exposure/schema replacement/removal, in-flight snapshot stability and ordering before the next model round.
- [ ] 5.3 Wire cancellation/completion/removal, orchestrator closure and host shutdown to fence/unsubscribe/abort/join/dispose owned resources. Test cancellation-resistant trusted callbacks, owner limits, late event/result rejection and unaffected unrelated conversations; do not claim disposal before work settles.

## 6. Bundle and isolated acceptance

- [ ] 6.1 Extend scripts/build.ts to emit/resolve QuickJS WASM and worker assets for the existing JS-bundle distribution; no v1 imports, manual embedded.generated.ts changes or source-tree fallback.
- [ ] 6.2 Run isolated source and bundle acceptance with temporary HOME/Pi/config/state, fake models, synthetic extensions and local mock MCP: orchestrator plus nested codemode, native/extension/MCP discovery/invocation, exposures/collisions, context/output/cancellation/cleanup, same-conversation late tools, unsafe replay refusal and sanitized diagnostics. Assert no extra Pi session/process/model/runtime and no real-config writes.
- [ ] 6.3 Verify all tests are unit-first/event-driven, no deadline sleeps/polling/timeout inflation and no default tmux manipulation. Preserve src/web/*, telemetry.test.ts, unrelated target/discovery tests and docs/ absence. Keep decisions in call-site comments/tests/OpenSpec/commits; tabs, Biome zero, no non-null assertions.

## 7. Required checks and independently scoped verification

- [ ] 7.1 After approved implementation batch run unfiltered from agentic-coding-v2: bun run type-check; bun run lint; bun scripts/build.ts. Run full test suite with measured duration and report duration and failures together; retain exact results and distinguish preexisting failures without hiding them.
- [ ] 7.2 Have the verification coordinator establish the actual feature base/diff, then assign each independent reviewer its explicit relevant changed-file list and diff. Use copilot-sol/shared checkout for authorized delegation, resolving missing repository admission configuration first if necessary; never substitute another repository.
- [ ] 7.3 Triage findings before fixes: reject preexisting/unrelated/preference findings, accept only evidenced feature defects, then refresh reviewer assignments/diffs after fixes and rerun required checks. Report CLEAN only with independent review and real passing required evidence; no archive/push just because an agent terminated.
- [ ] 7.4 Present concise final changes/checks/compatibility limits and separately authorized live acceptance still needed. Do not initialize real integrations, issue live provider/MCP requests, deploy, edit credentials, restart the host, merge or push without applicable separate authorization. Proposal phase ends before task 1.1 is checked.
