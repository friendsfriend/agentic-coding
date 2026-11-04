# Skill-backed tasks: analysis and migration plan

Status: proposal, not an approved migration or implementation.

This analysis was performed directly against the local source and installed pi-durable 1.4.0 declarations/documentation. No worker was launched, no live schedule/session was changed, and no execution experiment or test was run as part of this analysis. API feasibility below is source-verified; restart and integration behavior still requires the proposed tests.

## 1. Recommended outcome

Replace the workflow-specific execution engine with **one generic skill-backed agent task**. Let the orchestrator create tasks dynamically. Let an executing agent request human review through a **blocking, durable `request_review` tool**. A schedule creates exactly the same skill-backed task; it does not start a workflow or invoke the orchestrator to interpret a stored prompt.

There is no predefined review step, workflow-type compiler, role-routing classifier, general-purpose graph DSL, or separate manual workflow executor in the target design.

The remaining product responsibilities are small but real:

- Skill discovery, invocation validation, and reproducible skill resolution.
- Authenticated task admission and durable launch deduplication.
- Execution context: model, repository/workspace, tools, permissions and resource ownership.
- Human review requests bound to immutable artifact snapshots.
- Calendar/interval scheduling, occurrence accounting, and exact-destination reporting.
- Task/history/review UI over native runtime records and application documents.

The simplification is **one execution runtime**, not simply fewer names for the existing runtime.

## 2. What the current implementation actually does

### Workflow execution

`src/workflow/runtime/engine.ts` is a transactional facade over many reducers and helpers. It handles agent handoffs, role consultations, developer actions, repair, launch capability issuance, scheduled workflow reservation, evidence, and definition-specific behavior. `src/workflow/steps/types.ts` exposes role selection, arrival/completion hooks, completion effects, verification scope, and stage-specific evidence contracts.

`src/workflow/blueprints/compiler.ts` still constrains composition to registered logical steps and inserts routing and gates. Its current limits and allowed entry-step catalog are evidence that this is not a generic task substrate. Replacing manifests with a smaller manifest while retaining these hooks would preserve much of the complexity.

### Native execution is already present

`src/agent-host/host.ts` already opens a pi-durable Harness over SQLite, installs extensions/tools, configures models and execution environments, restores stop barriers before `resume()`, and observes runtime failures. The new design does not require inventing an agent runtime.

However, host startup distinguishes orchestrator, standalone session, and managed workflow contexts. Standalone sessions explicitly do not get workflow/environment/stage/debug tools. Moving a skill into a standalone session therefore does **not** automatically preserve its operational capabilities. Capability resolution and context recovery need an explicit migration.

### Scheduling

`src/contracts/scheduling.ts` currently models wake-up, standalone, and workflow targets. Jobs hold large task strings plus original instruction, reason, references, reporting destination, and target-specific execution settings.

`src/server/scheduling/runtime.ts` wires separate adapters for these targets. `service.ts` manages due reconciliation, reservations, admission, receipts, transient launch backoff, destination failure, writable-execution approval, and ambiguous-outcome reconciliation. `src/scheduling/recurrence.ts` supplies calendar/timezone behavior.

`src/agent-host/scheduled-admission.ts` already uses native documents and conversation-scoped request IDs for durable reservation and submission deduplication. This is a useful pattern to preserve, not machinery to replace with an unchecked timer callback.

There is also a concrete layering leak: `src/server/scheduling/session.ts` constructs a **daily-digest-specific** prompt/window for its workflowless-session adapter. A generic scheduled skill should receive trusted occurrence context; digest window semantics belong to the digest skill and its supporting code.

### Reviews and dialogue

`src/tui/data/review.ts` has separate loaders for local code, wiki, and setup diffs and imports workflow-specific review comments/actions. These should converge on an artifact review surface, but their underlying diff/evidence capabilities need not be discarded.

`src/workflow/runtime/clarification.ts` enforces explicit custody, complete answer sets, and authenticated transcript provenance. Native task durability does not replace these application-level authority checks. They must be retained or deliberately replaced with simpler, equally explicit protocols.

### Skills

The installed pi-coding-agent package exports `loadSkills`, `loadSkillsFromDir`, and `formatSkillsForPrompt`. A discovered skill is metadata plus file/base-directory references. It is not a typed executable task or a permission grant.

The inspected host/workflow source does not already provide the proposed skill-invocation abstraction. A small adapter is required. Do not assume pi-durable automatically interprets `SKILL.md` as executable work.

## 3. What pi-durable 1.4.0 provides—and does not

Source basis: installed `README.md`, `dist/types.d.ts`, `dist/harness/types.d.ts`, and scheduler declarations/implementation.

