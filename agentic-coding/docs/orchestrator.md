# Home Orchestrator

Home → **Orchestrator** opens a chat with one persistent `pi-durable` agent
that discovers projects, presets and workflows, starts workflows, and manages
them. Plan approval, developer review, findings review and wiki review stay
with the developer; so do developer questions from workflow agents.

## Pieces

| Piece | Path | Owns |
| --- | --- | --- |
| Page | `src/tui/orchestrator/OrchestratorView.tsx` | The `orchestrator` route body: the shared `AgentSessionView` transcript, the `orchestrator.view` keymap field (`session` / `picker`), and `/new`. |
| Host bootstrap | `src/tui/orchestrator/session.ts` | One host under `<config root>/orchestrator/agent-host/` started with `agent host --orchestrator`, the active session name (`session.json`), the run env with the orchestrator capability, and the configured model. |
| Tools + prompt | `src/agent-host/orchestrator.ts` | `list_projects`, `list_workflow_types`, `list_steps`, `list_agent_config`, `list_branches`, `list_workflows`, `workflow_status`, `validate_blueprint`, `start_workflow` (built-in type or blueprint, plus the `app` an `env-setup` workflow drafts for), `workflow_action`, `drain_workflow`, and the orchestrator system prompt. |
| Capability | `src/server/auth.ts` `orchestratorTokenFor` | HMAC of the instance token. The server authenticates it as the `orchestrator` principal. |
| Policy | `src/server/orchestrator-policy.ts` | Route allowlist, action allowlist, human-review step set. Enforced in `src/server/app.ts` before any operation runs. |
| Model setting | `[agents.orchestrator] { model, thinking, monitor, limits }` | Settings → Agent Presets → Orchestrator session (`set-orchestrator` mutation) edits `model`/`thinking`/`monitor`; `limits` is file-only and shown read-only. `model`/`thinking` apply every time the page opens; `/model` and `/thinking` change only the live session. `monitor` (default `wake`) is read when the shell starts its workflow monitor. |
| Session commands | `src/tui/dash/ui/AgentSessionView.tsx` | `/model`, `/thinking`, `/compact [instructions]`, `/abort`, `/hide`, plus the page's own `/new`. |

## Session commands

Typing one of these exact messages in a live agent session performs the named
action instead of sending a prompt; they are listed in the prompt's autocomplete
and described by `?` help. The dashboard's agent session view and this page both
render the shared `AgentSessionView`, so the same commands reach either host.

- `/model` / `/thinking` open the picker for the run's host catalog. They send a
  `configureRun` request and apply to that session only.
- `/compact [instructions]` asks the run's own agent host to summarize the
  conversation's context. The free text after the command is passed to the
  summarizer as its instructions; the host admits at most one compaction, keeps
  the older messages in storage, and places the summary at the next turn
  boundary. The outcome is reported as a notice — `started`,
  `already-compacting` (naming the reason already in flight), `nothing-to-compact`
  (the conversation holds no range a summary could replace), or "this run has
  finished" when the host no longer tracks it — so "nothing to compact" is never
  mistaken for a started compaction. The transcript shows the running compaction
  with its reason (`manual` or `automatic`) and the finished one with the
  measured tokens before and after when those are measurable.
- `/abort` aborts the running turn **and any compaction in flight**: a manual
  compaction is a non-background conversation-owned task, so aborting the run
  cancels it and no summary is placed.

An ordinary prompt is sent only when the active Orchestrator conversation has
both an effective model and thinking level. Missing settings produce a red
transcript error naming the missing choice and the command to select it. The
blocked prompt is retained as a user row in the transcript (and prompt history),
not sent to the host; after using `/model` and/or `/thinking`, resend it from
history or type it again. Picker commands and workflow-run presets are not
blocked. Configured user/project defaults populate the conversation and bypass
the gate.

The automatic thresholds behind all of this live in `[agents.compaction]`
(`docs/settings-inventory.md` "Compaction") and apply to every durable run,
running ones included.
| Workflow monitor | `src/tui/orchestrator/monitor.ts` + `transitions.ts` | The shell-owned observer of the workflows the orchestrator started: event → debounced re-read → pure projection diff → notification and, in `wake` mode, one coalesced session note. |

## Compact tool results

