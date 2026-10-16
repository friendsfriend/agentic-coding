# Design

## Context

Today one module owns the whole pipeline: `src/tui/orchestrator/monitor.ts`
subscribes to the server's `workflow.*` events, debounces a re-read per
workflow, projects the view (`transitions.ts`) and diffs two projections. The
server's `workflow.updated` envelope carries only a repository and a workflow id
(`src/server/subscriptions.ts`), so any consumer that wants meaning must re-read
and project a view itself. Delivery is fixed: human-needed transitions raise a
shell notification, and in `wake` mode every transition becomes one coalesced
note (10 s window, ≤ 1 note/minute, merge-forward) submitted to the active
durable orchestrator session as `followUp` input.

Constraints that shape the design:

- The orchestrator's tools execute in a **separate durable host process**
  (`src/tui/orchestrator/session.ts` starts `agent host --orchestrator`); every
  tool reaches shell state through the unified server's `/api/v1` surface and
  the orchestrator capability. There is no other channel.
- The unified server runs **in the shell process** (`src/tui/index.tsx` calls
  `startWorkflowServer`), so shell-visible state is server-visible state.
- `src/server` may not import TUI presentation (`test/workflow-source-layer-
  boundaries.test.ts`, `checkServerBoundaries`), and `src/contracts` is pure.
- The workflow store is off limits: `STORE_SCHEMA_VERSION` stays 6 and no store
  schema changes (the repo just removed all legacy-migration logic).
- Behaviour of workflows must not change: this feature only observes.

## Goals / Non-Goals

**Goals:**

- One versioned, typed event catalog with stable ids, derived from the existing
  `workflow.*` events and workflow projections — no second source of truth.
- Orchestrator-controlled subscriptions (what, where, how delivered, until
  when), durable across a TUI restart, visible and removable by the developer.
- Delivery that cannot storm: per-subscription coalescing/interval, de-dup,
  bounded notes, hard caps.
- The catalog on a typed `/api/v1` surface so the CLI and dashboard can consume
  the same events later without a second implementation.
- Today's behaviour as the default: nothing regresses when no one subscribes.

**Non-Goals:**

- Changing what a workflow does, its steps, gates or effects.
- A second event transport: the existing broker/SSE stream and its resync
  semantics are reused, not duplicated.
- Dashboard/CLI surfaces for the catalog (only the v1 read route is added; a
  later change may consume it).
- Persisting the event log itself across a restart (subscriptions persist; a
  restart invalidates cursors, see D9).

## Decisions

### D1. Derivation moves server-side; delivery stays in the shell

The server owns the catalog pipeline: `workflow.updated` → debounce per workflow
→ one view read → pure projection diff → catalog events into a bounded log plus
a delivery frame on the broker. The shell's monitor keeps only the half that
needs the durable host client: notifications, coalescing and submitting notes.

*Why not keep derivation in the shell (the current design)?* The log must be
queryable by `read_events` from the host process, and the subscription registry
must be writeable by `subscribe_events`/`unsubscribe_events` from that same
process. Both would then have to travel from the host into the shell over a
second channel, or the shell would have to push its in-memory log back into the
server — a shim with no owner. The server is the one process the host can
already reach, it already receives every workflow change, and it already owns
the orchestrator policy and the launch ceiling. *Alternative considered:* a
shell-local registry that both processes write as a JSON file with
read-modify-write merges; rejected — two writers, no lock, and the monitor would
still need to be told about expiry/cleanup decisions.

*The catalog therefore lives behind `/api/v1`*: `GET /api/v1/workflow/events`
(cursor reads) plus the subscription routes. Auth, the v1 manifest
(`src/server/protocol.ts`) and the orchestrator route allowlist
(`src/server/orchestrator-policy.ts`) apply unchanged. The CLI and the dashboard
can consume a route that already exists instead of importing a TUI module.

*Cost is bounded by construction:* only the workflow an event names is read, the
read is debounced per workflow (250 ms, the monitor's current cadence), and the
whole pipeline is idle when `[agents.orchestrator] monitor = off` or when the
repo is not registered with the server's refresh hub (`watchRepo` — already
called for every repo a workflow is started/acted on in, so an orchestrator
start registers its own repo). No subscription ever causes a re-read of *all*
workflows; a repo-level baseline listing happens only on a resync gap, exactly
as today.

### D2. Catalog in the contract layer, derivation in the server layer