| Requirement | Native support | Application responsibility |
| --- | --- | --- |
| Durable phases/checkpoints | `defineTask`, `runtime.commit`, versioned definitions/migration | Define one skill execution task with a few phases |
| Atomic task/document creation | `Tx.createTask`, `Tx.doc`, conversation commits | Store launch key and task identity together |
| Child agents | Task-owned conversations; idempotent submissions | Configure child context and collect validated result |
| Child dependencies | `waiting` on task IDs, `allSettled` / `failFast` | Decide whether to proceed; these are not arbitrary business DAG edges |
| Cancellation | Owned-work cascade, abort handlers, completing state | Workspace/resource cleanup, stop barriers, external-effect reconciliation |
| Restart recovery | Resume committed work; parked crash loops | Reinstall definitions and restore task execution context before resuming |
| Retry | Native provider/tool behavior and `retryTask` for restart-limit parking | New attempts for terminal failures; explicit safe policy for external effects |
| Durable time wait | `sleepUntil`, `wake`, `onWake` | Timezones, DST, recurrence, late policy, schedule history and host availability |
| Live progress | `taskGraph`, `watchTaskGraph`, `inspect` | History, application metadata, review status, missing-definition display |
| Review decision | Documents, watches, durable tool calls | Authentication, artifact capture, human decision, invalidation |
| Exactly-once external writes | Not provided | Idempotency receipts or manual reconciliation; never blindly replay |
| Cross-process storage ownership | Not provided by SQLite adapter | Existing single-owner host locks/fences |
| Skill execution | Not a native skill runner | Resolve/validate skill, inputs, context and result |

Important corrections to an overly optimistic simplification:

1. A phase interrupted before its next commit can rerun from its beginning. Checkpointing does not make arbitrary I/O exactly once.
2. Tools default to replay-unsafe. Marking a tool replay-safe is an application correctness assertion.
3. The task graph contains live tasks, not full historical execution records or a ready-made workflow dashboard.
4. `retryTask` is for restart-limit-parked tasks, not a generic rerun of an already terminal failure.
5. Native ownership is local to one Harness/storage. Cross-host dispatch and reports still need authenticated, deduplicated bridges.
6. Durable sleeps require a process or external host wake mechanism. They do not wake the operating system.
7. The public task state has waits on tasks and sleeps, but no general external-signal/document-wait state or public arbitrary task-state setter. Do not invent a `signalTask` API in the design.

## 4. Target task model

Conceptual invocation, not a proposed complete wire schema:

```ts
{
  skill: { id: "implement-change", revision: "resolved-content-digest" },
  inputs: { goal: "...", constraints: [], acceptance: [] },
  execution: { repository: "...", workspace: "isolated", profile: "configured-profile-id" },
  destination: { /* exact existing native binding */ }
}
```

Separate three concerns:

- **Inputs** are task data the agent may interpret.
- **Execution policy** comes from authenticated admission and trusted configuration, not skill prose or source content.
- **Occurrence context** is trusted scheduler metadata, not model-supplied input: occurrence ID, nominal due time, timezone and trigger origin.

At admission, resolve and persist the skill content/revision and relevant declared resources, validate parameters, and record the selected execution policy. A resumed task must not silently load a different skill from a moving path. Avoid creating a skill marketplace/version-management subsystem: a trusted directory/catalog plus content digests is enough initially.

Prefer ordinary `SKILL.md` files plus a small optional typed invocation contract. A schema is needed for API/scheduling validation; it should not become a new workflow manifest with embedded routing and lifecycle hooks.

A minimal skill task can have phases such as prepare, execute and finalize. These are native implementation checkpoints, not user-visible workflow steps. Preparation records workspace ownership; execution drives a durable child conversation with a stable submission request ID; finalization records output/report receipts and releases resources after owned work has stopped.

Before implementation, prove the ownership layout for both fresh worktrees and existing persistent sessions. A task-owned child conversation is natural for isolated work. The existing digest session must retain its exact identity and visible report history; do not casually replace it with a new child and call the migration complete. The vertical slice must establish whether that session remains the execution conversation or becomes the exact native reporting destination, including busy/cancel semantics. A string label is not an adequate destination guarantee.

## 5. Agent-triggered human review

### Public behavior

The skill tells the agent when review is useful. The agent calls:

```ts
request_review({
  path: "openspec/changes/example/",
  baseline: "captured-base-reference",
  title: "Review implementation plan",
  explanation: "Please approve or request changes before implementation."
})
```

The tool returns only after a human decision, cancellation, or explicit terminal failure. A normal result distinguishes approved, changes-requested, and rejected, and includes the review ID, snapshot digest and comments. The agent continues within the **same skill/task**, rather than routing to another workflow step.

Rejection and requested changes are structured decisions, not runtime crashes. If changes are requested, the skill can revise the artifact and request a new review. Bound repeated review attempts and let the developer cancel.

### Implementation using existing native primitives

