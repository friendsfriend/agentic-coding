## Context

The concrete failure is an attention-required implementation worker, already blocked, with no pending question and no available actions. Paused-only resume cannot fix it, and the home orchestrator is not a completed workflow agent addressable by agent_ask. Do not repair the live fixture during development.

Scoped inspection found that server operations already expose previewWorkflowRepair and revision-checked repairWorkflow, dispatching operator.repair and requesting execution. The repair reducer validates target membership/non-system/non-terminal status, retires runs and open effects, cancels debug requests and enters a fresh attempt. Its actor is currently operator and its bounded reason is 160 characters. previewRepair currently lists all compatible steps, active run IDs and retained evidence: it is not an authorization or human-gate policy. The orchestrator policy denies the repair route. Its action tools carry revisions but cannot supply durable retry instructions. Reusing these mechanics requires additional authorization and input semantics, not just prompt edits.

One cohesive change covers the API, engine contract and host tools; splitting these would leave an unusable or unsafe intermediate capability. No follow-up implementation proposals are needed.

## Goals / Non-Goals

**Goals:** Explicit bounded recovery for blocked/failed non-review work and existing engine-supported structural integrity repair, useful previews, durable corrective context, consistent server authorization, preserved audit/history and human reviews.

**Non-Goals:** Automatic repair loops; human approval/rejection; arbitrary graph jumps; new dependencies or speculative migrations; worker repair permissions; generic HTTP-client privilege widening; config/credential edits, deletion or destructive reset; live workflow tests; changes to other worktrees or reliance on unmerged scheduling/MCP work. Preserve copilot-sol, normal OpenSpec reviews and eventual reviewed squash delivery.

## Decisions

### Dedicated inspect and execute tools over existing recovery mechanics

Add workflow_recovery_preview and workflow_recover tools rather than overloading answer-question, resume or agent_ask. Status in compact and full forms exposes recovery eligibility separately from legacy availableActions, current revision, reasons for refusal and required inputs. A blocked worker with no question must advertise a same-step retry. Preserve sinceRevision compact polling behavior.

Preview accepts workflow identity and current revision and returns one current-agent-step target: retry-current for a terminal blocked/failed attempt, or structural-repair for missing/non-active current run references or an absent current attempt. It refuses incompatible schema/pin/routing defects, completed current-attempt work, live runs, open debug requests, leased effects, pending questions and pending lifecycle work. It is not a general corrupt-store repair. Reuse previewWorkflowRepair and extend its projection with source/target, affected run/task/effect IDs, retirement/cancellation, retained evidence, context delivery and review consequences. Do not silently truncate affected objects without counts/truncation indicators. Read-only inspection must not request execution. Return a revision-bound preview identity/digest so execution can prove the selected operation was inspected; this is not a separate durable state machine or approval.

Execution requires identity, expected revision, preview identity, operation, target, nonempty trimmed reason (1–160 characters) and recovery instruction (1–8,000 characters, bounded after trimming). Reject oversized input rather than silently truncating worker instructions. Preview does not need the instruction itself; execution binds it to the selected operation and audits it. Recompute eligibility inside the dispatch transaction and reject changed revision/preview/target. Add typed wire schemas and operation contracts; server-derived principal must never be accepted from request JSON. Extend the existing repair route or route adapter to carry the same guards, not an unguarded alternate API. The new read-only preview route and existing repair route are the only added orchestrator route permissions.

### Server-derived authority and shared eligibility

The home orchestrator can recover only workflows durably startedBy orchestrator and addressable through its existing visible workflow target catalog. Visibility alone is not mutation authority: other visible workflows remain inspectable but recovery is refused. Resolve repository/store identity canonically; reject hidden, unknown or mismatched targets without opening arbitrary stores. Existing developer repair access remains, worker capabilities gain nothing, and unauthenticated/ordinary unauthorized clients cannot acquire repair access. Apply this authority to recovery endpoints, not just tool-side checks. Reuse the routed-question ownership predicate where applicable rather than inventing a conflicting ownership identity.

Use a shared pure eligibility projection for preview/status and execution validation. Put review/arrival/artifact rules in registered step behavior, consumed by the engine; do not extend the policy's existing hard-coded review table into a second graph or role engine. Structural repair includes only targets the existing engine can actually enter safely. Unsupported/unknown targets and incompatible integrity defects return bounded diagnostics with no mutation. Do not promise universal corrupt-store repair.

### Gates cannot be bypassed by target selection

