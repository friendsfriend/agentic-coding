## Context

`pi/extensions/herdr-telemetry.ts` currently appends lifecycle, provider, usage, and error events to `.herdr-workflow/<change>/telemetry.jsonl`. `pi/bin/herdr-workflow` appends controller events to the same file. Events share change and role fields but have no trace/span identifiers, parentage, or stable user-message correlation. `agent-dash` therefore shows only a short flat event list.

Herdr agents are long-lived Pi processes. A controller cannot update their environment for every prompt, while Pi exposes user-message, model-turn, and tool lifecycle hooks. Verification also crosses process boundaries when an agent invokes `herdr-workflow`, which then prompts other role agents.

## Goals / Non-Goals

**Goals:**

- Relate every instrumented model turn and tool execution to one Pi user-message span.
- Preserve parentage across workflow CLI and role-agent boundaries, including parallel verifier branches.
- Export interoperable OTLP/HTTP JSON and retain local traces when no collector is running.
- Provide useful trace navigation both inside `agent-dash` and through standalone `otel-tui`.
- Keep telemetry best-effort, bounded, and content-safe by default.

**Non-Goals:**

- Full OpenTelemetry Collector replacement.
- OTLP/gRPC, OTLP protobuf, metrics, or log ingestion in first version.
- Durable indexed trace storage, distributed querying, authentication, or remote multi-user hosting.
- Capturing model text, tool arguments, tool results, or repository content by default.

## Decisions

### 1. Use standard trace context and OTLP JSON without new dependencies

Emit W3C `traceparent` values and OTLP/HTTP JSON envelopes using Bun/Node `crypto` and `fetch` in TypeScript plus Python standard library HTTP support. Use established `gen_ai.*` semantic attributes where they fit and `herdr.*` attributes for workflow identity, role, phase, message ID, and verification round.

OTLP destination follows standard environment precedence: `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, then `OTEL_EXPORTER_OTLP_ENDPOINT` plus `/v1/traces`, then local `http://127.0.0.1:4318/v1/traces`. Export has a short timeout and never changes command or agent outcome.

Alternative considered: add OpenTelemetry SDK packages. Rejected because two runtimes still need instrumentation/propagation glue, while required trace subset and JSON transport are small.

### 2. Make each Pi user message an agent-operation span

At `before_agent_start`, extension resolves current Pi session ID and leaf user entry ID. That stable entry ID becomes `herdr.message.id`; generated operation span becomes parent for model-turn and tool-execution spans until `agent_settled`.

If role prompt has controller context, operation span continues supplied trace. Otherwise it starts new trace, covering direct developer messages too. Prompt content is not recorded by default. Optional content capture records only bounded preview; IDs, hash, byte length, role, change, and operation label remain available without content.

Alternative considered: one trace for entire workflow lifetime. Rejected because multi-day trace would remain open and user-message causality would be obscured.

### 3. Propagate across Bash and long-lived role processes

Extension creates tool span at `tool_execution_start`. During `tool_call`, Bash commands receive that span's `TRACEPARENT`, allowing nested `herdr-workflow` commands to continue exact tool branch without global environment races between parallel tools.

Before controller prompts role agent, it atomically writes short-lived, one-use context under `.herdr-workflow/<change>/trace-context/<role>.json`, containing downstream traceparent, generated message ID, operation label, and workflow attributes. Role extension consumes and removes matching fresh context at next `before_agent_start`; missing, expired, or malformed context starts independent trace instead of attaching stale work.

Controller commands emit their own action spans and pass child context through prompt sidecars. This links dashboard/CLI action → triage → dispatch command → parallel verifier messages → verification-result commands → test verifier or worker fix. Verification round, phase, change, and role attributes make retries filterable.

Alternative considered: include trace context in agent prompt text. Rejected because it spends model tokens and exposes transport metadata to agent.

### 4. Keep existing events and add normalized local span spool

Existing `telemetry.jsonl` remains for current summaries and compatibility. Ended spans also append as one normalized JSON object per line to `.herdr-workflow/<change>/traces.jsonl`; OTLP export uses same record converted to resource/scope/span envelope. Malformed lines are ignored by readers.

Local spool makes historical workflow traces available even when viewer was not running. It is intentionally append-only and workflow-scoped; archiving/cleanup follows existing `.herdr-workflow` lifecycle.

Alternative considered: require viewer/collector to run before workflow. Rejected because losing early planner spans makes dashboard integration unreliable.

### 5. Share one trace model/browser between dashboard and standalone executable

Add shared decoder that accepts normalized JSONL records and OTLP/HTTP JSON request bodies, normalizes attributes, groups spans by trace ID, and builds parent/child rows. Shared Solid/OpenTUI components provide trace list, span tree, selected-span timing/status/attributes, text filter, and live refresh.

`agent-dash` replaces flat trace detail with shared browser loaded from selected workflow's `traces.jsonl` and prefiltered by `herdr.change.id`. `otel-tui` runs same browser plus Bun HTTP receiver on loopback port 4318. It supports `--host`, `--port`, bounded `--max-spans`, and optional `--file` import/tail for standalone use with other apps.

Alternative considered: shell out from dashboard to separate viewer. Rejected because shared in-process browser gives history without requiring another process while executable remains independently usable.

### 6. Bound and validate receiver input

Standalone receiver binds `127.0.0.1` by default, accepts only `POST /v1/traces` with OTLP JSON content type, limits request size and retained span count, validates required IDs/timestamps, and returns OTLP-style partial-success/error responses without crashing TUI. Non-loopback bind requires explicit `--host`; viewer documents that it has no authentication.

## Risks / Trade-offs

- **JSON-only OTLP excludes default protobuf exporters** → document `http/json` client configuration; add protobuf only when real clients require it.
- **Short exporter timeout can drop remote spans** → local span spool remains authoritative for managed workflows.
- **Context sidecar can outlive failed prompt dispatch** → atomic one-use files carry expiry and are removed on failed dispatch or ignored when stale.
- **Append-only files grow during long workflows** → viewer reads bounded tail; add rotation only after measured growth warrants it.
- **Parallel actions can finish out of order** → hierarchy uses IDs and timestamps, never file order.

## Migration Plan

1. Add trace helpers and local spool while retaining existing event writes.
2. Add propagation sidecars and instrument controller/extension actions.
3. Add shared decoder/browser and switch dashboard trace detail to it.
4. Build/install `otel-tui` beside `agent-dash`; document OTLP JSON endpoint and privacy controls.
5. Rollback by removing new tracing/viewer paths; legacy `telemetry.jsonl` and workflow state remain compatible.

## Open Questions

None. Initial scope deliberately uses traces plus OTLP/HTTP JSON; protobuf, metrics, logs, and indexed persistence wait for demonstrated need.