Use a normal pi-durable tool (`pi.tool`) with `replay: "safe"` **only after** its replay protocol is implemented and tested:

1. Resolve the real allowed path and baseline; capture immutable bytes/diff outside the native transaction.
2. Atomically find-or-create the request document keyed by native tool task/call identity. Persist snapshot identity, caller/task ownership, baseline and decision state.
3. Repeated execution finds the same committed request and snapshot. Temporary artifacts from an interrupted capture are disposable; committed evidence is not silently replaced.
4. Publish discoverable request metadata through tool details and application review documents; notifications are secondary to those durable records.
5. Acquire a document watch and check its initial value before waiting. A human response arriving between creation and watch acquisition must not be lost.
6. The authenticated operator endpoint validates request ownership/revision and snapshot, then records one decision. Agent tools do not expose approve/reject.
7. On response, return the recorded decision. On restart, reattach to that request; a response committed before the crash must still be returned.
8. Abort/close must dispose watches and stop waits. Cancellation is not approval; a late decision cannot revive cancelled work.

This uses a **live asynchronous tool invocation waiting on a durable document**, not a native parked external-event task state. The model makes no requests while waiting, but the host retains a watcher/invocation. That is a reasonable initial tradeoff. Test that long waits do not block unrelated work or host shutdown. If scale later requires fully parked external-event waits, consider an upstream primitive then—not a second bespoke scheduler now.

Use sequential tool execution for review requests. Prevent parallel sibling tools from mutating the reviewed workspace while the request waits. An immutable captured snapshot remains necessary because other tasks or developer edits may still change live files.

### What approval means

A review request may show a file, directory diff, or textual report. Normalize it to a bounded artifact snapshot. Include untracked/new/deleted files; handle binaries, rename/mode changes and symlinks explicitly. Report truncation rather than silently presenting an incomplete review. Reject traversal and symlink escapes outside authorized roots.

Approval applies to **that snapshot**, not indefinitely to its path. Subsequent mutation requires a new review before a protected action. Code approval does not grant push/deploy/source-write authority. Non-Git paths need captured before/after content rather than a pretend Git baseline.

Agent-triggered review can mean two distinct policies:

- Optional assistance: the agent decides whether to request it.
- Required authorization: the relevant sensitive operation refuses to proceed without a matching human approval receipt.

Recommendation: keep discretionary review flexible, but preserve existing mandatory approvals during migration. Enforce those at action boundaries, not in a fixed workflow graph. Moving mandatory approval entirely into skill prose would be a deliberate weakening, not an equivalent refactor.

Do not claim tool hooks form a filesystem or network sandbox when unrestricted shell or equivalent tools can bypass them. Preserve current policy limits honestly; restrictive execution requires an enforceable tool/environment boundary.

## 6. Dynamic orchestration without recreating a workflow engine

The orchestrator uses task operations conceptually equivalent to start-skill, inspect/list, await-result and cancel. It can start one skill, inspect the outcome, then create another; it can also start independent skills concurrently. Each admission is persisted with an idempotency key before acknowledgement.

There is **no workflow object at all** in this model: no persisted graph, workflow cursor, prescribed succession, or separate workflow lifecycle. A successor is simply a new skill-backed task created by the orchestrator after it receives and evaluates the previous task's result. An optional `relatedToTaskId` records provenance, not an execution edge. The orchestrator's own native conversation/submissions provide continuity. Its decision to start a successor must use a stable admission key tied to the predecessor result and intended invocation so a restart or duplicate completion delivery cannot create two successors. A completed predecessor does not automatically imply a successor: the orchestrator may finish, ask the developer, or start different work based on the actual result.

Do not require the orchestrator to predeclare a graph. Do not recreate plan/implementation/verification roles as privileged runtime types. An agent may run planning, implementation, testing and repeated review in one skill when that fits.

For multi-task work, store lightweight grouping/provenance metadata and explicit input/result references. Reporting back to the orchestrator must be durable and deduplicated: an in-memory promise or notification is not sufficient. Cross-host report delivery needs an outbox/receipt bridge, but not another business-process reducer.

A task launched asynchronously should not accidentally be owned by the short-lived dispatch tool and cancelled when it returns. Use an intentional native background boundary or independent task conversation and preserve authenticated creator/custody metadata. Explicit cancel must reach the entire task subtree; Home Esc need not cancel unrelated background work.

Bound budget, elapsed time, fan-out and review/retry loops. These are task policies, not routing classifiers.

Removing manual execution means removing the New Workflow/start-type form and the requirement to click Run to drain approved work. Runtime progression happens automatically. It does **not** mean removing human review, cancel, inspect, or an explicit retry of safely retryable work. Schedule Run now uses the same skill admission path, not a second manual executor.

## 7. Scheduled execution

### Shape

