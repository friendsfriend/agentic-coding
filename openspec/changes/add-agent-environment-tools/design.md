# Design

## Context

The orchestrator already uses this pattern: `orchestratorTokenFor` derives a
narrower capability, `AGENTIC_ORCHESTRATOR_URL/TOKEN` reach the durable host via
the run env file, and tools call the server over HTTP. Dialogue tools shell out
to the workflow CLI instead; environment tools use HTTP because the server owns
instances.

## Goals / Non-Goals

**Goals:** least-privilege agent access; one tool surface for all runtimes;
bounded, redacted output.

**Non-Goals:** browser and debug tools (changes 8, 9), human TUI flows.

## Decisions

- **Capability.** `environmentTokenFor(instanceToken, owner)` =
  `HMAC(instanceToken, "env:" + owner)`, presented with header
  `X-Agentic-Env-Owner`; the server recomputes and compares in constant time.
  Survives server restart only if the instance token does (same as the
  orchestrator capability).
- **Owner assignment.** The workflow engine sets owner `workflow:<id>` for all
  runs of a workflow, including debug sub-agent runs (so implementation,
  verifiers and debug requests share instances).
- **Long operations.** `env_start`/`env_build`/`env_test` block up to a bounded
  timeout (default 10 min, tool `timeoutSec` arg ≤ 30 min) and stream nothing;
  on timeout they return the run id and current step tree summary, and
  `env_status` continues. Aborting the tool call does not abort the run.
- **Logs.** Docker logs via the Engine API, script logs from the log file,
  Kubernetes via `kubectl logs` planners; `grep` is a substring/regex filter
  applied server-side; `tail` default 200 lines.
- **Redaction.** A server-side redactor built from config `.env` values (≥ 6
  chars) and secret/ephemeral action values; applied to every agent-route
  response body.
- **Replay.** Tools are not replayed after a host crash (`replay` unsafe), like
  the dialogue tools; the agent re-queries status.

## Risks / Trade-offs

- [Agents still have bash and can run `docker` directly] → accepted; the
  protocol instructions direct them to the tools, and instance teardown is
  unaffected by stray containers outside instances.
- [Redaction misses short secrets] → minimum length avoids false positives;
  documented.
