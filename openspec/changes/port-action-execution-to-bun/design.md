## Context

Depends on `port-git-providers-and-ai-to-bun`. Go actionregistry/actionrun/actionexec implement versioned definitions, semantic step trees, deduplicated execution, named values, commands, readiness and dependency leases. This is distinct from agentic-coding's workflow state machine and durable outbox.

## Goals / Non-Goals

**Goals:** Feature-compatible Bun environment action execution plus script/process lifecycle and recoverable command history.

**Non-Goals:** Collapsing both engines, generic workflow retries, live cross-runtime run reparenting or porting container/Kubernetes adapters yet.

## Decisions

1. Port pure definition compilation, IDs, labels, snapshots and projections first. Keep stable resource/action/runtime/profile IDs; compact snapshots and registry versions remain attached to active/history runs. Publish reload snapshots atomically. Do not hash display labels, array order or checkout paths into identity.
2. Separate semantic StepDefinitionID from ExecutionKey. One canonical execution owns commands; reference nodes mirror outcomes without duplicating command output. Typed named values retain action/composite/step scopes and public/internal/secret/ephemeral visibility; secret/ephemeral values never persist. Composite/SDK steps may remain commandless, but each real process command gets one leaf and its own stdout/stderr/exit/error.
3. Translate executor and coordinator using native Bun processes and existing TS domain helpers, not a new generic job framework. Preserve failure/always-run cleanup, readiness gates, already-running outcomes, cancellation and leases. Workflow engine stays Effect-native with its existing failure/outbox policy; environment retry semantics are ported on their own terms.
4. Port scripts, argument history, metadata discovery, interpreter selection, shell/PowerShell/systemshell behavior, process groups and tmux readiness/recovery. Metadata execution and command output must have explicit bounds and audit identity. Terminal-dependent launch stays coordinated with frontend capability requests, while execution state is backend-owned.
5. Until runtime adapters migrate, Bun action owner invokes narrow private Go operations for container/Kubernetes work. Go adapter emits actual command lifecycle/output events carrying exact execution identity; it does not allocate a competing run tree or mutate history directly. SDK-only operations remain commandless. Cancellation is propagated and late results rejected by owner identity. Keep separate physical resource/dependency leases to prevent duplicate live starts.
6. Cut over at a quiescent boundary: wait for/cancel old active command runs; do not pretend old in-memory process handles transfer. Long-lived externally managed resources can be rediscovered/adopted under existing readiness and ownership rules. Historical runs stay readable.

## Risks / Trade-offs

- Tree looks equivalent but executes duplicate dependencies → golden tree plus command-count assertions.
- Runtime private adapter fabricates grouped commands → test one leaf per executed backend command, including failures and already-running paths.
- Secrets enter snapshots/logs → serialization and error-redaction tests with sentinel values.
- Cancellation kills adopted process → exact process/resource identity checks and successor/adoption fixtures.

## Migration Plan

Port pure registry tests, value flow and command accounting; port executor/process/readiness; port scripts/tmux; install private runtime adapters; quiesce and switch sole run owner to Bun. Exercise config reload during run, duplicate dependency paths, failure cleanup, crash/restart and history rendering. Rollback requires settled runs and restored ownership selection; do not reopen old Go execution with live Bun handles.

## Open Questions

No blocking choices. Retry/readiness constants must match captured Go behavior unless a separately approved fix changes them.