A schedule points to a skill invocation plus timing, late/no-overlap policies and an exact destination. Reusable jobs may remain as a small storage concept if useful; they no longer contain separate workflow/standalone execution branches or copied operating instructions.

```text
calendar/interval due
  -> durable occurrence snapshot
  -> same authenticated skill-task admission
  -> native task execution, including request_review if allowed
  -> exact result/report receipt
```

There is no orchestrator/model call merely to translate the schedule into a task.

### Preserve existing behavior

Keep recurrence/timezone/DST calculations, previews, stable mutation request IDs, revisions, late policy, no-overlap, pause/cancel and occurrence history. Keep server-owned host startup without stealing UI focus. Maintain a receipt mapping occurrence ID to exact native task/conversation/submission identity.

Pin the resolved skill revision and inputs for each occurrence before execution. Default to deliberately selected skill revisions for persistent schedules; updating a schedule changes future occurrences, not already admitted ones. If latest-skill selection is later offered, make it explicit and still snapshot each occurrence.

Retain current distinction between pre-admission transient retries and ambiguous post-admission reconciliation. A lost acknowledgement must query the same task, never start another one. Cancellation after admission must cancel native work rather than simply mark the schedule row cancelled.

No-overlap remains occupied through review waits, task completion cleanup and unresolved outcomes. Do not release the slot when the model merely yields. Avoid indefinite catch-up storms; preserve and test existing missed/late occurrence semantics.

For the daily digest, pass trusted nominal due time to the digest skill/helper. The existing exact preceding 24-hour window—including Monday and late execution—is digest policy, not universal schedule policy. Preserve source permissions, coverage receipts, links, provider-specific production selectors and exact existing destination.

Existing wake-up schedules cannot all be silently converted to arbitrary skills. A future explicit `remind`/`recheck` skill can provide the same user behavior and pinned delivery. Migrate each existing target only when its authority and destination mapping is exact; otherwise leave it on the legacy reader or require an explicit migration decision. Do not retain a parallel wake-up executor indefinitely.

Writable scheduled tasks retain their authorization requirements. With agent-triggered review, skills can request additional review during execution; a background task must never fabricate a decision. For the first release, keep read-only scheduling as the default and do not silently broaden existing scheduled permissions.

### Should the scheduler itself move into pi-durable?

Not initially. Native `sleepUntil` can wait for an instant; it is not a calendar/recurrence service. Replacing the mature recurrence and occurrence-accounting layer at the same time as replacing execution adds risk without removing necessary domain logic.

First retain the existing scheduling store/recurrence service as a thin due-occurrence producer with **one new skill-task execution adapter**. After cutover, delete old target adapters. Consider native sleeping schedule-controller tasks later only if they eliminate a demonstrated operational problem. That internal controller would not be another user-visible workflow step.

## 8. Keep / replace / delete map

| Area | Target treatment |
| --- | --- |
| pi-durable host, models, bounded tools, auth | Retain and decouple context from workflow role |
| Host ownership/generation fences, stop barriers | Retain; native storage has no cross-process locking |
| Worktree allocation, environment/stage/browser leases | Reuse as task-owned services; refactor workflow ID assumptions |
| Collection policy, source receipts, telemetry connectors | Retain as skill capabilities/helpers |
| Stage blocks and replay validation | Retain capability semantics; stage workflow routing and workflow evidence presentation can disappear; keep necessary safety/proof receipts distinct from an evidence dashboard |
| Skill-specific planning/OpenSpec/wiki/verification instructions | Move to skills, with supporting deterministic validators where needed |
| Blueprint compiler, built-in graph manifests, classifier routing | Delete after legacy work drains |
| Workflow reducer/kernel/outbox execution state | Replace with native task state; retain only necessary cross-boundary delivery receipts |
| Review variants and workflow-specific approve actions | Replace with generic review documents, snapshots and authenticated decisions |
| Workflow sidebar/dashboard | Replace with topic sidebar entries and task/Git dashboards |
| Jev classifier panel | Remove; Jev remains an explicitly invoked agent tool, not a routing service or dashboard panel |
| Evidence panel, evidence-only report browsing and new workflow evidence manifests | Remove from new execution; results and screenshots use orchestrator chat and ordinary durable attachments |
| Manual start/run workflow UI | Remove; task/review UI replaces operational controls |
| Scheduling recurrence/store/history | Retain initially, simplify payload/admission |
| Wake-up/standalone/workflow scheduling adapters | Migrate to skill admission, then delete |
| Old workflow database/history | Read-only legacy view; no risky rewrite of active records |

Do not delete `src/workflow/` wholesale: it currently also houses configuration, Git/environment helpers, wiki logic, telemetry and capability code that are not intrinsically workflow execution. Extract ownership carefully. Never hand-edit embedded generated source; retire/regenerate it through its normal build path.

