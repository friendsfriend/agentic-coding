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
  `HMAC(instanceToken, "agentic-coding:environment:v1:" + owner)`, presented
  with header `X-Agentic-Env-Owner`. The server recomputes and compares in
  constant time. The `agentic-coding:<role>:v1:` domain is the one the
  orchestrator sibling already uses, so a capability can never be replayed
  across surfaces.
- **Owner assignment.** Every run of a workflow, including debug sub-agent
  runs, gets `workflow:<id>`. Implementation, verifiers and debug requests
  therefore share the workflow's apps.
- **Blocking start.** The tool loops acquire calls with `waitSec = 300` until
  granted, `deadlock`, `released-by-developer`, `cancelled`, abort, or
  `timeoutSec`. Between polls it emits a tool progress update ("waiting for
  customer-mw, position 1, held by workflow X"). Abort stops the loop **and**
  ends the server-side wait: the request's signal reaches the controller, which
  withdraws the queue entry instead of leaving an abandoned long poll that could
  still commit a start. A wait whose request disappears therefore also leaves
  the entry after its 60 s grace. The tool is not replayed after a host crash
  (`replay` unsafe); the agent simply calls it again.
- **One copy per app.** An app's slot is exclusive whatever the runtime
  (`make-app-runs-exclusive`), so `env_start` accepts `replicas` only as 1 and
  refuses anything else with that reason; `runtime` selects a target, never a
  second copy.
- **Start all at once.** The tool description and protocol instructions tell
  agents to name every app they need in one `env_start`, so the server can
  grant atomically and detect deadlocks.
- **Build/test need no slot.** They run in the workflow checkout and produce
  artifacts; only `run` occupies an app.
- **Logs.** Docker logs come from the Engine API, script logs from the log
  file, Kubernetes logs through the `kubectl logs` planners. `grep` is a
  **literal substring** filter applied server-side — never a compiled regular
  expression, because the pattern is caller-supplied and the server runs one
  shared event loop (a pattern such as `(a+)+$` against a long line would stall
  every other client); `tail` defaults to 200 lines. Every source is bounded
  before it is read rather than after: a script log is read from its last bytes,
  docker fan-out is capped and fetched in parallel, and the kubernetes reader is
  given a per-pod tail and a total character budget.
  Logs are readable whoever holds the app, because the routing is static and a
  reader may want to see the current holder's run. Reading is activity only on
  the reader's own held apps: one workflow's read never keeps another's run
  alive.
- **Redaction.** A server-side redactor built from config `.env` values and
  secret/ephemeral action values, applied to every agent-route response body and
  to error text. A value at least 6 characters long is replaced wherever it
  appears; a shorter declared value is replaced in the one form that names it
  (`NAME=value`), so no declared secret survives while ordinary output stays
  readable.

## Risks / Trade-offs

- [Agents still have bash and can run `docker` directly] → accepted. The
  protocol instructions direct them to the tools, and a stray `docker compose
  up` of a held app fails on the static container name anyway.
- [Very long waits] → `timeoutSec` returns control to the agent, which can do
  other work or hand off with a note. The developer sees the wait toast.
