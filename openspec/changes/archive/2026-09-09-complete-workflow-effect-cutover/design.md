## Context

The preceding phases establish Schema/errors, engine services, and scoped handlers. Today workflow callers span CLI verbs, startup, dashboard actions/refresh, home wiki review, model configuration, question waits, project discovery, and telemetry. The dashboard currently imports CLI plumbing; the prerequisite architecture changes remove that ownership violation before this final cutover.

The migration is complete only when those callers use one Effect application path and agents no longer have to choose among legacy and migrated patterns. Pure domain and UI code intentionally remain native TypeScript/Solid.

## Goals / Non-Goals

**Goals:** explicit application runtime ownership, safe CLI/UI interruption, finished caller migration, no abandoned shims, preserved user/durable contracts, and checked agent guidance backed by observed task outcomes.

**Non-goals:** rewriting unrelated UI features, changing workflow semantics or storage, introducing a long-lived background service, or treating typed effects as automatic correctness proofs.

## Decisions

### 1. Run Effect only at named composition roots

CLI invocation owns a runtime scope for its command and bounded continuation/export cleanup. The dashboard owns one application runtime with child scopes for repository execution and observation, not a fresh runtime per refresh/action. Build production Layers once at the appropriate owner; tests substitute the same service requirements. Keep mutation dispatch in-process.

Migrate the coordinator introduced by `separate-workflow-observation-execution` to these scopes without changing its explicit scheduling semantics. Status/list/view reads do not start drains, initialize stores, or expire questions. Detached bounded continuation uses the explicit drain surface, never disguised status; verify progress after commit without refresh and across CLI exit/restart. Different processes can still compete, so SQLite leases remain authoritative even if one dashboard has one coordinator.

Handle SIGINT/SIGTERM through owned cancellation and bounded finalization. Managed agents/workspaces transferred to durable workflow ownership survive application shutdown unless an explicit workflow command requests their stop. Process death can bypass finalizers; the next owner recovers through durable rows and observation.

### 2. UI is a framework boundary, not a second engine

Keep components/rendering and pure dashboard projections in Solid/OpenTUI. A narrow application bridge submits Effect programs, maps expected failures to existing UI state, and cancels owned work on repository/workflow switch or unmount. Late results are keyed to selection/request identity and cannot overwrite newer UI state. Credential requests are associated with their owning operation and cancelled when it ends.

Do not put `runPromise` throughout components or call `runSync` to preserve old synchronous I/O signatures. Backend/application modules do not import TUI to obtain credentials; the UI provides the concrete interaction service. Keep engine-provided action IDs/revisions as the only action authority. No new global state library is needed.

A cancelled mutation may already have committed. On uncertain outcome refresh the authoritative view; never display successful rollback or automatically replay the command because the view changed while it ran. Observational refresh failures surface non-authoritative error/loading state without inventing workflow status.

### 3. Complete workflow-facing telemetry and remaining I/O

Migrate telemetry emission/export through owned Effect services. Preserve the existing JSONL envelope and traceparent correlation for workflow/run/effect identities; bridge existing external trace context into Effect spans rather than fork unrelated traces. Bound exporter waits/output and redact credentials/capabilities/content by the established policy. Export failure cannot roll back, replay, or mask a committed command. On shutdown flush within a fixed documented budget, then stop; never leave detached export fibers as accidental liveness owners.

Use the inventory to cover wiki tooling, model/configuration reads and writes, project discovery, caller identity/authentication, question loops, navigation bookkeeping, and asset acquisition beyond the obvious engine start/dispatch paths. Reuse existing application services and shared transports. Build-only asset generation and pure schema/format/digest operations stay outside runtime I/O migration, with explicit inventory disposition.

### 4. Delete transition paths and guard the final model

Remove each exact migration bridge recorded since phase 1, along with the old parser bodies, exception/message-driven orchestration, timer loops, duplicated clients, and unused dependencies it replaced. Internal barrel symbol/signature fixtures may be intentionally updated for the final API, but not blindly regenerated as evidence of compatibility. Keep independent CLI/JSON, snapshot/digest, capability/security, and lifecycle fixtures as unchanged behavioral oracles unless an explicitly approved prerequisite changed that contract.

Extend the prerequisite TypeScript source graph checker instead of adding a linter. Maintain a small exact list of runtime owners and native boundary modules. Check resolved imports/calls, including aliases where recognized by the existing parser, for nested runtime execution, direct workflow I/O outside boundaries, forbidden CLI/TUI coupling, and obsolete shim imports. Verify negative fixtures and unused exception detection. Treat checks as bounded static guardrails, not whole-program purity or a security sandbox.

Normal pure functions and leaf native/Promise adapters are not violations. A scope-owned framework bridge is not a migration shim. Every inventory row must end as migrated, pure, native boundary, or explicitly out of workflow scope; no unowned “later” rows remain.

### 5. Agent-friendly completion has concrete evidence

Update root instructions, workflow README, architecture map, and Effect playbook to the finished APIs. Provide production-backed checked recipes for (1) adding an external handler with safe recovery/cancellation and (2) extending a validated command and pure step behavior. Each shows minimal files touched, where services live, expected failures, and focused verification commands. No parallel custom abstraction layer or multiple equally preferred styles.

Repeat phase-1 agent tasks with the recorded prompts/model/settings on isolated worktrees, supplying each implementation's own documented guidance. Record checks passed, human corrections, unsafe API usage, and review findings. Model availability changes or small sample size must be reported; this is practical evidence, not a statistical guarantee. A poor outcome requires explicit review of the leverage claim and recipes, not fabricated success. Correctness gates do not depend on productivity measurements.

## Risks / Trade-offs

- New runtime on every refresh duplicates resources -> one dashboard owner, child scopes, and disposal/reopen tests.
- Shutdown stops durable agents or strands commits -> resource transfer plus real restart/observation tests.
- Cleanup/export hides original failure -> bounded finalizers and separate failure reporting.
- Old symbol fixtures hide regressions -> review intentional internal API changes separately from external compatibility oracles.
- Agent docs drift -> examples compile/run against production symbols and locked dependency versions.

## Migration Plan

Confirm all prerequisites, then migrate application composition, CLI, dashboard/other workflow callers, and telemetry. Delete shims only after their callers move. Run focused CLI/dashboard/effect/e2e/observability/architecture checks, type check, zero-diagnostic Biome, and compiled-binary smoke checks. The workflow-owned test verifier retains full configured suite responsibility.

Stop existing drain owners and deploy compatible binaries together. Preserve supported store versions and semantic definitions; reopening pending workflows must work without Effect-specific migration or repin. Roll back only to a binary proven compatible with current persisted data and the renewable lease/explicit execution lifecycle. Consult prerequisite store-backup policy if a separate schema upgrade landed; Effect conversion alone adds no down migration.
