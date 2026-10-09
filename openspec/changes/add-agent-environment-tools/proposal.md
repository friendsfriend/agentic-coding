# Proposal

## Why

Apps now run once at a time (`make-app-runs-exclusive`), but durable agents
cannot use that: they have only coding tools, dialogue tools and `ask_jev`.
Shelling out to `docker` or `kubectl` would bypass the app slot, the wait
queue and release. Agents need first-class tools that act as their own
workflow and wait for busy apps without burning tokens.

## What Changes

- A per-run **environment capability**: an HMAC of the instance token, bound
  to the run's owner (`workflow:<id>`). It reaches the durable run as
  `AGENTIC_ENV_URL` / `AGENTIC_ENV_TOKEN`. The server derives the owner from
  the token, so a request can never name another owner.
- Agent routes under `/api/v1/agent-env/*` that accept only that capability.
- A pi-durable extension `agentic.environment`, installed for **every** durable
  run. Read-only runs get it too, because these tools do not write source.
  - `env_list` — apps, run/build/test targets, and who holds or waits for each
    app.
  - `env_start({apps: string[] | app, target?, profile?, runtime?, replicas?,
    timeoutSec?})` — **blocks** until every named app is started for this
    workflow. It long-polls the acquire route, keeps its queue position, and
    sends a progress update with position and holder. On `timeoutSec`
    (default 30 min, max 2 h) it returns `still-waiting` with the queue
    position; calling it again keeps the position. A wait that would deadlock
    returns `deadlock` immediately.
  - `env_status({app?})`, `env_stop({app})`.
  - `env_build({app, target?})`, `env_test({app, target?})` — run build/test
    actions against the workflow's checkout and return bounded output. They
    need no slot.
  - `env_logs({app, service?, infra?, since?, grep?, tail?})`.
- Output is bounded (`MAX_OUTPUT_CHARS`) and redacted: values from the config
  `.env` and secret action values become `«redacted:NAME»`.
- Every call touches app activity.

## Capabilities

### New Capabilities

- `agent-environment-tools`: owner-scoped capability, agent routes, and the
  `env_*` tool contract including the blocking wait.

## Impact

- `src/server/auth.ts` (`environmentTokenFor`), new
  `src/server/environment/agent-routes.ts`, `src/agent-host/environment-tools.ts`,
  `src/agent-host/host.ts` (install the extension), and workflow run env
  assembly (callers of `src/workflow/run-env.ts`) to pass URL and token.
- Instruction `agent-definitions/instructions/workflow-agent-protocol.md`: a
  short section on environment tools, Docker first, starting every needed app
  in one call, and stopping apps when done because others may be waiting.
- Depends on `make-app-runs-exclusive` and `add-environment-instance-lifecycle`.