## 9. Implementation plan and acceptance gates

### Phase 0 — prove the native integration boundaries

Create a focused local prototype using fake models/tools, isolated storage/config and deterministic clocks. No live credentials or external writes.

Prove task admission deduplication, child conversation ownership, durable tool review wait, decision-before-restart recovery, host shutdown during review, and task cancellation/cleanup. Prove a result can reach the existing named-session shape without identity substitution or focus change. Inventory workflow-ID coupling in operational tools.

Gate: restart and cancellation tests pass; no second task state store, no invented external-signal API, and a documented exact-session execution/reporting choice.

### Phase 1 — minimal skill runner

Introduce a trusted skill resolver, input/result contract and one native task definition. Add authenticated start/inspect/cancel operations with stable launch keys. Store skill snapshot, execution context and provenance before acknowledgement. Restore that context before Harness resume. Keep a plain coding skill as the smallest useful vertical slice.

Gate: one immediate skill runs end-to-end in an isolated worktree; restart never creates a second workspace or submission; missing/corrupt skill/context blocks visibly instead of falling back to broader permissions.

### Phase 2 — generic review tool and UI

Implement immutable diff/report capture, review documents, blocking replay-safe tool, authenticated revision-bound decisions, comments and cancellation. Build one review surface; reuse existing diff rendering rather than three workflow-specific paths. Add required-approval checks only at actions that already require them.

Gate: a skill can plan, request review, revise and request review again without a fixed graph; agents cannot approve; stale or changed snapshots cannot authorize protected actions; waiting consumes no model tokens and unrelated tasks continue.

### Phase 3 — orchestrator cutover

Expose skill discovery and task lifecycle tools. Replace instructions that require workflow types/presets/graphs with skill invocation and appropriate execution-policy selection. Add durable outcome reporting/grouping. Stop new legacy workflow creation once feature parity is established; keep existing workflows running on their pinned engine.

Gate: complete a representative code change and a research task with native task records; orchestration survives restart between dispatch and acknowledgement; duplicate completion delivery cannot start duplicate successors; no workflow instance/graph is created and no manual Run/drain action is needed after a human decision.

### Phase 4 — scheduling cutover

Add skill-backed job payloads and one execution adapter. Reuse recurrence/store/reconciliation. Add guarded preview/apply migration with revisions and old/new identity checks. Test schedule Run now through the same admission operation.

Migrate the existing daily digest only after verifying its current skill behavior and exact destination mapping. Preserve existing job/schedule/session identities wherever the supported migration permits; do not create an unrequested duplicate or reinterpret an already admitted occurrence.

Gate: fake-clock weekday/DST/late/no-overlap tests pass; a lost acknowledgement produces one native task; restart during review retains overlap occupancy; late digest reports the intended nominal window; coverage and source policy remain honest.

### Phase 5 — migrate operational capabilities and remaining skills

Port OpenSpec, wiki, environment setup, verification and hosted-stage procedures to skills. Decouple capability authorization and resource leases from workflow roles. Preserve login handoff, evidence integrity, reviewed block restrictions and approved delivery boundaries. Terminal failures produce a visible result and optional new explicit attempt—not a hidden automatic business retry.

Gate: representative capability-contract tests pass and each previously required authorization has an explicit new enforcement point. No skill obtains capability solely by naming itself or claiming a role.

### Phase 6 — remove the legacy engine and manual execution paths

After active workflows drain, remove old start/type/blueprint APIs and UI, classifier/routing code, obsolete reducers, workflow-only effect delivery and old scheduling adapters. Retain read-only historical access. Update documentation, tool discovery, generated registries and tests. Remove temporary cutover flags once the old writer is retired.

Gate: no new execution path references the legacy engine; only history readers/explicit legacy draining do. Native task state is authoritative. Full lint and type-check have zero diagnostics, and retained/replacement tests establish the same safety contracts.

## 10. Required test matrix

- Admission: duplicate key, changed payload with same key, response lost before/after native commit, stale creator/host generation.
- Recovery: every phase boundary, child submission admitted before crash, missing definition, missing context, corrupt skill snapshot, restart-limit parking, actual terminal failure versus parked retry.
- Review: decision before watch acquisition, before crash, after cancellation, duplicate/conflicting/stale decision, forged agent answer, path traversal, symlink escape, new/deleted/binary/truncated files, parallel writes and stale approval.
- Cancellation: Home interruption versus intentional background task cancel; nested tools/children; stop barrier; held app/browser/worktree cleanup; resource wait deadlocks.
- Scheduling: timezone/DST, weekdays, nominal late window, overlap during review, paused/cancelled schedule, post-admission cancel, occurrence deduplication, deleted/moved/foreign destination, no UI focus stealing, no catch-up storm.
- Policy: skill/input/source text cannot grant permissions; read-only digest remains read-only; existing mandatory approval and writable scheduling restrictions persist.
- Presentation: live graph versus terminal history, blocked/missing-definition visibility, pending review discovery after restart, source completeness versus mere task completion.
- Migration: active legacy runs untouched, in-flight occurrences not reinterpreted, IDs and revisions preserved, legacy history readable, rollback does not double-execute.

