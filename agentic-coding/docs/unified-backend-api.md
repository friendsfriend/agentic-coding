# Unified Bun backend API

`expose-unified-bun-backend` introduces one authenticated Bun server process that
owns the workflow application, observations, event delivery and (eventually)
telemetry, and delegates unported environment routes to a private Go child. The
TUI and CLI reach it through a typed client rather than in-process or subprocess
backend access.

## Composition and lifecycle

- `src/server/lifecycle.ts` is the named composition root. `startWorkflowServer`
  binds `127.0.0.1` (loopback only), generates a per-instance capability token
  and returns an `OwnedWorkflowServer` the owner releases exactly once.
- `agentic-coding server` starts the Go environment child
  (`startOwnedBackend`) and then the Bun workflow server, delegating
  `/api/v1/environment/*` to the child. A signal stops both.
- The unified TUI starts and owns the same Bun server once the private Go child
  (and therefore its token) exists, configures `BackendClient`, and releases the
  listener through the shell resource registry. Test mode keeps the
  deterministic in-process demo path with no server.

## Authorization and bounds

- `src/server/auth.ts` generates a 32-byte instance token and requires
  `Authorization: Bearer <token>` on every Bun route. Loopback binding is never
  the authorization decision.
- Browser `Origin` headers are restricted to loopback hosts; a foreign origin is
  rejected before routing (so it can never delegate an environment mutation).
- `.env`-style request bodies are bounded (`MAX_REQUEST_BYTES`), declared
  `content-length` is checked before reading, paths are bounded
  (`MAX_PATH_CHARS`) and control characters are rejected. Diagnostics never echo
  a supplied capability, body or secret.
- The private Go listener requires `X-Instance-Token` on every route except
  `/api/health` whenever `DEVENV_INSTANCE_TOKEN` is set. The Bun spawn passes a
  fresh token; `corsMiddleware` no longer emits a wildcard origin.

## Route ownership

`ROUTE_OWNERSHIP` in `src/server/protocol.ts` is the static manifest. `bun`
routes are served in-process; `go` routes are delegated to the private child.
There is no router/plugin framework.

| Method | Path | Owner |
| --- | --- | --- |
| GET | `/api/v1/health` | bun |
| POST | `/api/v1/observe` | bun |
| GET | `/api/v1/workflow/view` | bun |
| POST | `/api/v1/workflow/action` | bun |
| POST | `/api/v1/workflow/start` | bun |
| POST | `/api/v1/workflow/repair` | bun |
| POST | `/api/v1/workflow/question` | bun |
| POST | `/api/v1/workflow/review-save` | bun |
| POST | `/api/v1/workflow/execute` | bun |
| POST | `/api/v1/agent/handoff` | bun |
| POST | `/api/v1/agent/question` | bun |
| POST | `/api/v1/agent/research-handoff` | bun |
| POST | `/api/v1/config/agents` | bun |
| GET | `/api/v1/config/agents` | bun |
| GET | `/api/v1/events` | bun |
| GET | `/api/v1/telemetry/snapshot` | bun |
| POST | `/api/v1/telemetry/scan` | bun |
| POST | `/api/v1/telemetry/prune` | bun |
| POST | `/api/v1/credentials/respond` | bun |
| GET/POST | `/api/v1/environment/private/*` | bun |
| GET/POST | `/api/v1/environment/*` | go |

Reads remain observational: the observation dispatcher only lists/reads/views and
never initializes or migrates a store, expires a question or claims an effect.

### Environment ownership

`/api/v1/environment/private/state` is the bounded private operation envelope the
remaining Go services use for environment state and configuration once Bun owns
them (see [`environment-state-port.md`](environment-state-port.md)). It carries one
logical operation per request — no SQL, table or column ever crosses the wire —
and is served from Bun's own authority without an outbound request, so it cannot
recurse back into the delegated Go child.

## Events

`src/server/events.ts` publishes `EventEnvelope`s carrying instance, monotonic
sequence, domain, resource/run and revision. A bounded ring retains
`EVENT_REPLAY_CAPACITY` events. A reconnect cursor inside the window replays the
gap; a cursor that is too old (or ahead of the instance) makes the server emit
`event: resync`, requiring an authoritative snapshot instead of silently
continuing. A slow subscriber overflows its bounded queue to a resync request
rather than blocking mutation execution.

