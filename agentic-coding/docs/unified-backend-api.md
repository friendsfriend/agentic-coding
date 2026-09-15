# Unified Bun backend API

One authenticated Bun server process owns every backend domain: the workflow
application, observations, event delivery, telemetry, the environment
state/catalog authority and the legacy devenv `/api/*` surface. The TUI and CLI
reach it through a typed client rather than in-process or subprocess backend
access; there is no second runtime and no delegation.

## Composition and lifecycle

- `src/server/lifecycle.ts` is the named composition root. `startWorkflowServer`
  binds `127.0.0.1` (loopback only), takes or generates a per-instance capability
  token and returns an `OwnedWorkflowServer` the owner releases exactly once.
- `agentic-coding server` starts that one server (default port 4050) with the
  environment authority, the integration families and the action/runtime engine
  attached. One signal stops it; it spawns no child runtime.
- The unified TUI starts and owns the same server at the environment address
  (`--devenv-port`, default 4050), configures `BackendClient`, points the
  environment client at the same listener and releases it through the shell
  resource registry. Test mode keeps the deterministic in-process demo path with
  no server.

## Authorization and bounds

- `src/server/auth.ts` generates a 32-byte instance token and requires
  `Authorization: Bearer <token>` on every route. Loopback binding is never the
  authorization decision. `GET /api/health` is the one public route (a liveness
  probe that reports the instance id and environment roots but no secret), and
  the change-request callback carries its own single-review path capability.
- Browser `Origin` headers are restricted to loopback hosts; a foreign origin is
  rejected before routing (so it can never delegate an environment mutation).
- `.env`-style request bodies are bounded (`MAX_REQUEST_BYTES`), declared
  `content-length` is checked before reading, paths are bounded
  (`MAX_PATH_CHARS`) and control characters are rejected. Diagnostics never echo
  a supplied capability, body or secret.
- Browser `Origin` handling has one rule for every surface: loopback origins
  echo back, anything else is rejected before routing.

## Route ownership

`ROUTE_OWNERSHIP` in `src/server/protocol.ts` is the static manifest of the
versioned surface, and `LEGACY_ROUTE_OWNERSHIP` in
`src/server/integrations/routes.ts` is the manifest of the legacy `/api/*`
surface. Every row is served in this process; a path in neither manifest is a
404. There is no router/plugin framework.

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

Reads remain observational: the observation dispatcher only lists/reads/views and
never initializes or migrates a store, expires a question or claims an effect.

### Environment ownership

`/api/v1/environment/private/state` is the bounded operation envelope the
environment authority exposes (see
[`environment-state-port.md`](environment-state-port.md)). It carries one
logical operation per request — no SQL, table or column ever crosses the wire —
and is served in-process, so it can never recurse into a second runtime. The
public `/api/v1/environment/*` prefix that used to be forwarded to the Go child
no longer exists; the environment surface clients use is the legacy `/api/*`
family on the same listener.

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
  in-process OTLP gRPC TraceService, the Prometheus scraper and the StatsD
  listener (`src/server/receivers.ts`) route decoded signals into a
  shell-injected sink. No receiver is a separate process.
- The environment state/config authority
  (`src/server/environment/authority.ts`) owns `$DEVENV_HOME/db/state.db` and the
  configured environment (definition files, catalog projection), and
  `GET /api/projects` serves the revision + projects envelope the catalog client
  compares.
- The Go backend, its embedded binary, the private Git bridge and the
  cross-runtime forwarding hooks are removed
  ([`go-retirement.md`](go-retirement.md)); `test/go-retirement.test.ts` fails if
  any of them returns.

Known gaps, kept explicit rather than silently dropped:

- The remaining CLI admin/mutation commands (`action`, `repair`, `migrate`,
  `repin`, `agent-extension`, `sidebar`) and the `config` read run at the CLI's
  own in-process application boundary; the agent commands, reads and full-feature
  attach are on the typed boundary.
- Renderer-suspension and the full lost-mutation/two-client acceptance suites
  are covered at the server level; the interactive terminal journeys remain for
  the test-verifier.

## Rollback gate

There is no runtime fallback: this process is the only backend. Rollback is a
deliberate artifact/data operation at a quiescent boundary — stop the TUI/server
stack through the owned resource registry (the one listener releases last), then
restore the previous release and, if its schema is older, the verified
pre-upgrade database. No workflow pin, workflow store or durable workflow data is
changed by the runtime cleanup, so an older revision reads the same stores. The
procedure and its preconditions are in [`go-retirement.md`](go-retirement.md).

For environment state specifically: an upgrade writes a `state.db.backup-v<N>`
with `VACUUM INTO`, a newer schema fails closed without modification, and an
interrupted migration is committed or rolled back as a whole — never a mix of
both.