- `src/contracts/workflow-events.ts` (pure, versioned): the catalog table
  (`id` → category, human-needed flag, payload schema bounds), the
  `WorkflowEventRecord`/`WorkflowEventSubscription` wire types and their Effect
  Schemas, the mode union, `WORKFLOW_EVENT_CATALOG_VERSION = 1`. Every layer may
  import it; it imports no layer.
- `src/server/workflow-events.ts` (pure functions, no I/O): the projection the
  diff works on, `deriveWorkflowEvents(previous, next, context)`, and
  `matchesSubscriptionFilter(filter, event)`. It reads the review-step table
  from `orchestrator-policy.ts` (see D3) and never touches a store.
- `src/server/workflow-event-bus.ts` (I/O): the bounded log, the durable
  subscription registry, the debounced derivation driver and the publish to the
  broker.

The catalog is **one table**; the note text, the notification predicate, the
route validation and the docs all read it. The old `transitions.ts` detector is
deleted rather than kept beside it (no shims): its projection becomes a superset
in the new derivation, and the existing monitor test is rewritten against the
new seam.

### D3. The event table

Every id below is stable and versioned. `source` names the projection field or
the one non-projection producer; `human` marks the events that owe the developer
a decision. Payloads are bounded, secret-free summaries; no raw transcripts, no
task text beyond a ≤ 160-character, control-character-stripped summary, and any
error string passes the existing `redactSecrets` masking and is truncated.

| id | category | payload | source | human |
| --- | --- | --- | --- | --- |
| `workflow.started` | workflow | `{ taskSummary? }` | an id absent from the previous listing of an already-baselined repo | no |
| `workflow.completed` | workflow | `{ stepId, stepLabel }` | `status` → `completed` | no |
| `workflow.closed` | workflow | `{ stepId, stepLabel }` | `status` → `closed` | no |
| `workflow.failed` | workflow | `{ stepId, stepLabel, reasons[] }` | `status` → `attention-required` (reasons come along; `attention.raised` is *not* also emitted for that same diff) | no |
| `attention.raised` | attention | `{ reasons[] }` | `health.attention` gained entries without the status edge above | no |
| `attention.cleared` | attention | `{ reasons[] }` | `health.attention` lost entries | no |
| `step.entered` | step | `{ stepId, stepLabel, attempt }` | `currentStep.id` or `attempt` changed | no |
| `step.completed` | step | `{ stepId, stepLabel, nextStepId, attempt }` | step id changed (the previous step left) | no |
| `review.waiting` | review | `{ review: "plan"\|"developer"\|"findings"\|"wiki", stepId, stepLabel }` | entered a step of `HUMAN_REVIEW_STEPS` | **yes** |
| `review.resolved` | review | `{ review, stepId, stepLabel, nextStepId }` | left such a step | no |
| `question.pending` | question | `{ questionId, role, stepId }` | a question entered `pendingQuestions` | **yes** |
| `question.routed` | question | `{ questionId, role, stepId }` | a question entered `orchestratorQuestions` | no |
| `question.answered` | question | `{ questionId, role, answeredBy, kind }` | a pending question left its pending set for an answered dialogue record | no |
| `effect.failed` | effect | `{ effectId, kind, attempts, error? }` | an effect newly in `failed` | no |
| `delivery.push` | delivery | `{ effectId, kind, status }` | a `delivery.commit`/`delivery.push` effect reaching a terminal status | no |
| `pull-request.state` | delivery | `{ effectId, status }` | a `pull-request.create` effect reaching a terminal status | no |
| `run.started` | run | `{ runId, role, stepId, attempt, model? }` | a run appeared in `runs` | no |
| `run.completed` | run | `{ runId, role, stepId, status }` | a run reached `completed`/`failed`/`expired` | no |
| `run.blocked` | run | `{ runId, role, stepId }` | a run became `blocked` for any reason other than the developer abort | no |
| `run.aborted` | run | `{ runId, role, stepId }` | a run became `blocked` while `DEVELOPER_ABORT_MESSAGE` is in the attention list | no |
| `verification.finished` | verification | `{ role, round, counts: { critical, warning, info } }` | a `core.verification` run completed; counts via `verifierFindingCounts` | no |
| `compaction` | compaction | `{ role, reason?, tokensBefore?, tokensAfter? }` | the run's own telemetry gained `runtime.compaction_*` | no |
| `gate.decided` | gate | `{ gateId, stepId, stage, policy, decision, forced }` | a new `gateDecisions` record | no |
| `limit.hit` | limit | `{ limit, current, maximum }` | the launch-ceiling refusal path in `app.ts` — the one event not derived from a projection | no |
| `run.stalled` | run | `{ stepId, stepLabel, minutes }` | the stall tick: a tracked `active` workflow whose `updatedAt` is older than `[agents.orchestrator] stall_minutes` (default 30) | no |
| `openspec.task-progress` | progress | `{ changeId, done, total }` | the change's tasks artifact, re-read when the step or an artifact effect changed | no |

