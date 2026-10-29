## Context

One cohesive change addresses durable launch authority, stale effect eligibility and bounded reconciliation; a retry-only fix cannot resolve their interaction. No live state was inspected or modified. Reported run/effect identities are historical evidence, not current facts. Wiki search for agent launch lifecycle returned no concepts. Repository instructions and direct boundary code were inspected; history archaeology was intentionally excluded by the planning protocol. Preserve baseline ab82223840fd0a72a04ea5ae67307c255d116fa9 and f0e6965 behavior, copilot-sol selection, isolated worktree and squash preference.

Observed current code:
- `workflow/adapters.ts` requires retry authority before ordinary launch, then ensures/submits a run before requiring `registerHostRetryTarget` to succeed. Both checks can fail a normal launch from a new process; removing only the first is insufficient.
- `agent-host/client.ts` attempts idle restart when a reachable host lacks locally held authority; a busy host correctly refuses. `retry-authority.ts` stores private inherited-descriptor authority and target leases in process-local maps. Cross-process reproductions remain implementation evidence to collect, not proof about every historical incident.
- `runtime/view.ts` offers every failed effect; `reducers/developer-action.ts` checks only failed status before revival. `store.ts` later enforces active/current-step run invariants with explicit consult, debug and cancellation exceptions. Attempt and generation identity need equal scrutiny.
- `kernel.ts:expireRuns` omits failed launch rows. `reducers/repair.ts` additionally expires workflow-wide unclaimed effects; this is broader than attempt-scoped retirement.
- `runtime/recovery.ts` treats every pending run and every running effect as live, without expiry-aware reconciliation. `reducers/repair.ts` already separates developer manual cross-step repair from orchestrator same-step recovery. Existing recovery spec and architecture prose contradict that restored behavior and must be corrected.

## Goals / Non-Goals

**Goals:** Ordinary authenticated multi-process admission without recovery capability; consistent lifecycle fences; explicit safe reconciliation of the reported obsolete launch plus current pending launch state; accurate server-driven status and actions; deterministic repeat-cycle regression coverage.

**Non-Goals:** New runtime, scheduler or launch queue; paid model calls; deployment or live recovery; exporting privileged capabilities; taking over owners; killing hosts; bypassing validators; general corruption repair; schema-version bump (retain STORE_SCHEMA_VERSION=6 and current event conventions); speculative preset/config migrations. The historical unknown-preset error is separate unless a fixture connects it to launch lifecycle. Do not modify the add-agent-scheduling worktree.

## Decisions

### 1. Authoritative lifecycle and invariant ownership

Use existing workflow transaction, outbox, claim tokens, renewal scope, private host control channel and request deduplication. No second orchestration state machine. Before editing, document a compact transition inventory in the implementation tests/docs covering dispatch admission, role/run generation/step/attempt, outbox insertion, claim/renewal, host ensure and submit, acknowledgement/publication, terminal handoff, retry, step entry, repair, repin, preset switch, closure and late completion.

Invariants:
1. Ordinary launch/artifact/prompt work names an existing active run in the current workflow generation, step and attempt, present in activeRunIds, and a legal effect for that step. No missing/expired/superseded reference can be retried or newly claimed.
2. Consult prompts are permitted only by their addressed dialogue record; delegated debug work by its actual debug-request lifecycle; cancelled launches remain cleanup barriers, not ordinary admissions. Stop and teardown retain their intentional cross-step lifetime. Encode these as explicit kind-specific decisions, never a global bypass.
3. Exactly one claim owner may publish; renewal and final publication require its current unexpired token. Lease expiry is not evidence that a remote model turn never started. Failed observation is unknown, not absent.
4. Admission is idempotent by durable run/conversation and deterministic prompt request identity. Acknowledgement means admission, not model execution.
5. Replacement cannot race an admitted/working run or unfenced launch. All terminal outcomes, artifacts, evidence and audit remain immutable history. No recovery implies a human decision.

### 2. Separate ordinary dispatch from privileged recovery

Remove ordinary launch's requirement to acquire retry authority. Use the existing authenticated private control socket and ownership checks for ensure/status/submit. Return a valid normal AgentHandle after successful admission even when optional process-local retry-target registration is unavailable; audit prompt/observe/stop callers so none accidentally requires parked-task retry authority for ordinary operations. A privileged retry target is optional and usable only inside the existing trusted mediator; never persist its capability, return it in a handle, expose it over tools or reconstruct it from configuration.

Explicit parked-task recovery keeps its private capability requirement, conversation checks and busy-host refusal. A new launcher must not force reattachment/restart to satisfy ordinary dispatch, and concurrent explicit recovery cannot disrupt ordinary work. Host single-writer ownership and existing authentication remain unchanged. Reject capability export, automatic takeover and removing the busy-host guard as unsafe alternatives.

