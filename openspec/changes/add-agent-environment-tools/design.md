# Design

## Context

The orchestrator already uses this pattern: `orchestratorTokenFor` derives a
narrower capability, `AGENTIC_ORCHESTRATOR_URL/TOKEN` reach the durable host
through the run env file, and tools call the server over HTTP. The acquire
route long-polls for up to 300 s per request (`make-app-runs-exclusive`).

## Goals / Non-Goals

**Goals:** least-privilege agent access; one tool surface for all runtimes;
waiting costs no model turns; bounded, redacted output.

**Non-Goals:** browser and debug tools (later changes), human TUI flows.

## Decisions

- **Capability.** `environmentTokenFor(instanceToken, owner)` =
  `HMAC(instanceToken, "env:" + owner)`, presented with header
  `X-Agentic-Env-Owner`. The server recomputes and compares in constant time.
- **Owner assignment.** Every run of a workflow, including debug sub-agent
  runs, gets `workflow:<id>`. Implementation, verifiers and debug requests
  therefore share the workflow's apps.
- **Blocking start.** The tool loops acquire calls with `waitSec = 300` until
  granted, `deadlock`, `released-by-developer`, abort, or `timeoutSec`. Between
  polls it emits a tool progress update ("waiting for customer-mw, position 1,
  held by workflow X"). Abort stops the loop. The server withdraws the entry
  after its 60 s grace. The tool is not replayed after a host crash
  (`replay` unsafe); the agent simply calls it again.
- **Start all at once.** The tool description and protocol instructions tell
  agents to name every app they need in one `env_start`, so the server can
  grant atomically and detect deadlocks.
- **Build/test need no slot.** They run in the workflow checkout and produce
  artifacts; only `run` occupies an app.
- **Logs.** Docker logs come from the Engine API, script logs from the log
  file, Kubernetes logs through the `kubectl logs` planners. `grep` is a
  substring/regex filter applied server-side; `tail` defaults to 200 lines.
  Logs are readable whoever holds the app, because the routing is static and a
  reader may want to see the current holder's run.
- **Redaction.** A server-side redactor built from config `.env` values (6
  chars or longer) and secret/ephemeral action values, applied to every
  agent-route response body.

## Risks / Trade-offs

- [Agents still have bash and can run `docker` directly] → accepted. The
  protocol instructions direct them to the tools, and a stray `docker compose
  up` of a held app fails on the static container name anyway.
- [Very long waits] → `timeoutSec` returns control to the agent, which can do
  other work or hand off with a note. The developer sees the wait toast.
