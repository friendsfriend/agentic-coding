# Go retirement: one Bun backend, one executable

`retire-go-backend-and-migration-bridges` is the final step of the migration: the
imported Go backend, its embedded-extraction launcher, the private
state/catalog/Git adapters and the cross-runtime forwarding hooks are deleted.
One `agentic-coding` executable runs one Bun server process that owns every
backend domain. This document records the deletion gates, what was preserved,
the packaged acceptance results, the supported platforms/tools and the rollback
procedure.

## 1. Retirement gates (tasks 1.1-1.3)

### Predecessors (1.1)

`openspec/changes/archive/2026-09-15-port-environment-runtimes-to-bun` and every
predecessor in the chain have zero unchecked tasks:

| Change | Archived |
| --- | --- |
| `expose-unified-bun-backend` | 2026-09-14 |
| `port-project-catalog-and-state-to-bun` | 2026-09-14 |
| `replace-workflow-project-discovery` | 2026-09-14 |
| `unify-application-lifecycle-and-binary` | 2026-09-14 |
| `port-git-providers-and-ai-to-bun` | 2026-09-14 |
| `port-action-execution-to-bun` | 2026-09-15 |
| `port-environment-runtimes-to-bun` | 2026-09-15 |

The two archived changes with unchecked boxes
(`2026-07-18-add-current-working-dir-to-project-options`,
`2026-08-26-check-tui-freezing`) are not predecessors of this change.

### Route/action/feature inventory (1.2)

The inventory is the two static manifests, and both are fully in-process:

- `ROUTE_OWNERSHIP` (`src/server/protocol.ts`): every versioned `/api/v1/*`
  route — workflow, agents, config, events, telemetry, credentials, the private
  environment operation.
- `LEGACY_ROUTE_OWNERSHIP` (`src/server/integrations/routes.ts`): every legacy
  `/api/*` family — git, providers, repos, app, actions, scripts, docker,
  kubernetes, github, gitlab, ai, system.