Derivation rules that make the table deterministic:

- The **first observation of a workflow is a baseline and emits nothing** — the
  same rule the current detector has, so a workflow already parked at plan
  approval when the shell starts is the developer's situation, not news.
  `workflow.started` is the one exception and is derived from the *listing*
  diff (an id that was absent from the previous listing of a repo whose baseline
  was already taken), so the initial listing never produces a start event.
- A **cleared-then-returned obligation produces a new event**, because the
  derivation compares two projections and keeps no history of its own.
- Events for one diff are ordered by the catalog's category order
  (`workflow`, `step`, `review`, `question`, `attention`, `run`, `effect`,
  `delivery`, `verification`, `compaction`, `gate`, `limit`, `progress`), so a
  note is deterministic.
- `review.waiting`/`review.resolved` need the review-kind vocabulary
  (`plan`/`developer`/`findings`/`wiki`). `HUMAN_REVIEW_STEPS` already names
  exactly those four steps; the kind map is added **next to it** in
  `src/server/orchestrator-policy.ts` and `HUMAN_REVIEW_STEPS` is derived from
  its keys, so there is still one table and no drift. (The step definitions own
  the *behaviour*; this map only names the review kinds in event payloads.)

### D4. Subscriptions: model, ownership, caps

One record, owned by the orchestrator session that created it:

```
{
  id,                      // server-assigned, bounded id
  label,                   // ≤ 40 chars, shown in notes and /subscriptions
  reason,                  // ≤ 200 chars, for the developer reading the list
  session,                 // orchestrator conversation name the tool ran in
  createdAt, lastDeliveredAt?,
  filter: {
    scope: "mine" | "all",            // "all started by me" is the default
    workflowIds?: string[],           // ≤ 20
    repositories?: string[],          // ≤ 8 absolute paths
    eventIds?: string[],              // ≤ 32 catalog ids
    categories?: string[],            // ≤ 13 categories
    reasons?: string[],               // attention-required reason substrings
    roles?: string[],                 // run roles
    minSeverity?: "critical" | "warning" | "info"
  },
  mode: "wake" | "digest" | "silent",
  coalesceMs?, minIntervalMs?,        // wake mode overrides
  digestMinutes?,                     // digest mode, default 5
  expiresAt,                          // required: default now + 24 h, max + 30 d
  untilWorkflowClosed?: string,       // expiry condition
  remainingEvents?: number            // expiry condition (a count)
}
```

- **Ownership.** The tool stamps `session` from its own `conversationId`; the
  server treats it as advisory bookkeeping (visibility and cleanup), never as a
  security boundary — the boundary is the route allowlist (only the orchestrator
  principal may manage subscriptions). The developer removes one from the
  Orchestrator page, which authenticates as the operator.
- **Matching** happens in the pure matcher at record time (the server evaluates
  the active subscriptions against each event and publishes the matched
  `{ id, label, mode }` set). Filters are conjunctive; `scope: "mine"` requires
  `startedBy === "orchestrator"`; an absent id/category list means "every event
  in the scope".
- **Caps:** at most 20 subscriptions in the store (refused with a clear error,
  naming the limit); labels and reasons bounded; a required `expiresAt`; at most
  20 workflows/8 repositories/32 events/13 categories per filter.
- **The default subscription** is implicit: while the store holds no
  subscription for the active session, the server synthesises one
  (`label: "default"`, `scope: "mine"`, the ids that reproduce today's
  transitions — `review.waiting`, `question.pending`, `question.routed`,
  `attention.raised`, `workflow.failed`, `effect.failed`,
  `workflow.completed` — mode `wake`). It is what the delivery path matches
  when nothing is stored, so listing and matching can never disagree.
  `list_subscriptions` shows it explicitly, and any explicit subscription
  replaces it. This keeps today's behaviour the default without a hidden special
  case in the delivery path. An absent `filter.scope` reads as `mine`.
- **Cleanup:** pruned when `expiresAt` passes, when `untilWorkflowClosed` names
  a workflow that is `closed`/`completed` (the closed ids are part of the same
  durable store, so the condition still resolves after a restart), when
  `remainingEvents` reaches zero (a *record* budget: every matched event of the
  subscription counts, `silent` included),
  when the record's `session` is not the active orchestrator session (reset via
  `/new`), and on `unsubscribe_events`.