One conversation pays for every byte of every tool result on every later turn,
so the orchestrator's tools answer compactly and everything else is opt-in:

| Tool | Default answer | More |
| --- | --- | --- |
| `workflow_status` | One row: `workflowId`, `target`, `status`, `step`, `attention`, `revision`, `startedBy`, `pendingQuestions`, available action ids and labels, failed effects and the current run's role/status/model | `includeTask: true` adds the task text; `detail: "full"` returns the whole view (task, run history, gate decisions, health, worktree, preset). `sinceRevision` equal to the current revision answers `{unchanged, revision, status, step}` in a few bytes |
| `list_workflows` | One compact row per workflow (`workflowId`, `target`, `workflowType`, `status`, `step`, `branch`, `startedBy`, attention **count**) for every workflow that is not closed | `status: "all"|"active"|"attention"|"completed"|"closed"` (`active` includes `paused`); `detail: "full"` adds the task text, the attention text, available actions and agents |
| `list_agent_config` | With a `repository`: the default profile, the profile and preset **names** and the gate table | `detail: "full"` returns the full profile and preset tables |
| `list_branches` | The repository's `current`/`local`/`remote`/`default` refs | An identical call within 30 s is answered from a bounded in-memory cache (keyed by repository); any `start_workflow` clears it |

Every result is compact JSON — no indentation, because the indentation is paid
again on every later turn. A `detail: "full"` read records one runtime
telemetry envelope (`orchestrator.detail_full`, naming the tool) so full-view
usage stays measurable; it changes nothing about the answer.