Audit result **before** the cleanup: one gap. `GET /api/health` was still
`go`-owned (it reported the child's identity), and `/api/v1/environment/*` was
delegated to the child even though the child served no such route. Two further
gaps were found while closing them:

1. `GET /api/projects` returned only `{ projects }`, dropping the `revision`
   the catalog client compares to detect a configured-project change (the Go
   handler returned `app.NewProjectCatalog`). Fixed in
   `src/server/runtime/app-routes.ts`.
2. The server's own observation path read the catalog over HTTP from
   `AGENTIC_DEVENV_URL` or the default port 4050. In a clean install nothing
   answers there, so a catalog read fell back to a bounded second invocation
   instead of the running server. Fixed by exporting the server's own address
   and capability in `runHeadlessServer`.
3. A route that owns no environment surface (the per-workflow dashboard pane)
   still pointed its environment feature and catalog reads at the default port,
   where another install could be listening — reading, or failing on, foreign
   data. Now such a route exports an empty address, so catalog reads use the
   bounded read-only invocation, and it offers no environment feature.

After the cleanup both manifests contain only `bun`-served rows; the `go` value
is removed from `LegacyRouteOwner`, `RouteOwner` and the delegation functions.
No fallback exists: a path in neither manifest is a `404`, and a route whose
capability is not attached answers `503` in-process.

### Fixture preservation (1.3)

The Go-created golden fixtures are portable data and stay in the Bun suites; the
generators that produced them were deleted with the tree:

| Fixture directory | Consumed by |
| --- | --- |
| `test/fixtures/integrations/{git,provider,github,gitlab,pi-sessions}` | `test/integration-git-providers.test.ts`, `test/integration-github*.test.ts`, `test/integration-gitlab*.test.ts` |
| `test/fixtures/environment/{v1,v3,v5,v6,current,partial-v4,future,config,home,operations}` | `test/environment-state.test.ts`, `test/environment-config.test.ts`, `test/environment-operations-contract.test.ts` |
| `test/fixtures/actions/*` | `test/actions-*.test.ts` |
| `test/fixtures/environment/example-config.json` | `test/environment-example-config.test.ts` |

Historical data support therefore outlives the code that produced it: every
fixture version still opens (see §5).

## 2. What was removed (tasks 2.1-2.6)

| Removed | Replaced by |
| --- | --- |
| `server/` (the Go backend, 244 files + `testdata/`) | this process |
| `src/backend/managed-backend.ts`, `src/backend/lifecycle.ts` (spawn, extraction, health-identity probe, bounded stop) | the server started in-process; home/config resolution moved to `src/backend/home.ts` |
| `EMBEDDED_SERVER_BINARY_BASE64` and the Go build in `scripts/build.ts` | nothing to embed |
| `src/tui/otel/receiver/otlp-grpc-sidecar.ts` and the `__grpc-sidecar` mode | `src/tui/otel/receiver/otlp-grpc.ts`, an in-process TraceService listener |
| `src/server/integrations/private-api.ts` (private Git adapter) | `GitRepository` called directly |
| `/api/v1/environment/*` delegation, `environmentBaseUrl`/`environmentToken`, `relayLegacyEvents` | the same process serves the surface |
| `AGENTIC_DEVENV_FORWARD_URL` in `packages/devenv/core/src/custom-fetch.ts` | the client's base URL *is* the server |
| `DEVENV_ENVIRONMENT_OWNER` owner switch, `bunOwnsEnvironment` | one owner, no switch |
| `test:server` / `vet:server` scripts | — |

Kept: `--devenv-port`/`-p`/`--port` (the one listener), `attach`/`spawn`/`server`
aliases, `AGENTIC_DEVENV_URL`, `AGENTIC_WORKFLOW_URL`, `AGENTIC_WORKFLOW_TOKEN`,
`AGENTIC_DEVENV_TOKEN`, the legacy `/api/*` paths and the historical data
formats. `--workflow-port` is still accepted as a deprecated alias for the single
port (using a different value is an error, not a second listener).

### Telemetry gRPC (2.1)

The OTLP TraceService runs inside the server process. `toOtlpJson` converts the
protobuf message into the OTLP/JSON shape the shared decoder accepts (bytes →
hex ids, 64-bit values → decimal strings) — the helper-process mode
`JSON.stringify`d the raw protobuf, whose `{type:"Buffer"}` ids and `{low,high}`
timestamps the decoder correctly refused, so the advertised support ingested
nothing. `test/telemetry-grpc.test.ts` proves a real export reaches the span
sink, that an undecodable export is reported as `INVALID_ARGUMENT`, that the bind
is loopback-only and that `stop()` releases the port. Metrics/logs gRPC are not
advertised, because only the trace service was ever supported.

### Static/process guards (2.6)

`test/go-retirement.test.ts` fails if:

- any source file reaches `EMBEDDED_SERVER_BINARY`, `dist/server/devenv`,
  `"main.go"`, `devenv-server`, `backendChildEnvironment`, `startOwnedBackend`,
  `ensureExecutable`, `__grpc-sidecar` or `DEVENV_INSTANCE_TOKEN`;
- `server/` or `dist/server/` exists;
- the shell contains a second launch path (`startOwnedBackend`,
  `AGENTIC_DEVENV_FORWARD_URL`, `go-backend`) or the lifecycle store still
  declares a Go-handle kind;
- `src/server/receivers.ts` spawns a process or references a sidecar;
- the headless server (run with a `PATH` that has no `go`) answers health, serves
  a catalog observation and has **no** child process at all.

## 3. Packaged acceptance (tasks 3.1, 3.2, 3.3)

Artifact: `bun run build` → `dist/agentic-coding` (0.12.7, host target only).
Runs below were executed from `/tmp` (outside every source checkout) with
temporary `DEVENV_HOME`/`DEVENV_CONFIG_DIR` and the Go toolchain unavailable.

| Command | Result |
| --- | --- |
| `dist/agentic-coding server --port N` (`AGENTIC_WORKFLOW_TOKEN` set) | announces `unified server http://127.0.0.1:N (instance …, pid …)` plus the attach hint; no child process |
| `GET /api/health` | `200` `{status:"ok",apiVersion:"v1",instance,version:"0.12.7",pid,homeDir,configDir}` — public, no secret |
| `GET /api/projects` with the capability | `200` `{revision:"…16 hex…",projects:[…]}` |
| `GET /api/projects` without the capability | `401` |
| `GET /api/v1/workflow/view?repo=…&list=1` | `200` list envelope for a real repository |
| `GET /api/pi-sessions`, `GET /api/git/branches`, `GET /api/scripts`, unknown `/api/*` | `200` (family handler / parameter error) and `404` for an unknown path |
| `dist/agentic-coding __catalog` | prints the catalog envelope (the bounded headless read) |
| `dist/agentic-coding home --devenv-port N` (pty) | renders the unified shell, binds the one server at `N`, no child process; `SIGTERM` releases the port |
| `dist/agentic-coding home --http-port N --grpc-port M` (pty) | OTLP HTTP export `{"partialSuccess":{}}`; the gRPC port accepts a real `ExportTraceService` export; `$DEVENV_HOME/db/state.db` created |
| `dist/agentic-coding attach URL --token T` (pty) | renders the attached shell; catalog reads answer `200` from the attached server (no 401) |
| `dist/agentic-coding dash --repo … --workflow-id …` (pty) | renders the dashboard pane; zero requests to the default environment port, catalog reads served by the bounded read-only invocation |
| `devenv` symlinked to the packaged executable | `devenv server --port N` starts the same unified server; an unknown verb reports the unified dispatcher error |
| `dist/agentic-coding attach URL` (no capability) | exits `2` with "attach requires the server capability: pass --token TOKEN" |
| second `server` on an occupied port | exits `1` with Bun's "Failed to start server. Is port N in use?"; the running server keeps serving |

Feature journeys exercised through the packaged artifact: workflow view,
environment catalog, GitHub/GitLab/provider families (fixture-backed in the test
suite; the packaged run covers the route and auth envelope), scripts, actions and
events (`GET /api/events`), telemetry (HTTP + gRPC receivers), Pi sessions, wiki
and research targets (`--repo` routes through the same observation API). Live
provider calls, container/kubernetes operations against real daemons and the
interactive terminal journeys are **not** covered here and need credentials or
disposable infrastructure (see §6).

## 4. Lifecycle acceptance (task 3.4)

- **Owned shutdown:** `SIGTERM` to the packaged TUI released the listener (health
  probe refused afterwards) and left no process behind; the resource registry
  order (renderer → telemetry → server → application) is asserted in
  `test/lifecycle.test.ts`.
- **Port collision:** a second server on the same port fails with Bun's bind
  error and exits `1`; nothing signals the process that owns the port. The same
  holds for a telemetry receiver port: a home shell whose default trace port
  (4318) is taken fails startup with the bind error instead of dropping the
  receiver silently.
- **Client disconnect:** a suspended SSE client does not block mutations or other
  clients (`test/server-api.test.ts`), and receiver ingestion is independent of
  the renderer (`test/server-telemetry.test.ts`).
- **Active-action quit:** the interactive confirmation and the signal path are
  covered by `test/lifecycle.test.ts` (quit asks before cancelling active work;
  a signal cancels through the domain API and does not wait for a dialog).
  Driving the dialog itself requires a terminal.
- **Ownership:** only the managed home route owns a server
  (`test/backend-lifecycle.test.ts`); `attach`, `dash`, `--json` and the test
  profile own nothing and never stop a listener they did not start.

## 5. Historical data, upgrade and rollback (task 3.5)

Opening each retained fixture database through the packaged server:

| Fixture | Result |
| --- | --- |
| `v1`, `v3`, `v5`, `v6`, `current` | health `200`, `/api/apps` answered — each version migrates or is already current |
| `partial-v4` (interrupted upgrade) | completes idempotently on the next open (`test/environment-state.test.ts`) |
| `future` (schema 99) | exits `1`: "database schema 99 is newer than the supported 7; refusing to modify it", no backup written, data untouched |

Workflow definitions, pins/digests, historical snapshots and config/data formats
are unchanged by this cleanup: no schema, no workflow store and no telemetry
database is rewritten, and the workflow-pin and migration suites
(`test/workflow-migration.test.ts`, `test/workflow-registry.test.ts`) still pass.

**Upgrade procedure**

1. Stop every writer (TUI/server) through its owned shutdown path — the last
   writer to exit must be the one that owns the listener.
2. Back up `$DEVENV_HOME` and `$DEVENV_CONFIG_DIR` (or rely on the automatic
   `state.db.backup-v<N>` the upgrade writes with `VACUUM INTO`).
3. Start the new release: it migrates the environment schema forward and writes
   the backup before the first write.
4. Verify with `GET /api/health`, `GET /api/projects` and the workflow list.

**Rollback procedure**

1. Stop the server (quiescent boundary; no in-flight action, run or migration).
2. Restore the previous release artifact.
3. If that release writes an older environment schema, restore the verified
   pre-upgrade `state.db` (or `state.db.backup-v<N>`) **before** starting it.
4. Start it and verify health/catalog. Two releases must never run as writers
   over one database; a newer schema is never downgraded automatically.

## 6. Support matrix and compatibility (task 3.6)

**Runtime requirements (shipped executable)**

| Component | Requirement |
| --- | --- |
| Executable | Bun-runtime-free compiled binary, host target only (the build does not cross-compile) |
| Go toolchain | not required at build or run time |
| Git | required for repository/worktree features |
| `docker`/`podman` (+ `docker-compose`/`podman-compose`) | required for container features; absent = "runtime unavailable", never a silent success |
| `kind`, `kubectl`, `helm` | required for Kubernetes/infrastructure features |
| `tmux` | optional: script services run in a tmux window when the server runs inside tmux, else as logged children |
| `pi` | required for the AI analysis/review features (a missing binary is a bounded `503`, a timeout a `504`) |
| Herdr | optional external dependency for the sidebar/agent handoff surface |
| Terminal | a real TTY for the TUI (the renderer is OpenTUI); `server`/`attach`/`workflow` need one only for interactive use |

No supported feature needs a Go binary, a Go compiler, an extracted helper
binary or a second application server process.

**Compatibility kept**

- Commands: `agentic-coding` (default/home), `manager`, `dash`, `home`,
  `workflow`, `server`, `attach`, and the `devenv` alias (`spawn`, `attach`,
  `server`).
- Flags: `--devenv-port`/`-p`, `--devenv-url`, `--attach-url`, `--attach-token`,
  `--token` (server), `--workflow-port` (deprecated alias for the single port),
  telemetry receiver ports, `--repo`, `--workflow-id`, `--json`, `--profile`.
- Environment: `DEVENV_HOME`, `DEVENV_CONFIG_DIR`, `AGENTIC_DEVENV_URL`,
  `DEVENV_URL`, `AGENTIC_WORKFLOW_URL`, `AGENTIC_WORKFLOW_TOKEN`,
  `AGENTIC_DEVENV_TOKEN`.
- Data: environment config files, `state.db` (v1-v7 with forward migration),
  workflow store and pins, telemetry database, provider/credential files.

**Compatibility changed (deliberately)**

- `agentic-coding attach URL` now requires a capability (`--token` or
  `AGENTIC_WORKFLOW_TOKEN`). The unified server authenticates every surface, so
  the previous environment-only attach could only render empty views. Start the
  server with the same value to allow attach.
- `AGENTIC_DEVENV_FORWARD_URL`, `DEVENV_ENVIRONMENT_OWNER`,
  `DEVENV_SERVER_BINARY` and the `__grpc-sidecar` internal mode are removed.
- `--workflow-port` no longer selects a second listener: one process serves one
  port (a differing value is an error).

## 7. Final verification (task 3.7)

| Check | Result |
| --- | --- |
| `bun run lint` (Biome) | zero diagnostics |
| `bun run type-check` | clean |
| `bun run test` | all files pass except the pre-existing `test/otel/shellHelp.test.tsx` wiki-tab help timeout, which reproduces on a pristine tree |
| `bun run test:devenv` | pass |
| `bun run build` | one host-target artifact |
| Packaged acceptance | §3/§4 above, Go toolchain unavailable |
| `go test` / `go vet` | commands removed with the tree |

With the guards of §2 in place, a hidden Go fallback or a separate permanent
gRPC backend process cannot be reintroduced without failing the suite.
