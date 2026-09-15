# Environment runtime port (containers, Kubernetes, app family)

`port-environment-runtimes-to-bun` moved the container and Kubernetes runtime
owners, and the app/infrastructure route family, out of the Go child and into
the Bun server, keeping the legacy `/api/*` contract. The Go child itself is now
deleted ([`go-retirement.md`](go-retirement.md)). It builds on
`port-action-execution-to-bun` (archived), which already made Bun the owner of
the action engine, the run/history tree and the script contract.

Route ownership is a per-family entry in `LEGACY_ROUTE_OWNERSHIP`
(`src/server/integrations/routes.ts`) and every family is now served in this
process.

## Prerequisite (task 1.1)

`port-action-execution-to-bun` is implemented and archived
(`openspec/changes/archive/2026-09-15-port-action-execution-to-bun`, 22/22 tasks
checked). Its result is what this change depends on:

- Bun owns action definitions, runs, scripts, the legacy `/api/events` stream
  and the environment state authority.
- The Docker/Kubernetes SDK-only operations were dispatched to the Go child
  through `src/server/actions/runtime-adapter.ts` and
  `POST /api/v1/actions/private/runtime-operation`. This change replaces that
  adapter with a Bun implementation (`src/server/runtime/dispatch.ts`).
- The `app`, `docker` and `kubernetes` families moved in-process, the identity
  probe included.

## Owner inventory

### Go owners this change replaces

| Owner | Location | Owns | Bun owner |
| --- | --- | --- | --- |
| Docker/Podman client | `pkg/docker/{client,runtime,health,stats}.go` | Runtime selection, container cache, status normalization, lifecycle, logs/stats/events, health gate | `src/server/runtime/docker.ts` |
| Prune poller | `pkg/server/server.go` (`startContainerPrunePoller`, `containerPruneArgs`) | `system prune` policy for both runtimes | `src/server/runtime/docker.ts` (`runSystemPrune`, `startPrunePoller`) |
| Docker routes | `pkg/server/{handlers_docker,docker_actions}.go` | Six `docker` rows, commandless lifecycle runs, `docker.container.*` events | `src/server/runtime/routes.ts` |
| Kubernetes runner | `pkg/kubernetes/{runtime,identity}.go` | `kind`/`kubectl`/`helm` argv, provider env, preflight, image archive path | `src/server/runtime/kubernetes.ts` |
| Cluster service | `pkg/kubernetes/{cluster_service,cluster_status}.go` | create/delete/recreate/export, status collection, Podman list-bug fallback, node stats | `src/server/runtime/kubernetes.ts` |
| Images/secrets/status | `pkg/kubernetes/{image,secrets,status_logs}.go` | Build/reference plans, Helm overrides, secret plans + redaction, Helm status, logs/port-forward argv | `src/server/runtime/kubernetes.ts` |
| Kubernetes routes | `pkg/server/handlers_kubernetes.go` | Three `kubernetes` rows, pod-prefixed log reads | `src/server/runtime/routes.ts` |
| Cluster watchers | `pkg/server/server.go` (`startKubernetesStatusWatchers`, `startKubernetesClusterPoller`) | Server-scoped status polling | `src/server/runtime/kubernetes.ts` (`startClusterStatusWatcher`), composed in `services.ts` |
| Dependency leases | `pkg/server/dependency_leases.go` | Durable owned-dependency leases, adoption, release, stop blocking | `src/server/runtime/leases.ts` |
| Runtime dispatch | `src/server/actions/runtime-adapter.ts` + Go private endpoint | `docker.container.{start,stop,restart}`, `kubernetes.cluster.refresh` | `src/server/runtime/dispatch.ts` |
| App routes | `pkg/server/{handlers_apps,handlers_build,handlers_infra_scripts}.go` | Eleven `app` rows | `src/server/runtime/app-routes.ts` |
| Run status | `pkg/runstatus/status.go` | State priority, normalization, aggregation | `src/server/runtime/status.ts` |
| Operation status | `pkg/status/manager.go` | Transient operation status with auto-clear | `src/server/runtime/status.ts` |
| Example config | `pkg/exampleconfig/generator.go` | The example configuration tree and its guards | `src/server/environment/example-config.ts` |
| Resource lookups | `pkg/resources/manager.go` (`DiscoverProfiles`, `ResolveDockerfileForAction`) | Profile variants, shell-action Dockerfile presence | `src/server/actions/discovery.ts` |

### The remaining inventory rows (task 4.4)

The app-family observation providers this change had left injected are now
concrete Bun implementations:

| Owner | Location | Owns | Bun owner |
| --- | --- | --- | --- |
| Run target/status observation | `pkg/build/{service,kubernetes_logs}.go` | `RunTargetInfo` (memory then state store), last-run runtime, Kubernetes run status from pod phases, app Kubernetes run logs | `src/server/runtime/run-observation.ts` |
| Script infrastructure lifecycle | `pkg/operations/{service,script_lifecycle}.go` | Script start/stop/status/execution handle, logged or tmux launch, adoption of windows a previous process left, process-tree stop | `src/server/runtime/script-infrastructure.ts` |
| Status pollers | `pkg/server/server.go` (`startGitPoller`, `startReconciliationPoller`, `startScriptHealthPoller`, `broadcastStatusUpdated`) | Signature-deduplicated `status.updated` broadcasts over the legacy stream | `src/server/runtime/status-broadcast.ts` |
| Resource lookups | `pkg/resources/manager.go` (`DiscoverProfiles`, `ResolveDockerfileForAction`) | Profile variants, shell-action Dockerfile presence | `src/server/actions/discovery.ts` |
| Example configuration | `pkg/exampleconfig/generator.go` | The example configuration tree and its guards | `src/server/environment/example-config.ts` |

The observation providers stay injectable (`AppFamilyServices.scriptStatus`,
`runObservation`; `RuntimeRouteServices.resolveKubernetesTarget`) because they are
composition seams, not optional behaviour: the composition root attaches the Bun
owners, and an unattached seam reports the configured/unknown state instead of
inventing a running one — an unavailable observation is never confirmed presence.

### Go owners retained for rollback (disabled when Bun owns them)

The Go implementations of these capabilities are **not deleted** by this change
— deletion is reserved for `retire-go-backend-and-migration-bridges` — but they
are *disabled* whenever the Bun server owns them, so two owners never observe or
mutate the same runtime:

| Go owner | Gate | Bun owner |
| --- | --- | --- |
| `startDockerEventListener`, `startKubernetesStatusWatchers`, `startKubernetesClusterPoller`, `startContainerPrunePoller` | `DEVENV_BUN_RUNTIME_OWNER=1` | `src/server/runtime/services.ts`, `docker.ts`, `kubernetes.ts` |
| `startGitPoller`, `startReconciliationPoller`, `startScriptHealthPoller` | `DEVENV_BUN_APP_FAMILY=1` | `src/server/runtime/status-broadcast.ts` |

Both flags are set by the launcher (`backendChildEnvironment`) exactly when it
attaches the corresponding capability; `server/pkg/server/runtime_owner_test.go`
asserts the gating, and `test/runtime-cutover.test.ts` asserts the flags and that
the Bun scope starts exactly one listener/watcher/poller. `GET /api/health`
answers in the server process like every other route; it is not a product
surface.

## Adapter choices (task 1.3)