Reuse existing contract scenarios in `test/scheduling-*.test.ts`, `test/agent-host-ownership.test.ts`, `test/agent-host-session-recovery.test.ts`, `test/agent-host-failure-recovery.test.ts`, and review tests. Replace assertions about old internal state machines with behavior assertions; do not delete failing safeguards as obsolete implementation detail.

## 11. Rollout and unresolved decisions

Implementation can use a temporary admission feature switch, but each task/occurrence must have exactly one authoritative backend selected at admission. Rollback redirects **new** work only. Never feed an admitted native task into the legacy executor to recover a missing result. Preserve legacy state without schema downgrade or direct storage surgery.

Decisions recommended for approval before implementation:

1. One skill task plus tool-triggered human review; no fixed review steps or new graph DSL.
2. Retain mandatory approvals at protected action boundaries; discretionary reviews remain agent-triggered.
3. Keep schedule recurrence/accounting for the first cut; replace only execution with skill admission.
4. Pin skill content per task/occurrence; scheduled skill changes require an explicit update.
5. Drain existing workflows rather than converting their live state.
6. Keep current delivery/permission limits; no implicit push, deployment, source-write or credential authority.

The exact persistent-session ownership/reporting integration and long-lived review-tool behavior are source-supported designs that must be resolved by Phase 0, not asserted as already proven.

## 12. Topic dashboard and chat-first results

### Product direction

Topics replace workflow entries in the sidebar. Every task admission requires an explicit topic selected by the orchestrator. Each topic has a dashboard showing its task list/status and Git overview. There is no classifier panel or evidence panel. All substantive task results go to the orchestrator chat; human reviews retain their dedicated review interface. Screenshots appear inline in the Markdown message that explains them.

A topic is an organizational label with durable identity, not a workflow in disguise. It has no graph, transition table, execution cursor, prescribed steps or completion gate. An orchestrator can add successor tasks or unrelated parallel tasks to an existing topic without changing an execution definition.

### Topic and task data

Use a small native document/index for topics with stable ID, display name and authenticated owner/scope. Topic titles are mutable; task references use the stable ID. A task admission carries `topicId` explicitly. A start operation can resolve/create the named topic atomically with the admission reference so failed starts do not leave misleading running entries. Do not infer the topic later from task prose, repository name or a classifier.

Successor tasks normally reuse the predecessor's topic, but the orchestrator still states it in the invocation. Schedules must also declare a topic for their skill invocation; this avoids requiring a live orchestrator to classify each occurrence. A topic can span multiple repositories/worktrees, and a repository can appear in multiple topics. Topic membership grants no permissions and confers no task ownership rights.

Tasks, reviews and result messages carry topic/task references for traceability. The topic view is derived from these records; it does not duplicate native task execution state. Background task completion must not mark the topic permanently complete: an idle topic can receive more work later.

### Sidebar and dashboard

Conceptual layout:

```text
Topics
  Digest improvements      running · 1
  Task simplification      idle
  Customer case            idle · review

Task simplification
  Tasks
    Inspect native APIs       idle · completed
    Implement skill runner    running
    Review proposed UI        idle · awaiting review

  Git
    repository / worktree / branch
    staged · modified · untracked · conflicts
    ahead / behind (from existing local refs)
```

Keep the requested running/idle distinction prominent, but do not erase meaning: an idle task can be awaiting review, awaiting input, completed, failed or cancelled. Show the detail as a subtitle/badge derived from native state and review documents. A long-lived review tool can be technically running in pi-durable while the agent is idle; project user-facing activity rather than copying the raw runtime state label. Failed/cancelled work must remain discoverable, not look like success.

The topic activity indicator is derived from its tasks. A pending review gets an attention badge and opens the dedicated review surface. The dashboard can link to the relevant orchestrator message/task transcript, but does not become a second result-report repository.

Git overview is grouped by actual repository/worktree/branch, not aggregated into one fictitious topic branch. Reuse existing Git diff/status readers after removing their workflow-ID dependency. Show staged/unstaged/untracked/deleted/conflicted paths and local ahead/behind data; do not fetch, switch branches, stage or mutate anything to render the dashboard. Debounce refreshes, handle unavailable/deleted worktrees explicitly, and distinguish zero changes from status-read failure. Read permissions remain scoped to registered task workspaces.

### Chat is the result surface

