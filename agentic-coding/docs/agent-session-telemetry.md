# Agent session telemetry content

Status: session content capture behind the existing telemetry opt-in.

The runtime bridges (`agent-definitions/bridges/*`) emit one envelope per
lifecycle event into `.herdr-workflow/<id>/telemetry.jsonl` (and, when
`OTEL_EXPORTER_OTLP_ENDPOINT` is set, the OTLP logs endpoint). Metadata is
always emitted. Session content — user/assistant text, tool arguments and tool
results — is captured only when the run's `telemetry.capture_content` config is
true (the default), which the engine forwards to the agent process as
`HERDR_CAPTURE_CONTENT=1` in the run environment. With capture off, no content
key ever reaches an envelope.

## What is captured

| Event | Content attribute | Value |
| --- | --- | --- |
| `runtime.message` (role `user`) | `herdr.content.input` | user message text |
| `runtime.message` (role `assistant`) | `herdr.content.output` | assistant text parts |
| `runtime.tool_start` | `herdr.content.tool_input` | tool arguments (JSON) |
| `runtime.tool` | `herdr.content.tool_output` | tool result (JSON) |
| opencode `runtime.part_length` (final text part) | `herdr.content.input` / `herdr.content.output` | text part |

pi emits one `runtime.message` per user/assistant message, so the conversation
is reconstructable without repeating the whole history per provider call.
opencode text parts are captured only once complete (`time.end`, or a user
part) and only when the part's message role was learned from a `message.updated`
row; tool content is captured once per call id (arguments on the first update
that carries them, result on the terminal one).

Every value is redacted with the bridge credential pattern before the cap and
truncated to 8192 characters, matching the engine's `TELEMETRY_ATTRIBUTE_LIMIT`.
A cut value is marked by `pi.content.truncated` / `oc.content.truncated`. Tool
results are never re-emitted as a second message row.

## Where it shows

`parseTelemetryLine` maps every scalar envelope key to a span attribute, so the
captured content reaches the trace database unchanged. The observability span
detail renders `herdr.content.*` attributes wrapped (JSON indented) under
"Message input", "Message output", "Tool input" and "Tool output" instead of a
clipped one-line metadata row.

## Classifier routing telemetry

The JEV/System One routing integration emits adapter spans for each provider
call and an engine span for each applied decision:

- `routing.request` and `routing.response` carry `model`, effect identity, and
  `herdr.routing.integration`, `.phase`, `.steps.asked`, `.entries.offered`,
  `.artifacts.count`, `.state.bytes`, `.timeout.ms`, and `.endpoint.host`.
  Responses add `outcome`, `durationMs`, `herdr.routing.status`,
  `.status.class`, `herdr.error.class`, and successful choice/`noul` answer
  counts. Numeric `tokens` and `cost` are present only when System One reports
  them; missing usage is never represented as zero.
- `routing.classified` carries `herdr.routing.phase`, `.steps.asked`,
  `.steps.applied`, `.fallback.count`, and per-step
  `herdr.routing.<stepId>.label`, `.confidence`, `.fallback`, plus `.profile`
  for a single selection or stable comma-joined `.profiles` and
  `.selected.count` for a roster.

Routing telemetry is permanently content-free, regardless of
`telemetry.capture_content`: task text, prompts, artifact contents, pool
criteria, free-form answers, and model output are never exported. Only bounded,
redacted scalar metadata and the validated pool label/profile actually applied
may leave the process.

## Durable runtime envelopes (`pi-durable`)

Durable runs are driven by `pi-durable`'s own agent-event stream
(`src/agent-host/telemetry.ts`, `watchEvents`) rather than the bridges above, and
tag every envelope `runtime: "pi-durable"`. Alongside `runtime.turn_started`,
`runtime.usage`, `runtime.tool_start`, `runtime.tool`, `runtime.settled` and
`runtime.task_failed`, one compaction is reported by two envelopes
(`add-agent-compaction`), and the cost ceiling's decisions by a third:

| Event | Fields |
| --- | --- |
| `runtime.compaction_start` | `reason` (`manual`, `threshold` or `overflow`), `kind` (`auto-ceiling`, `auto-overflow`, `auto-checkpoint` or `manual`), `blocking` (a generation waits for it), `attempt` |
| `runtime.compaction` | `reason`, `kind`, `blocking`, `attempts`, `durationMs`, `tokensBefore` / `tokensAfter` when measurable, `outcome` (`completed`, `failed` or `aborted`), and `pi.error.class` when it failed |
| `runtime.compaction_ceiling` | the cost ceiling's own decisions: `status` (`compact`, `ignored` or `suspended`), `reason` (`above-overflow` or `loop-guard`), `ceilingTokens`, `contextTokens`, `overflowTokens`, `turnIndex`, `floorTurns`, `floorTokens`, `windowTurns`, `loopLimit`, `taskId`, and the `kind` that claimed the campaign (`auto-ceiling` or `auto-checkpoint`) |

`kind` is what the analysis counts: pi-durable knows `manual` and the automatic
threshold/overflow family, and the host claims its own proactive compactions as
`auto-ceiling` (efficiency backlog item 6) or `auto-checkpoint` (a run-progress
checkpoint that decided `compact`, efficiency backlog item 19). `runtime.settled`
additionally carries `peakContextTokens` (the largest prompt the conversation ever
carried), `turns`, `costUnits` (the run's cumulative provider cost, never a
price), `compactionsAutoCeiling` / `compactionsAutoOverflow` /
`compactionsAutoCheckpoint` / `compactionsManual`, and `checkpoints` /
`checkpointEscalations` — how many run-progress checkpoints the run evaluated and
how many of them escalated to a developer question. A run that evaluates none
carries zero, so "no run above its soft threshold without a checkpoint" is
answerable from the settled envelope alone.

