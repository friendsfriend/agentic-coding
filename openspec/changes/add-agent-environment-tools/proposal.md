# Proposal

## Why

Instances exist server-side, but durable agents cannot use them: they have only
coding tools, dialogue tools and `ask_jev`. Shelling out to `docker`/`kubectl`
would bypass ownership, caps, leases and cleanup. Agents need first-class tools
that act only on their own owner's instances.

## What Changes

- A per-run **environment capability**: HMAC of the instance token bound to the
  run's owner (`workflow:<id>`), passed to the
  durable run as `AGENTIC_ENV_URL` / `AGENTIC_ENV_TOKEN`. The server derives the
  owner from the token; a request can never name another owner.
- Agent routes under `/api/v1/agent-env/*` accepting only that capability.
- A pi-durable extension `agentic.environment` installed for **every** durable
  run (read-only runs included, because these tools do not write source):
  - `env_list` — apps, run/build/test targets, own instances;
  - `env_start({app, target?, profile?, runtime?, replicas?})` — returns
    instance, endpoints, or queue position;
  - `env_status({app?})`, `env_stop({app})`;
  - `env_build({app, target?})`, `env_test({app, target?})` — run build/test
    actions against the owner's checkout, returning bounded output;
  - `env_logs({app, service?, infra?, since?, grep?, tail?})`.
- Output bounded (`MAX_OUTPUT_CHARS`) and redacted: values from the config
  `.env` and secret action values are replaced with `«redacted:NAME»`.
- Every call touches instance activity.

## Capabilities

### New Capabilities

- `agent-environment-tools`: owner-scoped capability, agent routes, and the
  `env_*` tool contract.

## Impact

- `src/server/auth.ts` (`environmentTokenFor`), new
  `src/server/environment/agent-routes.ts`, `src/agent-host/environment-tools.ts`,
  `src/agent-host/host.ts` (install extension), workflow run env assembly
  (`src/workflow/run-env.ts` callers) to pass URL/token.
- Instruction `agent-definitions/instructions/workflow-agent-protocol.md`: short
  section on environment tools and Docker-first guidance.
- Depends on `add-environment-instances`, `add-environment-instance-lifecycle`.