Task completion yields a structured result and durable completion delivery to the orchestrator. The orchestrator posts the useful explanation, findings, links, tests and screenshots in chat, tied to topic/task IDs. Errors and partial results also reach chat. Review requests and decisions use the review UI; the orchestrator can mention their outcome but cannot replace the human decision.

Do not rely on an ephemeral completion notification. Deduplicated delivery and chat publication receipts must survive restart so results are neither silently lost nor repeatedly posted. For an unattended scheduled task, its exact configured chat destination remains authoritative; the scheduler must not redirect reports into Home or another topic conversation. Topic membership is separate from report destination.

Remove evidence panels, evidence tabs, separate evidence-report pages and the requirement for agents to create evidence manifests or markdown reports merely to communicate results. Keep only the actual attachments needed to render chat/review content and any narrowly necessary operational safety/proof receipts. Those receipts are not a replacement evidence dashboard. Existing evidence remains available through read-only legacy history until an explicit retention/migration decision; removal of the UI is not permission to delete old files.

### Embedded screenshots

Use ordinary Markdown image syntax referencing an authenticated durable attachment, conceptually `![Description](attachment-reference)`. Keep the transport/reference syntax an implementation detail until the existing attachment APIs are audited. Do not expose arbitrary host paths or put large base64 images in chat history. Attachments must outlive temporary browser files and host restart.

The relevant explanation and image should render together in the orchestrator message—not as an evidence ID, detached panel, or external-only link. Preserve alt text/captions and sensible bounded sizing. Support image loading during streaming, resizing, scroll position, reopening history and missing/corrupt attachment fallbacks. Validate actual media type and dimensions; do not automatically fetch arbitrary remote Markdown URLs or arbitrary local files from untrusted source output.

The inspected shared renderer, `packages/ui/src/components/MarkdownViewer.tsx`, delegates to OpenTUI Markdown; `markdownBlocks.ts` splits tokenized text for streaming and review anchoring. Neither inspected file implements an authenticated chat-attachment image renderer. Inline screenshot support therefore needs an explicit rendering/resolution path and a terminal-capability check, not just changing the agent prompt to emit `![](...)`. Image-capable terminals should render inline; unsupported terminals should retain alt text and an explicit open action without silently claiming to display the image.

### Concrete UI migration work

Current integration points include:

- `src/tui/otel/app/App.tsx`: sidebar overviews are loaded from workflows; classifier status and workflow launch navigation are integrated here.
- `src/tui/otel/app/sidebar-model.ts` and `components/WorkspaceSidebar.tsx`: replace workflow projections/routes with topic projections/routes.
- `src/tui/dash/App.tsx`: directly renders `ClassifierPanel` and `EvidencePanel`; remove these from the new topic dashboard rather than merely hiding empty panels.
- `src/tui/dash/classifier-status.ts`: remove startup/polling used solely by the panel; preserve Jev invocation as a tool if still needed.
- `src/tui/data/review.ts` and existing Git readers: extract topic/task-scoped Git and review data without a legacy workflow engine dependency.
- Shared Markdown components and `src/tui/dash/ui/session-markdown-cache.ts`: integrate image blocks without breaking streaming/caching, text selection or review line anchoring.

Add a topic/chat UI workstream to Phases 1–3, before making new native tasks the default:

1. Require topic identity at task/scheduled-skill admission; add topic index/read API and sidebar entries.
2. Implement task list/activity projection and per-worktree Git overview.
3. Implement durable chat result/attachment delivery and inline Markdown screenshots.
4. Connect review attention to the dedicated review surface.
5. Remove classifier/evidence panels and manual workflow launch from the new navigation; keep legacy history explicitly separated during draining.

Acceptance tests: missing/foreign topic rejected; duplicate admission does not duplicate topic/task; topic/task visibility survives restart; successor grouping is explicit; running versus review-idle is accurate; failed work is visible; multi-worktree Git status is read-only and honest on failure; Jev panel is absent with no background classifier polling; results appear once in the intended chat; review decisions stay human-only; screenshots render inline with alt text, resize/reopen correctly, and cannot read arbitrary files or trigger arbitrary network fetches. Update shared keybind catalogs and verify footer/help behavior when removing or changing navigation.

## 13. Profiles replace presets entirely

Remove agent presets, preset pools, workflow-stage/role mappings, preset-selection gates and preset-specific start/switch APIs and settings UI from the new execution path. Preserve configured model profiles as the sole agent/model configuration choice. A profile is not a workflow recipe.

Expose **all configured profiles** to the orchestrator with their resolved model/provider, thinking settings, description and availability diagnostics. The orchestrator freely selects a profile per task according to the work; do not constrain it to role-specific pools or ask for developer preset approval on every launch. The previous `copilot-sol` preset preference does not constrain the new design. Topic membership does not impose a profile, and successor tasks can use different profiles.