| Capability | Adapter | Why it is the parity-preserving choice |
| --- | --- | --- |
| Container listing/inspection/lifecycle/logs/stats/events | Docker Engine HTTP API over the runtime socket (`fetch` with Bun's `unix` option; `tcp://` when the host says so) | Go reached the daemon through the Docker SDK, which is the same API. Structured JSON keeps status/ports/health semantics exact; a CLI adapter would re-parse text and lose `State`, port pairs and stream framing. |
| Docker log frames | 8-byte header demux, raw pass-through when the header is not framed | Go used `stdcopy.StdCopy`, which *fails* on a TTY stream; the port streams a TTY container instead of erroring (asserted). |
| Compose lifecycle | `docker-compose`/`podman-compose` argv | Go already ran the compose CLI (compiled command steps, unchanged by this change). |
| Compose/Kubernetes/container readiness | `kubectl`/compose/`docker inspect` argv probes | Ported earlier by `port-action-execution-to-bun` (`readiness.ts`); unchanged. |
| Kubernetes cluster/images/helm | `kind`/`kubectl`/`helm` argv | Go already drove these CLIs; every command is a pure function so a fixture asserts the exact argv. |
| Node stats (`kind` containers) | `docker`/`podman stats --no-stream` with JSON, then tab, then `inspect` | The Go fallback chain verbatim, including the Podman numeric `MemUsage`/`MemLimit` shape. |
| `system prune` | `docker`/`podman` argv, `--filter until=24h`, never `--all` | Policy parity: a runtime that is not installed is skipped, and tagged application images loaded into kind survive. |
| Example configuration | Extracted Go templates | The template bodies are machine-extracted from the Go source, so the generated tree is byte-identical (asserted against a Go-generated fixture). |

Dependency review: no new package was added. The Docker API is spoken with
`fetch` (Bun's `unix` socket option), Kubernetes/Helm/Compose/prune use
`node:child_process` argv, and the tree/state work reuses the existing Bun
modules (`environment/config.ts`, `environment/manager.ts`,
`integrations/git-repository.ts`, `environment/state-store.ts`).

## Deliberate differences from the Go implementation

All are asserted by a test.

- **Docker API version negotiation is dropped.** Requests use unversioned paths
  (`/containers/json`), which dockerd and the Podman compat API map to their own
  latest version; Go negotiated `/vX.Y/...` with an extra round trip that no
  ported behaviour depended on.
- **The container cache refreshes with one in-flight promise.** Go guarded the
  cache with a mutex; a burst of status reads still triggers exactly one list.
- **Namespace listing is stable-sorted.** Go iterated a map, so the order changed
  between calls.
- **The runner is a value, not package state.** Go's `kubernetes.Runner` read the
  selected container runtime from package globals; the port passes it, so a test
  can pin `podman` without mutating the process.
- **The executor is asynchronous and already-running is explicit.** Inherited
  from `port-action-execution-to-bun`: an already-running step completes with
  the `already-running` outcome and never fabricates a command.
- **A refused example-config run leaves nothing behind.** Both directories are
  checked before the first write; Go's ordering could create the scripts
  directory first.

## Route ownership (switched)

`src/server/integrations/routes.ts` flips the `app` (eleven rows), `docker`
(six rows) and `kubernetes` (three rows) families from `go` to `bun`.
`GET /api/health` is served in-process after the retirement: it reports this
process's instance id and environment roots, with no secret in it.

| Family | Routes |
| --- | --- |
| app | `GET /api/apps`, `GET /api/projects`, `GET /api/status`, `GET /api/infra-services`, `GET /api/infra-services/{ident}/logs`, `GET /api/apps/{ident}/docker`, `GET /api/apps/{ident}/git`, `GET /api/apps/{ident}/profiles`, `POST /api/apps/create`, `DELETE /api/apps/{ident}/delete`, `POST /api/example-config` |
| docker | `POST /api/docker/{start,stop,restart}`, `GET /api/docker/logs`, `GET /api/docker/logs/stream`, `GET /api/docker/stats/stream` |
| kubernetes | `GET /api/kubernetes/logs`, `GET /api/kubernetes/cluster`, `POST /api/kubernetes/cluster/refresh` |

### Cutover and rollback

The switch is quiescent and needs no reparenting:

- Bun's run registry and process store start empty on every start, so a live Go
  command run is never adopted. Persisted history stays readable through the same
  routes.
- A container lifecycle call allocates a commandless run in Bun's registry: the
  Docker API did the work, no process ran, and no command is fabricated.
- Durable dependency leases are adopted on startup (`DependencyLeases.adopt`),
  so a restart never treats an owned dependency as unowned and never starts a
  second copy.
- Rollback is the manifest entry per family plus the client's base URL:
  restoring `owner: "go"` returns a family to the unchanged Go implementation.
  Both owners read and write the same state tables, so no migration runs in
  either direction. Bun's background scopes are cancelled as one unit
  (`RuntimeServices.stop()`), so a rollback stops the event listener, the prune
  poller and the cluster watcher without scheduling another reconnect.

## Fixtures

| Fixture | Generator | Asserted by |
| --- | --- | --- |
| `test/fixtures/environment/example-config.json` | `server/pkg/exampleconfig/fixtures_test.go` | `test/environment-example-config.test.ts` |

Regenerate with:

```bash
DEVENV_EXAMPLE_FIXTURE_DIR=<repo>/agentic-coding/test/fixtures/environment \
  go test ./pkg/exampleconfig -run TestWriteExampleConfigFixture
```

Without the env var the generator skips, so a normal `go test ./...` never writes
into the repository.

The container and Kubernetes parity fixtures are the Go unit tests themselves,
ported case for case into `test/runtime-docker.test.ts`,
`test/runtime-kubernetes.test.ts`, `test/runtime-status.test.ts` and
`test/runtime-leases.test.ts`; the runtime routes are asserted by
`test/runtime-routes.test.ts` and the app family by `test/runtime-app.test.ts`.

## Disposable-runtime smoke fixtures (tasks 4.2/4.3)

The live-runtime smoke fixtures are opt-in and skip with an explicit reason when
the runtime is missing, so a machine without Docker/Podman/kind reports a skip
instead of a false success:

```bash
DEVENV_SMOKE_RUNTIME=docker bun test test/runtime-smoke.test.ts
DEVENV_SMOKE_RUNTIME=kubernetes bun test test/runtime-smoke.test.ts
```

Each fixture creates its own namespace/project and removes only resources it
created and labelled as its own.