Developer decision `current-step-only` (question group `4b9464e6-43e2-4afe-8456-5ddbd735f9dc`) deliberately narrows the initial release: reject **every cross-step repair**, including legacy direct operator commands, and refuse recovery at every non-agent step. Human review transitions are graph actions; classifier `gateDecisions` are not artifact-bound human approvals. The engine has no supported approved-artifact validity ledger, so this change does not invent one or claim changed artifacts inherit an earlier decision. No return to an earlier producer or jump to/over a review is supported. Preserve evidence and arrival context/mode on same-step retry; all later reviews remain normal graph transitions. At a review wait advertise refusal, not technical re-entry. This conservative policy applies to authenticated operators as well as orchestrators; legacy empty/omitted operator reasons still decode, but do not bypass eligibility. Tests formerly using arbitrary repair as fixture setup now seed isolated test stores or complete a synthetic validation effect, never add a production bypass.

### Durable instruction and audit, single execution path

For retry-current use the existing supported blocked-run retry/re-entry mechanism if its invariants match; otherwise extend operator.repair for guarded same-step re-entry. Do not introduce a parallel lifecycle. Persist a bounded recovery record associated with the fresh attempt in the same transaction as dispatch. It carries server-derived orchestrator actor, source and target, prior run IDs, reason, supplied instruction, expected revision, affected task/effect IDs and preserved/invalidated review consequences. Preserve prior failures, outcomes, evidence and events; retirement must not rewrite a blocked/failed outcome into success. Apply standard secret masking to audit/context persistence and avoid echoing instruction text into ordinary logs or compact status.

Render the persisted instruction into the replacement worker's actual assignment through the existing context/assignment pipeline. It remains available after process restart and is scoped to the intended attempt/roles, not indefinitely inherited by unrelated later runs. It is not a prompt queued for the terminal worker and not an answer to a nonexistent question. Keep only the bounded record/pointer necessary in snapshots; use existing typed event/context extension points where possible without schema migration.

Initially refuse recovery while any relevant worker/debug run is live or launch/prompt effect is actively leased. Do not expire a lease and start concurrent work. Expose pause/stop/cleanup blockers rather than introducing an implicit cancel-and-replace protocol. Pending non-leased effects for retired attempts are expired through existing cleanup logic. Validate launch/claim and publication fences against repair revision/attempt so a dispatch racing with a claim cannot launch or publish the retired attempt. Transactional revision checking plus existing outbox idempotency keys ensures repeated/concurrent execution requests yield at most one replacement; one accepted recovery requests normal execution after commit. No automatic retry of semantic failures and no repair loops.

### Precise guidance and isolated validation

Update tool schemas/descriptions, home orchestrator guidance and workflow recovery documentation together. Explain ownership, required inspection, bounded reasons/context, limitations and forwarding of new scope/permissions/architecture questions. Operational API references from agreed task/design are allowed; recovery is not authority for native file-edit workarounds. Preserve own-question answer/forward, pause/resume, retry-effect and switch-preset semantics.

Use deterministic local fixtures and fake host/model adapters. Every probe/test process uses temporary HOME, AGENTIC_CODING_CONFIG_DIR, PI_CODING_AGENT_DIR, HERDR_WIKI_DIR and stores before importing production modules. No user stores, live workflows, real model/MCP calls, application starts/restarts, machine configuration or credentials. Focused server/host/runtime tests plus package lint/type-check are worker gates; complete configured suite belongs to the workflow test-verifier.

## Risks / Trade-offs

- Broad existing repair target list → filter by actual step/gate/evidence invariants and test skip-ahead explicitly.
- Lease race can survive a snapshot-only active-run check → validate under the transaction and fence claim/publication; prefer refusal over force cancellation.
- Actor/context schemas cross several modules → typed backward-compatible additions with restart tests and no hand-edited generated bundle.
- Related active host/server changes → keep patches scoped to local base, integrate only through normal review, never touch other worktrees.
- Conservative ownership excludes developer-started workflows → intentional initial boundary; future delegated authority needs explicit human approval, not this feature.
- Wiki search returned no durable recovery concept → dedicated documentation step should update/create reviewed knowledge as appropriate; planner writes no wiki drafts.

## Migration Plan

No planned storage migration or dependency upgrade. Add backward-compatible optional recovery metadata to existing persisted records, defaults for old events and strict new request validation. Regenerate embedded workflow assets with bun run build only if affected guidance is embedded. Roll back by removing orchestrator recovery route permissions/tools first; persisted audit records remain readable. Never erase audit data or repair live workflows as rollout verification.

## Open Questions

Implementation edits were explicitly authorized by developer question group `9c31201e-f93d-472a-87ae-cf804aa9fdc6` (`implementation-edits`). The current-step-only scope decision above supersedes the initial broader target/approval-validity plan. Exact visible target plus durable `startedBy: orchestrator` is required; ordinary operator capability remains supported within the same engine safety guards. If a necessary storage migration or a broader cancel-and-replace protocol is discovered, stop and ask the developer rather than widening this plan.