### D5. Delivery semantics

The server publishes a frame for every event that is human-needed **or** matched
by at least one non-`silent` subscription. A frame carries the event and the
matched subscriptions (id, label, mode). The shell monitor:

| Concern | Rule |
| --- | --- |
| Notification | a human-needed event raises one shell notification for a workflow the orchestrator started — today's scope, unchanged — whatever the subscriptions; `off` raises none |
| De-duplication | one line per event even when several subscriptions matched; the note's header lists all contributing labels (`[workflow-monitor] subs=default,awaiting-review`) |
| `wake` | transitions inside the coalescing window (default 10 s) become one note; at most one note per minute per session (merge-forward), overridable per subscription by `coalesceMs`/`minIntervalMs` |
| `digest` | events are accumulated and delivered at most once per `digestMinutes` (default 5) |
| `silent` | matched and recorded, never delivered; still readable with `read_events` |
| Bounded note | at most 20 event lines, then `… +N more` |
| Bounded backlog | at most 200 pending events; the oldest are dropped and counted in the next note |
| Hard cap | at most 20 notes per trailing hour per session; beyond it events stay queued (merge-forward) |
| Ordering | by event sequence, then catalog order |
| Best effort | a note that cannot be delivered is dropped, as today: state is visible in the sidebar |

The note shape stays `[workflow-monitor]` + one line per event, so the
orchestrator's existing reading habit keeps working; the orchestrator system
prompt gains one paragraph explaining `subs=`, the line format and how
`subscribe_events`/`read_events` complement it.

The timing behaviour lives in a **pure delivery planner**
(`src/tui/orchestrator/delivery.ts`): given matched events, the timings and
`now`, it returns what to deliver. The monitor keeps only timers and I/O, which
is what makes coalescing, the per-minute bound, digest cadence and expiry
testable with fake clocks.

### D6. The master switch, and `off`