The server-side `orchestratorQuestions` list is gone from the tool result: a
question routed to the orchestrator is already in `pendingQuestions` (the
server's copy duplicated the same records byte for byte), and its record keeps
`targetRole: "orchestrator"`, so it is still visible and still answerable with
`workflow_action` `answer-question` or `forward-question`. `workflow_action`
answers with the same compact row `workflow_status` returns by default.

A refused `start_workflow` names what to fix: an unclean worktree is refused
with the dirty paths (at most 20, plus the total count) and a duplicate id is
refused with the existing workflow's status. The task-reference variant of
`start_workflow` is not part of this contract.

## Before starting a workflow

The Orchestrator should establish these choices with the developer, in order:
repository/project; task (goal, constraints, acceptance); workflow type and why;
agent preset/model profile; mode (`worktree` or `checkout`); branch/base; ticket;
and `app` for `env-setup`. `list_agent_config` shows preset/profile choices: use
a configured developer default without asking, and ask about a profile only if
none is set or the request implies a different one. Read project lists, branches,
workflow state and presets with tools rather than asking the developer for
readable facts. A rebase start needs both `sourceBranch` and `targetBranch`;
`env-setup` needs the configured app ident from `list_projects`; validate a
blueprint before starting it.

## Shaping workflows

The orchestrator prefers a built-in workflow type; when none fits the request
it composes one from the blueprint step catalog instead of guessing at a
built-in:

- `list_steps` reads `GET /api/v1/workflow/steps`, the logical steps a
  blueprint may use (id, label, actor, outcomes, description). Routing, the
triage-routing step, the stage gates and every per-step routing step are
inserted by the server, so the catalog never lists them.
- `validate_blueprint` posts the candidate to
  `POST /api/v1/workflow/blueprint/validate`, which compiles it without any
  side effect and answers with the compiled summary and digest, or the
  diagnostics that refused it.
- `start_workflow` takes the validated blueprint instead of a built-in type
  (exactly one of the two; naming both is a malformed request). The server
  compiles the blueprint, stores its definition in the target repository's
  store with the `blueprint` origin and the authenticated principal, pins
  `metadata.blueprint = { label, rationale, digest }` on the workflow, and
  starts it through the same path a built-in type uses. The definition is
  content-addressed, so a retried start reuses the stored row.

### Starting an `env-setup` workflow

The `env-setup` family drafts the environment definitions of exactly one
configured application, so its start carries an `app`: the ident
`list_projects` reports for an `app` entry (`library` entries cannot be run and
are never a subject). `start_workflow` forwards it in the start request exactly
as the CLI's `workflow start --app IDENT` does, and
`POST /api/v1/workflow/start` validates it against the configured applications
before anything is written — an ident no configuration knows is answered
`400 app-not-configured`, and the family's own start guard refuses an
`env-setup` request without one.

Because the compiler's human-review invariant applies to every blueprint, a
shape that routes around plan approval, developer review or wiki approval is
refused with the compiler's diagnostic before anything is written — by the
orchestrator and the operator alike. An operator who genuinely needs a
review-free graph defines it explicitly with `workflow define`.

## Monitoring

The orchestrator only learned about a workflow when the developer asked. The
shell now observes the workflows the orchestrator started for as long as the
shell runs, independent of whether the page is open, through a typed workflow
event catalog.

**The server derives the events; the shell delivers them.** The unified server
turns its existing `workflow.*` stream into catalog events: it re-reads only the
workflow an event names (debounced per workflow, 250 ms, so a streaming run is
one read per window), diffs a small projection (`src/server/workflow-events.ts`)
and records the result in a bounded, cursor-addressed log (500 events, one
monotonic sequence). The derivation is idempotent, in the shape a real
env-setup run proved it had to be: the projection a derivation came from is
stored *before* anything it publishes can be observed, and a nested observation
of the same workflow is skipped. Without that, recording one transition
published a frame, the consumer of that frame read back into the bus while the
projection still held the previous state, and the same transition was derived
and delivered again — `step.completed`/`run.completed` in a loop at one pair per
few milliseconds, ~100% CPU, until the step changed. A replayed event is now
dropped outright, and one workflow's events are bounded
(`[agents.orchestrator] event_burst_limit`, default 120, per
`event_burst_window_seconds`, default 10) with the dropped count reported once as
`events.suppressed`; a human-needed event is never dropped. The whole pipeline is
idle when `monitor` is `off`, and an unreadable workflow keeps its previous
projection: an event is never invented from a miss.

An event that names **only a repository** (the refresh hub's progress listener
carries no workflow id — one per committed effect of a drain) coalesces into one
re-list of that repository per window instead of being dropped: the listing
diffs every workflow the bus already holds a projection for, so a transition no
workflow-id-carrying event ever named is still reported, and a repository's
first listing still only establishes its baseline. A last safety net covers a
writer this process never hears from at all (a handoff committed by another
process, the CLI, a second TUI): every `[agents.orchestrator]
reconcile_seconds` (default 30, file-only) the bus re-lists the repositories it
tracks that still hold an `active` or `attention-required` workflow, and costs
no store read for a repository whose work is done or when `monitor` is `off`. A
listing is debounced per repository and never nests: a request that arrives while
one is running becomes one follow-up pass, not a second read. The bus's own
subscription queue filling up is deliberately *not* a refresh trigger — it
consumes the stream live, so that queue is a replay buffer nothing drains, and
treating its overflow as a gap re-listed every tracked repository on every later
publish.

The catalog lives in `src/contracts/workflow-events.ts` (version 2, stable ids)
and covers the workflow lifecycle (`workflow.started`/`completed`/`closed`/
`failed`), steps, the four developer reviews (`review.waiting`/`resolved`),
developer questions (`question.pending`/`routed`/`answered`), attention,
effects, delivery, runs, verification findings, compaction, gate decisions, the
orchestrator launch ceiling (`limit.hit`), the bus's own rate limit
(`events.suppressed`) and OpenSpec task progress. Only
`review.waiting` and `question.pending` are **human-needed**: they raise the
shell notification. Every payload is a bounded, secret-free summary — no
credential, no raw transcript, no task text beyond a bounded summary.

The **first** observation of a workflow only establishes its baseline: a
workflow already waiting at plan approval when the shell starts is the
developer's situation, not news. `workflow.started` is the one exception and
comes from the repository listing (an id a baselined repository did not hold
before).

### Subscriptions

The orchestrator decides what it hears about with four tools, all served from
the typed `/api/v1` surface:

| Piece | What it does |
| --- | --- |
| `subscribe_events` | Stores one subscription: a filter, a mode, an expiry and a label |
| `unsubscribe_events` | Removes one by id (idempotent) |
| `list_subscriptions` | Shows label, id, filter, mode, expiry and last delivery |
| `read_events` | Pulls recorded events since a cursor (max 200 per page) instead of being woken |

A subscription's filter names workflows (`scope`: `mine` = the orchestrator's
own, `all`; or `workflowIds`/`repositories`), events (`eventIds` or
`categories`) and conditions (`reasons` — attention reason substrings, `roles`,
`minSeverity`). Its mode is `wake` (notes), `digest` (one note per interval,
default 5 minutes) or `silent` (recorded and readable, never delivered). It
always carries a label and an expiry (default now + 24 h, at most 30 days) and
may end early with `untilWorkflowClosed` or `remainingEvents`.

