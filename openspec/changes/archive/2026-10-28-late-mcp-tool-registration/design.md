## Context

The bridge currently has two distinct snapshots. `LocalPiToolBridge.waitForMcpTools` has a bounded startup budget but returns after an MCP tool appears stable briefly; `refreshOwnerTools` builds an owner snapshot. Later, `DurableHost.ensureRun` calls `toolsForPolicy` and explicitly configures the conversation's selected tool set. If another server registers after that, its upstream session may know the tools while both the bridge snapshot and durable conversation selection remain stale. Re-running `ensureConversation` refreshes the former, but is not a supported user operation and by itself does not update the latter. The current native policy, exposure and collision rules are specified in `local-pi-tool-bridge` and must remain authoritative.

## Goals / Non-Goals

**Goals:** Make supported late MCP registration and catalog changes reach the owning durable conversation's next safe model/deferred-discovery/native-codemode surface. Preserve early-tool availability, bounded startup, run policy and exposure semantics, result/schema identity, per-conversation isolation, active work, and cancellation/disposal/shutdown safety.

**Non-Goals:** Waiting indefinitely for all servers, increasing startup waits as the fix, unbounded polling, changing extension dynamic-registration support, adding a parallel search/codemode executor, patching dependencies, upgrading Pi packages, using Azure/Wiz/GitLab integrations, or weakening human review.

## Decisions

1. **Use supported catalog-change and conversation-selection APIs.** Before implementation selects a mechanism, inspect the pinned Pi MCP/extension public registration-change hooks and pi-durable's public dynamic selection, configuration, deferred-search, and codemode catalog APIs. Prefer a supported notification for catalog changes. If no suitable notification is available, only use an existing bounded host turn-admission boundary to reconcile the owner and selected set; do not monkey-patch private upstream state, add polling, or add compatibility layers. If the required behavior is impossible with supported APIs, stop and request a decision rather than upgrading or patching a dependency.
2. **Reconcile per owner using additive busy updates and atomic idle admission.** Developer approved the narrow additive design revision during implementation (decision `approve-additive-revision`, question group `88df4047-88d1-4468-992d-ee27158f58ad`). Public `configure` may add authorized names while busy, preserving all prior selected names and `modelTools`; prepared requests remain fixed, while later requests, including queued follow-ups, see additions. Never replace/remove an active definition as part of that path. Non-additive changes are coalesced until full conversation idle; read public `LiveDoc` and apply public `configure(tx, ...)` in the same Harness commit so a queued generation cannot race a stale idle check. A public conversation watch wakes this pending work on idle, not a polling loop. Late additions become available without a session/process restart or operator-triggered refresh.
3. **Re-use existing authorization and identity rules.** For every update, derive selected tools for the current conversation and run policy through existing policy, native exposure, collision, schema/result adapter and tool-search semantics. A shared registry may hold a registration, but it does not authorize another owner's selection. Direct, deferred, model-only, codemode-only and hidden tools keep their declared surfaces; restricted runs remain fail-closed, and orchestrator runs keep all compatible imports without an allow-list.
4. **Keep startup and teardown bounded.** Preserve early tools and current finite startup/cancellation behavior; one unavailable server must not block other tools indefinitely. Use event/turn-boundary work rather than a polling loop. Stop accepting updates once an owner is closing or the bridge is closed; detach listeners and await/cancel owner-scoped work during disposal and shutdown so late notifications cannot resurrect an owner or leak into another conversation.

Alternatives rejected: extending startup until every server responds (unavailable servers would delay healthy tools); periodic polling (unbounded work and teardown complexity); and refreshing a process-wide catalog into every conversation (cross-owner policy/catalog leakage). Exact API names and whether an upstream notification can be safely applied immediately or must be queued are implementation findings, not assumptions.

## Risks / Trade-offs

- **[Upstream API lacks a suitable change notification or safe dynamic selection API]** → Inspect the pinned public API before coding; use only a supported safe turn-admission reconciliation if adequate, otherwise escalate instead of patching/upgrading.
- **[Refresh races with active model or nested execution]** → Serialize selection changes at safe admission, retain active-call definitions through completion, and test registration during active execution.
- **[Shared registry or stale run policy widens another owner's catalog]** → Recompute each owner's selected set with the current run policy and test two owners, collisions, restricted exposure, and orchestrator-without-allow-list behavior.
- **[Delayed/unavailable child processes make tests flaky or leak]** → Use a deterministic generic fake MCP server, explicit readiness markers/barriers, bounded waits, and cleanup; isolate HOME and all agentic-coding/Pi/wiki/temp storage for test runs.
- **[Late notification arrives during owner disposal or shutdown]** → Guard closing/closed owners, detach notification hooks, and verify disposal and shutdown settle without resurrecting catalog state.

## Migration Plan

No durable storage format or configuration migration is expected. Existing settings and startup behavior remain compatible. Rollback is a code rollback; do not remove or rewrite local Pi settings. Regression tests and test/CLI invocations must use isolated HOME, `AGENTIC_CODING_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, `HERDR_WIKI_DIR`, and temporary storage, and must not contact live user integrations.

## Pinned Public API Audit (1.4.0)

- Pi `createMcpExtension` is a public extension factory. Its `registerTools`/resource synchronization calls public `ExtensionAPI.registerTool` and `setActiveTools` synchronously per batch, including hidden re-registration for dropped tools. Compose the bridge-owned factory with a wrapper of those public API methods, forwarding unchanged and coalescing observation with one microtask. Do not replace runner/runtime callbacks or patch dependencies. Initial registrations before owner installation are covered by the initial refresh and bounded host watch admission.
- pi-durable README **Per-Conversation Agent** documents that `configure` commits `pi.agent` atomically and prepared requests are fixed. **Reload** documents that registry replacement preserves running implementations. `dist/harness/generation.js` resolves the request agent in `prepare`, before `beforeRequest`; thus `beforeRequest` is not used as a selection hook.
- Public package exports `AgentDoc`, `LiveDoc`, and transaction-level `configure`; use them for atomic idle checks and selection updates. Do not overwrite model/cwd/extensions/modelTools during reconciliation. Publish registrations before selecting names. Existing differing owner schemas retain precedence; an incompatible contender fails closed rather than mutating another owner's active catalog.

## Open Questions

No product decision is open. The implementation must resolve the public-API mechanism through the required pinned-dependency review before choosing a concrete implementation; any path requiring unsupported private APIs, dependency changes, or an unbounded refresh loop must be escalated.
