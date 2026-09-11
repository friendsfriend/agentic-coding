# Emitted event and attribute catalog

Recorded for task 8.4. Every field below travels at the envelope top level (or
inside the named `attributes` object) and is mapped to a span attribute by
`src/tui/otel/model/parser.ts`. Numeric and boolean values stay typed.

## Engine layer (`layer: "engine"`)

Reserved identity on every event: `workflowId` → `herdr.change.id`, `stepId` →
`herdr.step.id`, `role` → `herdr.role`, `runId` → `herdr.run.id`, `effectId` →
`herdr.effect.id`, `profile` → `herdr.profile`, `runtime` → `herdr.runtime`,
`sessionId` → `herdr.session.id`, `outcome` → `herdr.outcome`. Every payload
also carries `herdr.revision` and `herdr.status`.

| Event | Payload |
| --- | --- |
| `workflow.started` | `herdr.definition.id/version`, `herdr.metadata.change.id` (the parser's `herdr.change.id` is the workflow id), `herdr.repository`, `herdr.repository.independent`, `herdr.task.length`, `herdr.branch`, `herdr.base.commit` |
| `agent.handoff` | `outcome`, `durationMs` (run wall clock), `herdr.run.attempt`, `herdr.handoff.outcome`, `herdr.artifact.digest`, `herdr.artifact.bytes`, `herdr.evidence.count`, `herdr.findings.critical` |
| `effect.result` | `outcome`, `durationMs` (measured handler wall clock), `herdr.effect.kind`, `herdr.effect.attempt`, `herdr.effect.max_attempts`, `herdr.error.class` (redacted). No `herdr.run.attempt`: no run is resolved for an effect. |
| `developer.question.*`, `agent.question.*` | `herdr.question.id`, `herdr.asking.role`, `herdr.option.count`, `herdr.answer.kind`, `herdr.answer.outcome`, `herdr.answered.by`, `herdr.timeout`, `durationMs` (wait) |
| `developer.action` | `herdr.action.id`, `herdr.step.before`, `herdr.step.after` |
| `operator.repair` | `herdr.step.from`, `herdr.step.to`, `herdr.reason.length` |
| `operator.migrate` | `herdr.version.from`, `herdr.version.to`, `herdr.reason.length` |
| `operator.repin` / action `re-pin` | `herdr.digest.from`, `herdr.digest.to` |
| `research.handoff.recorded` | `herdr.directives.count`, `herdr.citations.count` |
| `effect.exhausted` (new export) | `outcome: "error"`, `herdr.effect.kind`, `herdr.effect.attempt`, `herdr.effect.max_attempts`, `herdr.error.class`, `herdr.attention.count` |
| `legacy.migrated` (new export) | `herdr.source.version`, `herdr.migration.phase`, `herdr.workflow.type` |
| `workflow.rollup` (new, once per terminal transition) | `herdr.verification.rounds`, `herdr.revision.count`, `herdr.run.count`, `herdr.agent.count`, `herdr.questions.count`, `herdr.attention.count`, `herdr.effect.attempts`, `herdr.current.step` |

## Adapter layer (`layer: "adapter"`)

Identity on every event: `runId`, `stepId`, `role`, `profile`, `runtime`,
`sessionId`, `effectId`, `herdr.run.attempt`.

| Event | Payload |
| --- | --- |
| `agent.launch.attempt` | — |
| `agent.launch` | `outcome`, `durationMs`, `herdr.error.class`, `herdr.cancelled` |
| `agent.assignment.delivered` | `outcome`, `durationMs`, `herdr.delivery` (`"reused"` for a reused live pane) |
| `agent.error` | `outcome: "error"`, `durationMs`, `herdr.error.class` |
| `agent.stop` | `outcome` |

## pi bridge (`layer: "runtime"`, `runtime: "pi"`)

Identity comes from the handler's `ExtensionContext` (`ctx.sessionManager.getSessionId()`,
`ctx.model`, `ctx.thinkingLevel`) because the pi `ExtensionAPI` exposes no
`session`/`model` properties. Every event carries `sessionId`, `pi.model`,
`pi.provider`, `pi.thinking`, and `pi.turn.index`.

Hooks: `agent_start`, `turn_start`, `turn_end`, `tool_execution_start`,
`tool_execution_end`, `before_provider_request`, `after_provider_response`,
`session_before_compact`, `session_compact`, `model_select`, `agent_settled`,
`message_start`, `message_end`.

| Event | Payload |
| --- | --- |
| `runtime.started` | turn identity |
| `runtime.turn_started` | turn identity |
| `runtime.settled` | `pi.context.percent/tokens` (from `ctx.getContextUsage()`), `pi.session.turns/tool_calls/tool_errors/input_tokens/output_tokens/cache_read_tokens/cache_write_tokens/cost` |
| `runtime.tool` | `outcome`, `pi.tool.name/call_id/outcome/duration_ms` (per-call start bookkeeping), `pi.tool.argument_bytes` (captured at `tool_execution_start`), `pi.tool.result_bytes`, `pi.error.class: "tool_error"` (never result content) |
| `runtime.usage` | `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `cost`, `durationMs`, `tokensPerSecond` |
| `runtime.provider_response` | `pi.provider.status`, `pi.provider.latency_ms` (measured from `before_provider_request`), `pi.error.class: "http_<status>"`, `outcome: "error"` on non-success |
| `runtime.turn` | `pi.turn.index`, `pi.turn.duration_ms`, `pi.turn.tool_calls`, `pi.turn.tool_errors` |
| `runtime.model_selected` | `pi.model`, `pi.model.previous`, `pi.model.source` |
| `runtime.compaction` | `pi.compaction.tokens_before` (`compactionEntry.tokensBefore`), `pi.compaction.tokens_after` (`ctx.getContextUsage().tokens`), `pi.compaction.duration_ms` (measured across `session_before_compact`), `pi.compaction.automatic` (`reason !== "manual"`) |

`tool_execution_update` and `message_update` stay unwired: no streaming rows.

## opencode bridge (`layer: "runtime"`, `runtime: "opencode" | "opencode-v2"`)

| Event | Payload |
| --- | --- |
| `runtime.step_finish` | `oc.cost`, `oc.tokens.input/output/reasoning/cache_read/cache_write`, `oc.finish.reason`, `oc.step.duration_ms` (measured from the `step-start` part) |
| `runtime.tool` | `oc.tool.name/call_id/status/duration_ms/input_bytes/output_bytes`, `oc.error.class`, `outcome: "error"` |
| `runtime.part_length` | `oc.part.type`, `oc.part.length` (text/reasoning length only) |
| `runtime.retry` | `oc.retry.attempt`, `oc.retry.reason` |
| `runtime.compaction` | `oc.compaction.automatic` |
| `runtime.session_status` | `oc.session.status`, `oc.retry.attempt/delay_ms/reason` |
| `runtime.session_error` | `outcome: "error"`, `oc.error.class`, `oc.error.retryable` |
| `runtime.permission_request` / `runtime.permission_reply` | `oc.permission.id/type/patterns/duration_ms/reply` |
| `runtime.todos` | `oc.todo.total/pending/in_progress/completed/cancelled` |
| `runtime.diff` | `oc.diff.files/additions/deletions` |
| `runtime.message` | `oc.model`, `oc.provider` |

Dropped at the bridge: `pty*`, `tui*`, `server*`, `installation*`, `lsp*`,
`file.watcher*`. Both variants share identical logic and differ only in the
`runtime` value.

The `?` help and footer keybind catalogs are untouched by this change; the
existing keybind tests plus the parser/ingest tests stand in for the manual TUI
inspection of task 8.3.