Task admission requires the chosen profile reference and records its resolved execution configuration for reproducibility. Profile selection does not confer tool, repository, credential or write permissions. A configured but unavailable profile remains visible with an honest diagnostic; do not silently substitute another model. The orchestrator can choose another available profile intentionally. In-flight task settings should not change silently when the profile definition is edited.

Scheduled skill invocations also select a profile explicitly at creation/update, because no orchestrator needs to run when the timer fires. Preserve the selected configuration for each admitted occurrence; do not make a scheduling tick perform model-based profile selection. Retain the current profile configuration source rather than inventing a replacement configuration system.

Implementation inventory must trace preset dependencies through configuration contracts, profile resolution, prompts, launch/recovery tools, settings editors and scheduling targets. New APIs and discovery should expose profiles, never require a preset or derive one. Legacy active runs may keep reading their pinned preset configuration while draining, but no new task should depend on it. Translate existing schedules only through guarded migration; ambiguous legacy preset-to-profile mappings require an explicit choice rather than a guessed default.

Acceptance: every configured profile is discoverable; the orchestrator can start two tasks in the same topic using different profiles without preset confirmation; invalid/unavailable selections fail clearly; profile selection cannot broaden permissions; chosen configuration survives restart; no new execution or UI path exposes presets, pools or role/model classifiers.

## 14. Clean rebuild on an isolated branch

The implementation should be a clean rebuild, not an in-place refactor. Use a dedicated branch and isolated worktree so unrelated main-checkout changes and active legacy development remain untouched. Create a new application/package folder that starts empty. Its exact path and package identity must be established before implementation; do not silently repurpose the existing package directory.

This decision supersedes any earlier suggestion to implement the new runtime inside existing workflow modules or incrementally adapt the old dashboard in place. The phases above describe capabilities and acceptance gates, not a requirement to keep the old source structure. Build them in the new application. The existing app remains independently runnable while the replacement is developed.

### Construction rules

1. Start with only the minimum package/build/test scaffolding needed to boot the new app. No copied source tree, old workflow database bootstrap, generated registry or legacy package dependency.
2. Implement native task admission, skills, profiles and topic/chat navigation first. Add capabilities only when a working feature needs them.
3. For each existing helper or service, identify the concrete new caller and required behavior before moving or adapting it. Port the smallest cohesive module with its relevant behavioral tests; remove workflow/preset/evidence-presentation assumptions at that boundary.
4. Do not copy entire directories and delete unused files later. Do not import the old workflow engine indirectly through a convenient configuration, Git or UI barrel. Audit transitive dependencies.
5. Do not create a permanent compatibility facade that gives new names to legacy workflows. Temporary compatibility belongs only at explicit live-data/cutover boundaries.
6. Reuse an existing library/package only after its dependency surface is shown to be architecture-neutral and actually required. The new app must build and run without the legacy application package. Shared code must not become a back door to old execution logic.
7. Keep credentials, model profiles and supported external configuration as deliberate integrations. Do not copy user runtime databases, session state, secrets or generated artifacts into the new source folder.
8. Remove or relocate old source only at final cutover, after active legacy work drains and necessary history/configuration compatibility is verified. During parallel development, a targeted copy/adaptation may be needed so the old app stays runnable; it must not become an unexplained permanent duplicate.

Maintain a short port ledger: capability, new caller, source module, transitive dependencies, retained tests, and why reuse is smaller/safer than replacement. This is a development aid, not a new runtime subsystem.

### Build order in the empty application

- Minimal host, native conversation/chat, configured profile discovery.
- Topic records/sidebar and one skill-backed agent task with restart/cancel behavior.
- Durable task completion delivery and orchestrator-driven successor admission.
- Topic task/activity and read-only Git overview.
- Tool-triggered human review and chat attachments/inline screenshots.
- Thin calendar/occurrence scheduler invoking the same task admission.
- Required operational tools, brought over individually when a skill actually needs them.
- Guarded live-data/configuration migration, final acceptance and removal of the old application.

Acceptance includes a dependency audit: no legacy workflow engine, graph compiler, classifier routing, agent presets, evidence dashboard or manual workflow executor in the new application's dependency graph. A clean checkout must install, type-check, test and boot the new application independently. Keep the existing app and its tests separate during the transition; do not use a whole-repository rewrite to hide unrelated baseline issues.

## 15. Bottom line

**Topics organize; skills execute; profiles configure agents; tools request review; schedules invoke skills; the orchestrator communicates results in chat; pi-durable owns execution.** There is no workflow instance, fixed graph, classifier panel or evidence dashboard in the target design. Keep domain scheduling and trusted boundaries, but remove business-process state machines. Start with one restart-tested vertical slice, then retire the old writer aggressively after existing work drains. Do not bolt the replacement onto the blueprint compiler or keep two permanent execution engines.