`src/server/subscriptions.ts` is the server-owned refresh source: it subscribes
to Herdr lifecycle events and to each repository's execution coordinator and
publishes `workflow.updated`, so dashboards refresh from the stream instead of a
local Herdr socket or `fs.watch`.

## Credentials

`src/server/credentials.ts` binds a credential interaction to the authenticated
owner that started it. Only that owner can answer; a different owner, an unknown
interaction or an expired one is rejected without using the supplied value. A
disconnect or timeout resolves the interaction to an empty answer within its
bound. Prompts and answers never enter a durable record or an event payload.

## Client

`src/server/client.ts` is the only transport the TUI/CLI uses. The dashboard
observation path (`src/tui/dash/observations.ts`) reads through it and no longer
spawns `__dashboard-observe`; the subprocess protocol is removed. A shell exports
`AGENTIC_WORKFLOW_URL`/`AGENTIC_WORKFLOW_TOKEN` to its managed child processes, so
`workflow status`/`projects` read through the same authenticated boundary.

Managed-agent `workflow handoff`, `question` and `research-handoff` forward the
authenticated caller environment to `/api/v1/agent/*`. The instance session token
and the engine-validated run capability are both required, so the developer
session and the agent run remain distinct authorities.

## Migration status

Implemented by this change:

- Typed contracts + route manifest, instance authorization, origin/method/body/
  path bounds, private Go token.
- Bun server composition root, `server` mode, TUI-owned listener + typed client.
- Observation read/artifact transport through the API; `__dashboard-observe`
  removed.
- Bounded event envelope, replay/resync and credential request/reply transport
  with focused tests.
- Dashboard reads/mutations (observations, actions, repair, questions, review
  saves, execution trigger) through the typed client.
- Server-owned telemetry persistence: SQLite database, workspace scanning,
  retention and file watcher (`src/server/telemetry.ts`) with typed
  snapshot/scan/prune endpoints; the TUI reads via `RemoteTelemetryDb`.
- Server-owned telemetry receivers: OTLP/Zipkin/Datadog HTTP listeners, the
  gRPC helper, the Prometheus scraper and the StatsD listener
  (`src/server/receivers.ts`) route decoded signals into a shell-injected sink.

Not yet migrated (remaining backlog, kept explicit rather than silently dropped):

- The environment-state/config port (`port-project-catalog-and-state-to-bun`) is
  in progress: Bun owns `$DEVENV_HOME/db/state.db` and the configured environment
  (definition files, catalog projection) by default, the Go child reaches both
  through the bounded private operations and opens no database handle, and the
  remaining Go-served environment routes (`/api/v1/environment/*`) are still
  delegated until those services are ported. See
  [`environment-state-port.md`](environment-state-port.md).
- The remaining CLI admin/mutation commands (`action`, `repair`, `migrate`,
  `repin`, `agent-extension`, `sidebar`) and the `config` read run at the CLI's
  own in-process application boundary; the agent commands, reads and full-feature
  attach are on the typed boundary.
- Renderer-suspension and the full lost-mutation/two-client acceptance suites
  are covered at the server level (tasks 4.1/4.2/4.3); the interactive terminal
  journeys remain for the test-verifier.

## Rollback gate

Rollback is only safe at a quiescent boundary with one application owner: stop
the TUI/server stack through the owned resource registry so the Go child and Bun
listener release in reverse order, then check out the pre-change revision. No
schema, workflow pin, store migration or durable workflow data is changed by this
transport extraction, so an older revision can read the same stores.

For the environment-state ownership change the gate is stricter: the two
generations are selected explicitly (`DEVENV_ENVIRONMENT_OWNER`, default `bun`,
`go` to roll back) and never run as writers at once. An upgrade to an older
schema leaves a verified `state.db.backup-v<N>` produced with `VACUUM INTO`, a
newer schema fails closed without modification, and an interrupted migration is
committed or rolled back as a whole — never a mix of both.