Severities decide what a `minSeverity` filter keeps, and the completion events
sit at the bottom of the scale: `workflow.started`, `workflow.completed`,
`workflow.closed`, `step.*`, `run.started`, `run.completed`,
`review.resolved`, `question.routed`, `question.answered`, `attention.cleared`,
`delivery.push`, `pull-request.state`, `compaction`, `gate.decided` and
`openspec.task-progress` are `info`; `workflow.failed`, `attention.raised`,
`run.blocked`, `run.aborted`, `run.stalled`, `limit.hit`, `review.waiting`,
`question.pending` and `verification.finished` are `warning` (a
`verification.finished` with critical findings, and an `effect.failed` after
three attempts, are `critical`). So `minSeverity: "warning"` **excludes** the
completion a "tell me when it finishes" subscription is waiting for: name the
event ids (`workflow.completed`, `workflow.failed`, `workflow.closed`, …) or
pass `minSeverity: "info"` instead. `untilWorkflowClosed` is deliberately NOT a
filter widening — it only prunes the record once that workflow is `completed`
or `closed` (through the server's durable closed list, so the pruning works
even while the filter matches nothing) — because widening would silently turn
"warnings about this workflow" into "every event from it". The event that
reaches the condition still reaches the subscription: the server matches an
event against the subscriptions as they were before that event's own pruning
applies, so the completion a "tell me when it finishes" subscription waits for
is delivered to it, and the record is pruned immediately afterwards.

Subscriptions are owned by the orchestrator session and persisted next to its
conversation state in `<config root>/orchestrator/event-subscriptions.json`
(atomic write, `0o600`); they are pruned on expiry, on a named workflow
closing, on a spent event budget and when the session is no longer the active
one (`/new`). No workflow store is touched, so `STORE_SCHEMA_VERSION` stays 6.

With no explicit subscription the server treats one implicit **`default`**
subscription as active — the events the monitor delivered before this change
(`review.waiting`, `question.pending`, `question.routed`, `attention.raised`,
`workflow.failed`, `effect.failed`, `workflow.completed`) for the orchestrator's
own workflows, in `wake` mode. `list_subscriptions` shows it and any explicit
subscription replaces it.

What a subscription does depends on `[agents.orchestrator] monitor`, which stays
the master switch:

| Mode | Shell notification | Note to the active session |
| --- | --- | --- |
| `wake` (default) | yes, for human-needed events | yes, per subscription |
| `notify` | yes, for human-needed events | no |
| `off` | no — nothing is observed at all, and every subscription tool is refused | no |

Notes are submitted to the active session as `whenBusy: "followUp"` input. The
first line is `[workflow-monitor] subs=<labels>`, naming every subscription that
asked for the note, followed by one line per event,
`- <workflowId> → <stepId> (<what changed>)`. Events inside a 10 s coalescing
window become one note — the window opens with its first event, and an event
that arrives while it is still open joins it instead of opening a second one —
the session receives at most one note per minute, and everything beyond that
bound is merged into the next note. One event matched by
several subscriptions is one line listing all their labels. A note lists at most
20 event lines, the pending backlog holds at most 200 events (the oldest dropped
and counted in the next note elision) and a session receives at most 20 notes in
a trailing hour. The host is ensured on the first note, so a wake-up works
without the page having been opened; a note that cannot be delivered is dropped
rather than retried, because the workflow's state is still visible in the
sidebar. A stream gap — and a transport overflow, which the stream reports the
same way — keeps the pending backlog and re-arms the timer: anything the server
recorded but the shell never saw is still readable with `read_events`, and a
burst that filled the queue is still delivered.

