## 1. Read-only MCP vertical slice

- [x] 1.1 Record existing test/gate baseline and add the official MCP SDK with explicit dependency ownership.
- [x] 1.2 Define a transport-independent read-only catalog interface and implement the existing-v2 adapter with explicit repositories, bounded public summaries and no agent-host initialization.
- [x] 1.3 Add stdio MCP registration for env_list/env_discover with strict schemas, structured results, sanitized errors and clean shutdown.
- [x] 1.4 Add representative SDK client/server and disposable filesystem scenarios covering catalog/discovery, authority refusal and absence of mutation tools.
- [x] 1.5 Document invocation, generic MCP configuration, first-slice limits and staged migration; run lint, whole-project type-check and the complete unfiltered suite and record results (initial lint blocker and subsequent clean gates recorded in verification.md).

## 2. Controller persistence and ownership extraction

- [x] 2.1 Isolate transactional environment storage and owner lookup from native Harness/documents without changing existing runtime rules.
- [x] 2.2 Introduce durable controller-issued scope/principal bindings, workspace identity and explicit lifecycle policies for jobs, interactive clients and operator infrastructure.
- [x] 2.3 Implement content-bound idempotent operation admission, immutable plan records and issuance/recovery state; verify foreign-scope refusal and uncertain-restart quarantine.

## 3. Human approval and first owned execution

- [x] 3.1 Add an authenticated operator-only inspection/decision interface with exact plan digest/revision fencing; never expose approval/revocation as MCP tools.
- [x] 3.2 Adapt the existing shell run/build/test, acquisition and cleanup behavior to controller scopes, using original live handles only.
- [x] 3.3 Expose environment action/status/result/stop through MCP and verify a single disposable approved shell scenario including rejection/cancellation and durable receipts (initial explicit programmatic binding; shared serving/bridge added in stage 4).

## 4. Shared controller transport

- [x] 4.1 Add authenticated loopback Streamable HTTP serving with origin/host checks, bounded requests and no automatic remote exposure.
- [x] 4.2 Convert the stdio execution path to a thin bridge to the shared authority; verify two clients cannot cross scopes or start competing authorities.
- [x] 4.3 Implement explicit scope close and controller-enforced idle/lease cleanup; keep disconnect distinct from task completion and operator infrastructure lifetime.

## 5. Runtime and diagnostics parity

- [x] 5.1 Move existing container/Compose/Kubernetes/Helm adapters and dependency lifetime behavior behind the extracted controller without claiming live-engine verification.
- [x] 5.2 Expose bounded/redacted logs, approved HTTP/SQL and telemetry through owner-scoped MCP tools, retaining issuance and generation fences.
- [x] 5.3 Migrate definition staging/promotion and recovery controls to operator-only interfaces; preserve immutable receipts and uncertainty barriers.
- [x] 5.4 Document the completed parity matrix, remaining lifecycle integration gaps and an explicit stopped-host cutover; do not adopt existing live resources.