`[agents.orchestrator] monitor` keeps its meaning: `wake` (default) delivers and
notifies, `notify` notifies and accepts subscriptions but delivers no notes
(`list_subscriptions` says so), `off` observes nothing: the bus is not started,
nothing is derived, no frame is published, no subscription route is served — the
tools answer with a clear error ("the workflow monitor is off; set
`[agents.orchestrator] monitor` to `wake` or `notify`"). Human-needed
notifications continue exactly as today in `wake` and `notify`.

### D7. Tools

Four additive tools in `src/agent-host/orchestrator.ts`, each one `call()` to a
v1 route with compact descriptions, plus one prompt paragraph:

- `subscribe_events` → `POST /api/v1/orchestrator/subscriptions` (validates the
  filter, refusing unknown workflow ids and an `off` mode); returns the record.
- `unsubscribe_events` → `POST /api/v1/orchestrator/subscriptions/delete`
  (`{ subscriptionId }`); idempotent.
- `list_subscriptions` → `GET /api/v1/orchestrator/subscriptions` (includes the
  implicit default and each record's last delivery).
- `read_events` → `GET /api/v1/workflow/events` (`after`, `limit` ≤ 200, filter
  fields, `scope`); a stale cursor is answered as `cursor-expired` with the
  oldest retained sequence, so the orchestrator can re-baseline instead of
  guessing.

`ANOTHER workflow (orchestrator-tool-hints-and-model-gate) is editing the same
file`: the tools are appended as new entries at the end of the tools array and
the prompt paragraph is added as its own bullet, so the two changes merge
cleanly.

### D8. Persistence

`<config root>/orchestrator/event-subscriptions.json` (resolved through
`resolveConfigRoot()`), written atomically (temp file + rename, `0o600`), next
to `session.json` — the orchestrator conversation state it belongs to. Nothing
touches the workflow store, so `STORE_SCHEMA_VERSION` stays 6 and the
developer's live store is untouched. The event log itself is in-memory and
bounded (500 events); a restart invalidates cursors (D9).

The server reads the active session name from the same file `session.ts` writes
(`session.json`). Because `src/server` may not import `src/tui/...`, the path
helper (`orchestratorRuntimeDir`/`currentSessionName`) moves to a small
**root-layer** module both sides import; `session.ts` re-exports it so no
existing caller changes.

### D9. Failure and security

- **Visibility.** A subscription can never widen what the orchestrator may see:
  unknown workflow ids are refused, the scope is the set the `observe` surface
  already returns, and payloads are the same bounded summaries `workflow_status`
  already exposes. No new secrets, no raw transcripts, no task text beyond the
  bounded summary, and every error string is redacted and truncated.
- **Injection.** Event payloads are decoded with contract schemas before they
  are recorded or published; a malformed payload is dropped, not forwarded.
- **Storm.** Section D5's caps are the whole defence; a subscription cannot ask
  for a tighter bound than the caps allow, only a looser one.
- **Stale cursor.** `read_events` answers `cursor-expired` rather than silently
  returning a gap; the monitor treats a broker resync as "drop the backlog and
  continue from the next event" (bounded miss, documented).
- **Failure isolation.** A derivation that throws (an unreadable store, a bad
  payload) is dropped for that workflow and the previous projection is kept, so
  an event is never invented from a miss and the server never fails because of
  the observer.

### D10. Migration: clean replacement, no shims

There is no dual path and no legacy migration: `transitions.ts` is deleted, the
monitor is rewritten against catalog events, and no compatibility reading of the
old note format or of a previous registry is added. The only preserved shape is
the `[workflow-monitor]` prefix itself, which is a note format the orchestrator
prompt explains, not a persisted state. (The repo just removed all
legacy-migration logic; this change adds none.)

### D11. How each part is verified

- **Catalog derivation** — unit tests over synthetic projection pairs: one test
  per event id (and per "must not fire" rule: first observation silent, no
  `attention.raised` beside `workflow.failed`, no `run.aborted` without the
  abort entry, no `workflow.started` on the baseline listing); a table test
  asserting every catalog id has a derivation test.
- **Matcher** — table tests over scope/workflow ids/repos/ids/categories/
  reasons/roles/severity, including conjunction and the default subscription.
- **Log and routes** — a real loopback server with injected operations, like
  `test/orchestrator.test.ts`: cursor paging, `cursor-expired`, the `off`
  refusal, unknown workflow, the subscription cap, and the orchestrator route
  allowlist.
- **Delivery** — the pure planner with explicit `now` (coalescing, per-minute
  bound, merge-forward, digest cadence, de-dup across subscriptions, the note
  and backlog caps, expiry) plus the monitor with injected timings and an
  injected `deliver`/`notify`, as the existing monitor test does.
- **Persistence/cleanup** — a temp config root (`HOME`/`AGENTIC_CODING_CONFIG_DIR`
  under `mktemp`) reused across two bus instances, plus pruning tests for each
  cleanup trigger.
- **Tools** — the orchestrator tool suite (`test/orchestrator.test.ts`
  conventions): schemas, the `off` error, the unknown-workflow error, the
  too-many-subscriptions error.
- **TUI** — the `/subscriptions` command listing and removal through the data
  layer, and the keybind catalog unchanged (the command is not a keybind).
- **Docs/specs** — `openspec validate --specs --strict`, `bun run lint`,
  `bun run type-check`, the focused suites above. The complete repository suite
  belongs to the workflow's own test verifier, not to these tasks.

## Risks / Trade-offs

- [The default subscription could regress the current note semantics] → it is
  the ids the current detector emits, and a test pins the exact note text
  for the six transitions.
- [Deriving in the server reads views for developer-started workflows too] →
  derivation is gated on the monitor mode and on the repo being registered with
  the refresh hub, reads only the named workflow, and is debounced per workflow;
  the cost is the monitor's today's cost plus the repos a subscription names.
- [`health.attention` is a free-form string list, so reason-based filters are
  substring matches] → documented as advisory substring matching, and the
  payload always carries the reasons for the orchestrator to judge.
- [The catalog table is long and can drift from the projections] → one table in
  the contract layer, a derivation test per id, and a test that every id has
  both a derivation case and a payload schema.
- [Two shells sharing one config root share the registry file] → the registry is
  session-keyed, last-write-wins and small; documented. The pre-existing
  ambiguity (two shells observing one orchestrator session) is unchanged.
- [Concurrent edit of `src/agent-host/orchestrator.ts`] → additive tools at the
  end of the array and one self-contained prompt bullet; rebase on main before
  the final summary.
- [Compaction events depend on run telemetry being present] → the derivation
  tolerates a missing telemetry file (no event), and a test pins that.

## Open Questions

- Should `limit.hit` also cover a per-workflow effect-attempt budget, or stay
  the orchestrator launch ceiling only? (Design assumes the ceiling only, which
  is what the objective names.)
- Should the event log survive a restart (a small SQLite/JSON file) instead of
  being in-memory with cursor invalidation? (Design keeps it in-memory: bounded,
  and `read_events` answers a stale cursor explicitly.)
- Is a false-positive `workflow.started` acceptable for a workflow created while
  the repo listing was unavailable? (Design emits none in that case: no baseline,
  no start event.)