Developer-reviewed refinement: managed admission requires the background workflow server. The host independently discovers/authenticates it and re-verifies the exact live claim before ensure and initial submit. The server supplies authoritative paths, run/role/generation and deterministic outbox request identity; caller epochs, URLs or permits cannot authorize work. Unavailable/auth/version failures are bounded infrastructure refusals preserving intent, with no offline fallback or implicit server start. Existing authenticated native control and parked-task recovery retain their separate ownership/capability rules.

### 3. One pure lifecycle eligibility decision

Add a small pure runtime eligibility module returning an eligible operation or a stable bounded reason, based on snapshot, definition/registered behavior, run rows, effect payload and lifecycle intent. Use it for retry actions, compact/full status, tool exposure, transactional retry validation and claim validation. A retry of a failed effect is an explicit new bounded retry budget, not permission to override obsolete identity or replay completed work. Preserve valid non-agent failure retry behavior.

Re-evaluate inside the existing revision-bound transaction; stale requests must leave revision, attention, effect status, retry counters and audit-success records unchanged. Keep strong post-transaction invariants. Use existing typed validation/stale-ownership/infrastructure distinctions, not message matching or generic Effect.retry.

Use the same identity classification to retire obsolete unclaimed pending/retry/failed effects in all attempt/step replacement paths, preset switch, handoff and closure as applicable. Preserve original error details, outcome and audit. Do not broadly expire unrelated cleanup/debug/consult work or actively owned claims. Claimed cancellation uses the existing cancellation/stop barrier until settled. Repin is not a relaunch or an exemption from lifecycle validity.

### 4. Developer-approved supported repair contract

Extend existing recovery preview/execute and operator.repair; do not add a parallel admin endpoint. Add an explicit `reconcile-launch` operation to the existing bounded recovery operation union. It reconciles the current attempt in place when admission already happened, or safely re-drives the same run/effect after verified absence; it does not create a replacement merely because status says pending. A fresh same-step attempt remains `retry-current`/structural repair, available only after fencing proves replacement safe.

Authorization: server-derived developer principal retains existing manual multi-target Repair, including compatible nonterminal cross-step targets and review targets already supported by the restored UI. It never fabricates approval. Home orchestrator may preview/execute only visible workflows durably startedBy orchestrator, only the current agent step, never a human review/system step or another workflow. Workers and caller-supplied actor fields grant no authority. All direct routes/tools/CLI converge on this policy. Pending questions, open debug requests, consult/stop/cleanup barriers and completed current-attempt work remain explicit blockers unless handled by their normal supported lifecycle action.

Preview is read-only and bounded: workflow id, revision, operation, target step/attempt/generation, exact affected record identities and states, claim owner identity (non-secret), lease expiry, host run/conversation/request observation, observed-at/expiry, consequences, retained outcomes/evidence, refusals and supported next action. Preview identity binds these values including lease renewal and host observation/fencing identity, not only running status. Execute requires current revision, matching previewId/operation/target, existing trimmed 1–160 reason and 1–8000 masked instruction limits. Bound observation lifetime by the existing lease/clock policy; expired observation requires a new preview. Secrets, raw prompts, credentials and capability/lease tokens are excluded from diagnostics.

Execution ordering:
1. Perform authorization and structural decoding through the existing guarded recovery read boundary. Recognize only allowlisted obsolete launch/effect-reference defects to project recovery; malformed schema, pin/routing or other corruption remains refused. This boundary must not make unrelated normal commands accept an invalid snapshot.
2. Observe host/admission via the authenticated adapter. For a live unexpired claim, return owner/status/expiry and wait-or-owner-settle guidance, with no mutation or lease theft, even if the run is merely pending. Do not use PID absence alone as ownership proof.
3. For an expired claim, use existing expiry CAS and fencing machinery before any renewed dispatch/publication. A formerly owning runner must fail renewal and completion. Reconcile matching already-admitted host work in place using the same identity/request; do not resubmit a second turn or fabricate a handoff. If absence is proved and old remote admission is fenced, re-drive the same current run through normal outbox claiming. If remote admission is unknown/unavailable, refuse with actionable diagnostic; timeout is never proof of absence.
4. Before any mutating remote operation, transactionally recheck revision, preview identity, current run/attempt, lease and authorization. Accept a reconciliation intent through the existing launch outbox/claim machinery, not a new queue; retire only enumerated obsolete unclaimed effects, preserving errors/history, and bind the current launch to reconciliation-before-admission. Strictly validate the committed state and append bounded acceptance audit. Invalid/stale requests roll back completely and perform no remote fencing. An obsolete active claim blocks; an obsolete expired claim requiring remote cleanup must remain an explicit cancellation/stop barrier until settled, not be silently deleted.
5. After accepted commit, the owned runner fences the window between absence observation and remote admission: reuse/extend existing host admission and cancellation protocol with claim/generation identity so a delayed old claimant cannot start after retirement. Record monotonic admission/fencing identity in existing durable host state using supported storage APIs. Re-observe after fencing, then reconcile in place or admit the same run/request. Never create a replacement until this barrier proves it safe. Do not hold a SQLite transaction across remote I/O. If existing machinery cannot establish this fence without a schema change, stop for design review rather than silently weaken guarantees.
6. Final publication rechecks the accepted intent's current claim, run identity and final structural validity. Audit distinguishes accepted reconciliation from completed admission or refusal; acceptance alone is never reported as a running agent. Restart replays the durable accepted intent idempotently; at most one replacement/admission. Never auto-loop recovery.