A subscription's own `coalesceMs`, `minIntervalMs` and `digestMinutes` override
the defaults, an absent `filter.scope` reads as `mine`, `remainingEvents` counts
the events it matched while it was live (a record budget, so a `silent`
subscription ends by count too), and `/subscriptions` prefixes the listing
with the effective master switch, so a listed `wake` mode never implies a
delivery the switch forbids. A subscription's `lastDeliveredAt` is stamped by
the server when it publishes that subscription's delivery frame.

Notifications never depend on the session or on any subscription: a review
waiting on the developer is reported in both `wake` and `notify` mode, and
`/subscriptions` on the Orchestrator page lists the active subscriptions and
removes one.

`[agents.orchestrator] stall_minutes` (default 30, file-only) is how long a
tracked `active` workflow may make no progress before one `run.stalled` event is
recorded for it (and not a second one until it changes again). A stall is
claimed only after a fresh read confirms the workflow is still `active` and
unchanged: a workflow that completed, closed or blocked since the last
observation updates its projection instead, so a stale projection can never
produce a `run.stalled` for a workflow that is already finished.

## Launch limits

The orchestrator can start any number of workflows, and a misread request, a
retry loop in the model, or a wake-up it answers with "start another one" would
fan out without bound. `[agents.orchestrator] limits` is the ceiling the server
enforces regardless of what the session decides:

```toml
[agents.orchestrator.limits]
max_active = 5          # default 5
max_starts_per_day = 20 # default 20
```

Immediately before an orchestrator start, the server counts the
orchestrator-started workflows across every workflow target: those that are
neither `completed` nor `closed` against `max_active`, and those created in the
trailing 24 hours against `max_starts_per_day`. When a bound is reached the
start is refused with `409 orchestrator-limit`, and the refusal names the limit,
the current count and the workflows counted (`5 of 5 active workflows (a, b,
c)`), so the session can relay exactly why it was refused. Operator starts are
never limited or counted.

The ceiling is **user-level**: the server resolves it with no project overlay
(`loadConfigWithProvenance({ repositoryIndependent: true })`), so a checked-out
repository's `.pi` overlay cannot loosen its own guard, and the read-only
Settings row shows the value the server enforces rather than the selected
project's. The count reads the target registry plus the wiki and research
targets — the same set the sidebar reads — and is observational: an absent
store contributes nothing, a store that needs migration or cannot be opened is
counted as zero and named in the refusal as skipped, and the wiki and research
targets are one store file counted once. There is no queueing: a refused start
is simply not created.

The count is read immediately before `operations.start`, and the start commits
synchronously (the route never yields between counting and the instance row), so
a second concurrent start already sees the first. No new lock is taken; an
implementation that yielded between counting and committing could let two
starts pass at `max_active - 1`, an overshoot bounded by the parallelism and
accepted by design.

## Boundary

- The session's tools are exactly `read` plus the orchestrator tools: no
  `bash`, `write`, `edit` or codemode, so the capability in its run env is the
  only way it can act. The host process environment has the operator tokens
  (`AGENTIC_WORKFLOW_TOKEN`, `AGENTIC_DEVENV_TOKEN`) removed.
- Allowed routes: health, observe, workflow view/start/steps/blueprint
  validate/action/execute, agents config read, classifier status, events.
  Everything else is `403 orchestrator-forbidden` (questions, review saves,
  repair, delete, config writes, agent handoffs, credentials, the environment
  and legacy surfaces).
- Allowed actions: `resume`, `retry-effect:*`, `switch-preset` anywhere;
  `close` and `create-pr` outside a review step. Every approval/rejection/
  review-comment action is refused, and nothing but recovery is allowed while
  the workflow sits on `core.plan-approval`, `core.developer-review`,
  `core.findings-review` or `core.wiki-approval`.
- Starts by the orchestrator pin the `planApproval`, `developerReview` and
  `wiki` gates to `always` (`withHumanReviewGates`), so the classifier can
  never skip a human review on its behalf. The flag is server-decided; the
  wire request cannot carry it.

## Not yet

Custom-graph presentation in the dashboard (`show-custom-workflow-graph`) and
blueprint editing in the TUI are follow-ups: the orchestrator can shape and
start a blueprint, and the workflow stores and pins it, but the dashboard still
renders the graph of the pinned built-in-style definition rather than a
custom-graph view.