The run-progress checkpoint (efficiency backlog item 19) reports itself with two
envelopes, both content-free: `runtime.checkpoint` carries `herdr.checkpoint.*` —
ordinal, trigger, class, the read-only flag, turns, cost units, context and peak
context, the thresholds in force, the signals present, the counters behind them,
the window, the sampled diff and ticked tasks, the decision with its rule, whether
it was applied, the decider, the latency, whether the record was written, and
`status` / `error_class` when it failed open — and `runtime.checkpoint_escalation`
carries the escalation's `outcome` (`answered`, `cancelled`, `pending-parked`,
`filing-failed`) and the question id. See
[`workflow-architecture.md`](./workflow-architecture.md#the-run-progress-checkpoint-efficiency-backlog-item-19).

The session window (efficiency backlog item 20) records which run a durable
conversation was bound to, because one conversation serves every later run of the
same step and role:

| Event | Fields |
| --- | --- |
| `runtime.session_window.opened` | `herdr.session.reason` (`created`, `rebound`, `adopted` or `resumed`), `herdr.session.previous_run_id` for `rebound`, and `herdr.session.conversation_id` |
| `runtime.session_window.closed` | `herdr.session.rebound_to` (the run now bound) and `herdr.session.conversation_id` |

Both name the run they belong to in the envelope's ordinary `runId`, so a
conversation's move is readable per run; the conversation id travels as
`herdr.session.conversation_id` and *not* as `sessionId`, which the parser maps to
`herdr.session.id` — the run id — and one attribute must never carry two
identifier spaces. Nothing here writes workflow state: the envelopes are
observational, and `stopRun` never emits a `closed` for the run it stops (a run is
not closed when its session continues).

A `closed` is the one envelope a reader takes as proof that a session continued,
so its writer reports whether the append happened: a close that could not be
written to the leaving run's telemetry path (its workspace is gone, the path is
unwritable) is retried into the binding that now holds the conversation, and on
that conversation's later bindings while it stays unwritten, and is written once.
The transition is serialized per conversation — read the previous binding, drain
the stream for one macrotask turn so a frame the leaving run already committed is
still theirs, write the new binding — so two overlapping rebindings cannot close
one run twice or leave the last run open. `runtime.tool` is emitted under the run
that *started* the call, not the run bound when the call finished.

The token movement is measured, never invented: `pi-durable` records no counters
for a compaction, so `tokensBefore` is the newest request's prompt tokens
(input + cache read/write) before it started and `tokensAfter` is attached only
when a later generation's request is genuinely smaller. `outcome` is `failed`
for a correlated `pi.compaction` `task_failed`, `completed` when a summary entry
was placed, and `aborted` otherwise (a cancellation — `/abort` cancels a manual
compaction, which is a non-background conversation-owned task — places no
summary). No summary text ever reaches an envelope.

### Tool-call fields (`runtime.tool_start` / `runtime.tool`)

Every durable tool call is measurable without a payload. `tool_start` states
what was asked and `tool` states how it ended; both carry fixed-size fields only
(`src/agent-host/tool-telemetry.ts` builds them):

| Envelope | Field | Meaning |
| --- | --- | --- |
| both | `pi.tool.name`, `pi.tool.call_id` | which tool, which call (the pair joins the two envelopes) |
| `tool_start` | `pi.tool.args_hash` | the argument JSON, SHA-256 hashed to 16 hex characters: exact repeats join on it |
| `tool_start` | `pi.tool.args_digest` | the call's identity in at most 200 characters: a path for a file tool, a search path and pattern, or a shell command's first 120 characters, each secret-free |
| `tool_start` | `pi.tool.argument_bytes` | byte length of the argument JSON — a size, not the content |
| both | `pi.turn.index` | the turn of this conversation the call belongs to (absent before the first turn) |
| `tool` | `pi.tool.ok` | the explicit outcome: `true` or `false` for every call, successful or not |
| `tool` | `pi.tool.duration_ms` | wall-clock time between the call's start and end |
| `tool` | `pi.tool.result_bytes`, `pi.tool.result_lines`, `pi.tool.result_truncated` | the size of the text the model received and whether the harness retained only part of it |
| `tool` | `pi.tool.failure_kind` | on failure only: `not-found`, `no-match`, `denied`, `host-error`, `timeout`, `aborted`, `invalid-args` or `other` |
| `tool` | `pi.tool.mutated` | on a call that can change the worktree (`edit`, `write`): the run-progress checkpoint reads it as progress |

Every envelope of a `pi-durable` run additionally carries `herdr.run.generation`
when the run environment names one, so a re-launched run is identifiable.

`pi.tool.failure_kind` is derived from the tool result's own text and diagnostic
codes and is a code, never prose: `host-error` means no result entry survived at
all (the tool task faulted or was orphaned), which the older `tool_error`/
`error` vocabulary could not separate from a missing file or a failed edit. The
argument digest is redacted at the point it is built — environment-assignment
values, `Authorization` headers, bearer/`sk-`/`ghp_`/`AKIA` style tokens, URL
userinfo and `-p`/`--password`/`--token` values — and the result text is read
only to classify it: no tool argument, command, file content or result text ever
enters an envelope. The optional raw `herdr.content.tool_input` capture is
unchanged and still requires `HERDR_CAPTURE_CONTENT=1`; the digest is emitted
whether or not content capture is on, so the shape survives capture being off.

## Not captured

- system prompts and thinking/reasoning parts
- images and other non-text content parts
- streaming updates (only the completed message/part is recorded)
- session content while `telemetry.capture_content = false` (bounded metadata,
  including content-free routing telemetry, remains enabled)