Observed-state fixture: obsolete failed/retry launch references retired attempt N, current running launch has pending attempt N+1. Preview diagnoses both. A valid live lease refuses with owner guidance. At fake-clock expiry, fence/reconcile current remote admission, retire obsolete launch, validate and proceed with the current run (or exactly one authorized same-step replacement only if required and proven safe). Repeat multi-agent progression after reconciliation. No SQL surgery, blanket lease clearing or weakened validation.

Implementation refinement: version-1 host run/role fence documents use existing harness commits. An unfinished-stop metadata index contains only accepted, unsettled cancellations and is cleared atomically with `stopped`; startup settles it before native `resume()`. It is not a second workflow queue or a history-sized ownership map. Current reconciliation requeues the same run/effect/request, preserving attempts/history and granting a fresh bounded claim budget; it never creates an attempt or resubmits an admitted initial turn. Preview identity includes a bounded 30-second observation window, matching the default claim lease; execution freshly re-observes and rechecks the transactional source.

### 5. Crash windows and late results

| Window | Required result |
| --- | --- |
| Before outbox commit | No run dispatch; repeat command is CAS-bound. |
| After commit, before claim | Durable pending intent is claimable only while its run remains eligible. |
| After claim, before host admission | Renewal/fencing prevents an expired claimant admitting after replacement. |
| After ensure, before submit | Same conversation and deterministic request resume admission, no duplicate prompt. |
| After submit, before acknowledgement | Observe/deduplicate existing request; never infer no work from pending. |
| After acknowledgement, before effect publication | Same claim publication fence; reconcile existing admission, not a second run. |
| After lease loss/step replacement | Late acknowledgement/completion cannot publish to the new attempt or abort its conversation. |
| During recovery/restart | Preview may stale; durable committed intent resumes once, uncommitted execution creates no replacement. |

### 6. Status and implementation boundaries

Project queued admission, claimed/launching, host-admitted, actual working, launch-failed and recovery-refused separately from authoritative records and observations. Unknown status remains unknown. Expose bounded failure reasons and only server-eligible actions in dashboard/API/orchestrator views; execution-requested is not running. Reuse shared keybind catalogs if controls change and verify footer/help in an isolated TUI. Keep role policy in registered steps, pure decisions plain TS and I/O in Effect boundary adapters per workflow-effect.md. Update recovery docs that still forbid developer cross-step Repair.

## Risks / Trade-offs

- Cross-store host/workflow crash windows → explicit admission fencing and deterministic failure injection, not lease expiry alone.
- Historical evidence may have multiple causes → reproduce capability loss and stale effect failures independently before integration; investigate preset only on a connected reproduction.
- Existing malformed state can block ordinary validation → narrow allowlisted reconciliation read/execute boundary with strict final validation, never a generic validation bypass.
- Missing durable host fence primitive → verify supported storage feasibility early; schema 6 stays fixed unless developer explicitly reviews necessity.
- Stale architecture/wiki guidance → correct repository docs; flag durable wiki gap for the dedicated wiki step, not planner-authored wiki drafts.
- Manual versus orchestrator repair authority drift → shared policy and separate direct-call/UI regression fixtures; preserve multi-target Repair.

## Migration Plan

No live operation or deployment is part of this change. New code accepts existing schema-6 records; existing stuck records remain intact until an authorized user explicitly previews and executes supported recovery. Deliver squash after normal developer plan approval, implementation, focused verification, workflow-owned full-suite verification and developer review. Developer chooses any later rollout/restart/recovery. Rollback must not redeploy an older drainer against newly reconciled active claims; coordinate operational rollback after claims settle, never reset storage. Retain all audit and evidence on rollback.

## Review decisions and remaining validation

- Developer approved section 4, existing version-1 harness document fencing and independent server verification; the server-required path was selected explicitly. Workflow schema remains 6.
- No offline fallback, inherited capability export, automatic takeover, host killing or implicit server start is authorized.
- Platform-only detached-process/socket behavior and compiled-binary execution may need manual validation; document unsupported checks honestly. No permission for live or paid checks is implied.
