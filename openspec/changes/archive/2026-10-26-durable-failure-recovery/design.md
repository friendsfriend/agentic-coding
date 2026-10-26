## Context

The durable host is a long-lived `Harness` owner. It already streams conversation `viewState` (`pi.live` / `pi.inbox`) over a private Unix-socket protocol, derives a coarse runtime status from that state, emits content-free runtime telemetry, and renders live compaction activity in the dashboard session view and Agents panel. `docs/dependency-upgrade.md` records the pinned pi-durable 1.4.0 upgrade, native crash-loop parking after five consecutive restarts without a checkpoint, and its `blocked: restart_limit` / retry guidance. The implementation binds to pi-durable 1.4.0's typed `ReportInfo`, inspects task state through `Harness.inspect(BACKGROUND_CONTEXT)`, and uses the native `Harness.retryTask(taskId, BACKGROUND_CONTEXT)` operation.

The host must preserve the distinction between runtime task state and the workflow engine's lifecycle. A parked durable task is not a workflow gate, developer question, successful completion, nor a permission to replay external effects automatically.

## Goals / Non-Goals

**Goals:**
- Capture bounded, structured Harness reports in host diagnostics and existing runtime-event delivery, with event kinds and failure domains distinguishable.
- Project durable parked/faulted state and retained compaction failure into agent status/session views.
- Provide explicit, user-initiated retry for a specific eligible parked task using pi-durable's `Harness.retryTask(id)`.
- Validate host/run/conversation/task ownership and current workflow/task state; handle stale and duplicate requests without duplicate task admission.
- Preserve native restart limits, keep workflow run state authoritative, and test behavior with isolated temporary storage and environment.

**Non-Goals:**
- Disabling crash-loop protection, setting `restartLimit` to infinity, automatic retries, or generic retry of arbitrary task failures.
- A blanket exactly-once guarantee for tools or other external side effects.
- Telemetry rollout, model-compaction policy redesign, local Pi/MCP bridging, or broad UI redesign.

## Decisions

1. **Treat Harness reports as diagnostic observations, not workflow transitions.** Register `onReport(error, info)` at Harness construction. Normalize only the typed `ReportInfo` discriminants and allow-listed fields into bounded runtime events and host logs; distinguish task fault/park/error, task parking, and host/session/extension failures. Preserve `blocked: restart_limit` as the upstream parked reason. Do not transform a report into a question, gate, run handoff, or workflow completion. Use a best-effort, non-recursive report boundary that catches failures from sanitizing, logging, telemetry emission, and optional observers.

   Alternatives considered: changing workflow lifecycle from the callback would let an observational runtime failure falsely complete or block a run; forwarding the raw callback object would risk prompt/tool-data leakage and couple internal layers to an unstable upstream envelope.

2. **Keep runtime status separate from workflow status.** Extend the host's runtime status/view with a distinct parked/faulted representation and actionable task identity, while deriving workflow completion/terminal state only from the existing engine records. Maintain the current interpretation of ordinary queued/working sessions and developer-question blocking. A task-faulted report alone does not claim completion or silently retry.

   Alternatives considered: mapping every runtime error to `blocked` would conflate crash-loop parking with normal developer questions and workflow gates; reporting `done` when a turn stops would be incorrect for a task that can explicitly resume.

3. **Retry only through an explicitly authorized, task-specific control action.** Add a versioned private host request/client operation and an explicitly invoked session-view command/action that names both the parked task id and the displayed report generation. The dashboard reaches it through the operator-authenticated server boundary; the server's in-memory mediator supplies a per-host capability created at launch and delivered only over an inherited pipe. Before calling `Harness.retryTask(taskId, BACKGROUND_CONTEXT)`, require a live tracked run record, ownership of the conversation/task by that run, the current active report generation, a current `task_parked` state with upstream reason `restart_limit`, and an active/nonterminal workflow context that is not awaiting a developer review/gate. Serialize retry decisions by conversation, re-read state inside the serialized section, and durably mark the selected episode accepted before the native call so duplicate or post-crash requests fail closed. Return structured outcomes for retried, already resumed/in progress, stale, and refused/unknown ownership; identify the task and warn that the native retry can repeat external effects. Never infer success from a client-supplied id. Retry only the requested parked task, never all tasks for the conversation.

   Alternatives considered: automatically retrying on host reopen undermines the crash-loop guard and may replay side effects; retrying by run id alone lacks task specificity and cannot safely reject a stale or cross-conversation request.

4. **Use upstream live docs where they retain the failure.** Extend the bounded host status/watch projection to include pi-durable's retained `pi.live.compactionFailure` and the lifecycle semantics where a later successful compaction clears it. Render a bounded one-line message and task identity in the agent session and a compact status/badge in the Agents view. Keep successful compaction and failed compaction distinct. Harness reports have no equivalent retained live field, so persist one small synthetic failure document per conversation to preserve their visibility across late joins and host reopen; do not duplicate the upstream compaction value.

   Alternatives considered: transcript-only notices disappear for late-joining views; a second host-owned state store can become stale relative to upstream's retained live value.

5. **Keep replay safety explicit.** Leave native crash-loop limits unchanged and document that `retryTask` replays the selected durable task under pi-durable's replay semantics. The user confirms intent; the UI explains that a prior attempt may have produced external effects and this action does not guarantee exactly-once behavior. Do not add a global replay policy or automatic retry loop.

## Risks / Trade-offs

- [Upstream 1.4.0 report/task fields may differ from assumptions] → Read the exact public Harness types and changelog during implementation, adapt through a typed allow-list, and cover real Harness behavior with deterministic tests; do not cast and forward the complete info object.
- [A retry after an uncertain tool outcome can repeat side effects] → Require an explicit user action, show task identity and restart-limit reason, document the limitation, revalidate eligibility at execution time, and never promise exactly-once semantics.
- [Runtime and workflow state can temporarily disagree] → Present them as separate statuses, reconcile against the authoritative run record before recovery, and never update workflow completion from a runtime report.
- [Diagnostic callbacks can fail or contain sensitive values] → Bound and redact error summaries, omit prompts/arguments/results, catch callback failures at the boundary, and avoid invoking the same report path while recording a report failure.
- [Protocol additions can meet older hosts/clients] → Follow the existing versioned private protocol's fail-closed behavior and test unknown/stale requests; keep old status consumers tolerant of additive optional fields where compatible.

## Migration Plan

No storage migration is intended. Add the diagnostic callback and additive host protocol/status fields, then wire the explicit action and projections. Preserve existing durable task records and their native restart limit. Rollback is code rollback; a task already retried remains governed by pi-durable's durable state and cannot be undone by rolling back the UI.

## Resolved Implementation Questions

- The pinned 1.4.0 callback is typed as `onReport(error, info: ReportInfo)`; the host uses that discriminated union rather than forwarding raw callback objects.
- The retained report binds one run, conversation, task, and generation; retry validates the targeted `Harness.getTask(id, BACKGROUND_CONTEXT)` state (`blocked` with reason `restart_limit`). A single `Harness.inspect(BACKGROUND_CONTEXT)` scan is used only when restoring a missing report on host reopen.
- The narrowest existing action surface is the session slash command `/retry-task <id>`, with the displayed report generation carried privately, a visible external-effects replay warning, an operator-authenticated mediator, and no new global keybind.
