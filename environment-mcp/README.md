# Standalone Environment MCP

A fresh environment server package, independent of both coding-agent applications.
Uses Bun, the official MCP SDK, Zod and the OpenTUI package. No Pi, workflow
engine, model, UI source, native agent state or runtime source import from
`agentic-coding/` or `agentic-coding-v2/`.

**Status: catalog, direct command/Compose/container/shell-process/Helm execution, Docker and Podman providers (Podman build, Compose, network and container run live-verified), multi-repository client authority, network-only Compose bridges with automatic network-only prerequisite start and `networkFrom` membership, controller-wide shared-service leases with automatic last-release cleanup, native shell, Compose collector and container-run OTLP telemetry, telemetry trace browser, endpoint/health readiness, borrowed-service safety, capability-parity agent OpenTUI, bounded operation/log history, safe scope retention, opt-in owned-app idle cleanup with clean scope closure and lazy rebinding, crash-safe process supervision, durable controller diagnostics and an OpenCode stdio bridge are implemented; saved-PID adoption is intentionally unsupported; external secret values and real-chart cluster images remain externally supplied. Kubernetes Helm and Podman paths were exercised against disposable live environments; the real customer chart was installed/readied/uninstalled with a local substitute image and minimal CRDs, not its private application image.**
Read-only stdio advertises `env_list`, `env_git`, `env_git_changes` and
`env_git_diff`. Shared HTTP mode additionally
advertises `env_execute`, `env_operation`, `env_status`, `env_stop`, `env_wait`, `env_refresh`,
`env_telemetry` and `env_logs`, backed by private state. Execution is direct and
idempotent by request id; only resources created by the issued operation enter
cleanup. Borrowed
PostgreSQL/Redis observations never do. Build/test command targets, Compose run targets and
Compose collector telemetry, Kubernetes Helm release execution and network-only
Compose bridges with `networkFrom` membership are supported. The
OpenCode `environment-mcp` bridge now uses one client bound to every authorized
repository; the legacy `agentic-environments` entry is removed. Existing
PostgreSQL has not been modified.

## Install, build and run

From this directory:

```sh
bun install --frozen-lockfile
bun run build
bun dist/cli.js --config-dir /absolute/v2/config-dir
```

The built `dist/cli.js` bundles production dependencies and can be copied to
another directory and run with Bun; no sibling package or checkout is needed.
Default mode speaks standard MCP on stdin/stdout, not an interactive CLI or HTTP listener.
`--help` and sanitized errors go to stderr. Disconnect releases the transport;
default inspection creates no processes, resources, state stores or runtime handles.
The root application installer does not install this package yet.

## Configuration: v2 structure reused

The public configuration is the existing v2 shape, not a new manifest:

- `CONFIG_DIR/config.json` supplies the authorized repository list.
- `CONFIG_DIR/environments.json` supplies projects, kinds, defaults and targets.
- `CONFIG_DIR/.env` supplies declared secret references, parsed once with Node's
  `parseEnv` (the same mechanism as the v1/v2 environments UI); process
  environment is the fallback. Only declared references are resolved at dispatch,
  and values never enter plans, tools or state.

```sh
bun dist/cli.js --config-dir /absolute/v2/config-dir
bun dist/cli.js --serve --config-dir /absolute/v2/config-dir \
  --state-dir /absolute/private-state --clients /absolute/clients.json
```

Targets are normalized for execution without changing the file structure:

| v2 target | Standalone execution mapping |
| --- | --- |
| `shell`/`systemshell` with `command` (build/test) | fixed `/bin/sh -lc <configured command>`, literal `environment`, `secretRefs`, bounded timeout |
| `shell`/`systemshell` run with `command` | owned detached `/bin/sh -lc <configured command>` process group, optional loopback `readyUrl` or `readyText`, bounded startup timeout; logs/stop are owned-only |
| `docker`/`podman` build with `container.dockerfileSource` | provider-specific `build` using the inline Dockerfile and configured BuildKit `buildSecrets` template/file/env modes |
| `docker` build with `container.dockerfile` | `docker build -f` with the declared image/socket |
| `compose` run with `file` or inline `source` | Docker Compose or `podman-compose -p <name> -f <file> up -d <services>`; project/services read from the YAML; service `x-secret-refs`/target `secretRefs` are injected through a private override file, and declared collector telemetry is supported |
| `compose` run with `networkOnly: true` | one owned bridge named from the exact app/target; readiness is bridge creation only |
| `compose` with `networkFrom` | member containers attach to the prerequisite bridge; an existing bridge is borrowed, an absent approved network-only prerequisite is created under the member and owned until empty |
| `docker`/`podman` run with `container` | provider-specific detached `run` with generated `environment-mcp-<app>-<target>` name, loopback publications and declared env references |
| `kubernetes` with `workload: helm-release-v1` and `helm` | fresh `helm install` of a frozen repository chart into an explicitly configured cluster/namespace; offline render validation, Deployment availability readiness, exact release revision/label cleanup; no upgrade, hooks, CRDs or subcharts |

Container-run telemetry uses the `otlp-http-json` / `0.0.0.0:0` declaration. A
fresh TLS host-gateway receiver is mounted with its public CA and standard
`OTEL_*` exporter variables are injected into the container. It supports images
that honor the standard OTEL environment; it is not an image-specific
instrumentation claim.

Native shell telemetry uses the v2 `telemetry: {protocol:"otlp-http-json",
listen:"127.0.0.1:0"}` target declaration. The controller starts a loopback
receiver with a per-run bearer token, injects standard `OTEL_*` environment
values into the process, and retains bounded redacted spans/logs in memory for
`env_telemetry`.

Compose collector telemetry uses the v2
`telemetry: {protocol:"otlp-http-json", listen:"0.0.0.0:0",
collectorService:"<service>", transport:"tls-host-gateway-v1"}` declaration. The
configured collector must be the exact unexposed
`otel/opentelemetry-collector-contrib:0.162.0` service with
`--config=env:OTEL_COLLECTOR_CONFIG` and an explicit `host.docker.internal`
gateway. The controller creates a fresh ephemeral TLS certificate, starts a
host-gateway receiver with bearer authentication, injects the collector
configuration and CA mount through a private Compose override, and retains
bounded redacted spans/logs for `env_telemetry`. The certificate private key is
never written to disk and the certificate files are removed on a clean stop.
The shared OpenTUI now has a trace browser: an `env_telemetry` snapshot lists
captured traces, and selecting one opens its parent/child tree. The Compose
collector receiver path was exercised live with a temporary collector and
synthetic OTLP JSON; no application-specific instrumentation claim is made.

### Compose network-only bridges

A v2 Compose target with `networkOnly: true` and exactly empty services becomes a
single owned bridge named `environment-mcp-network-<app>-<hash>`. The exact
creation is recorded; readiness means the bridge exists, not application health.
Members with `networkFrom` attach their own containers to that bridge after their
Compose stack starts. They never own or remove the bridge. Owner cleanup refuses
while any container is attached; after member cleanup, the empty, identity-
verified bridge can be removed. Network names and copied labels grant no
adoption authority. When an approved member declares a network-only
prerequisite and the bridge is absent, dispatch creates that exact prerequisite
under the member operation and records it as owned by that member. An existing
labelled bridge is borrowed and never owned. Other prerequisite kinds remain
explicit operations and are not auto-started.

### Kubernetes Helm releases

The v2 `kubernetes` target with `workload: "helm-release-v1"` is normalized into a
fresh Helm release descriptor. The chart directory, values files and `Chart.yaml`
are bounded and hashed at startup; admission and dispatch re-hash the chart and
refuse drift. The offline `helm template` render must contain only namespaced
objects and at least one `apps/v1` Deployment; CRDs, subcharts, hooks,
resource-policy annotations and `lookup` are refused.

Installation is a fresh `helm install` with a per-operation release label, never
an upgrade or adoption. Cleanup verifies the observed revision and label before
`helm uninstall`, and only the release identity created by this operation enters
the owned ledger. Readiness waits for the rendered Deployments to become
Available. Chart workload logs are not inferred from selectors; `env_logs` says
that native Helm logs are unavailable rather than manufacturing them.

`clusters.json` is optional. Explicit entries provide a config-contained
kubeconfig, context, authorized repositories and a bounded client environment.
Without an explicit `devenv` entry, the v1-compatible default is cluster
`devenv` with context `kind-devenv`. This package does not provision kind
clusters, rewrite kubeconfigs, support CRDs/subcharts/hooks or claim a live
cluster run. `helm` and `kubectl` must be available on the controller PATH.

The optional additive `serviceBindings` section can declare explicit borrowed
Docker identities (socket, name, image, labels, network/alias, readiness) for
targets that name `requires`. It is the only execution-specific extension;
without it, dependency readiness preparation refuses rather than guessing from a
name. Compose connectivity remains exactly what the reviewed Compose source
declares; the server never attaches or reconfigures an existing service.

All MCP-owned Compose workloads use the single project/group name
`environment-mcp`; explicit container names must start with `environment-mcp-`.
Docker therefore shows them together under one group. The configured source may
still attach to an external network for borrowed services.

The internal strict manifest used by package fixtures remains available only via
`--config FILE --format manifest` (and the explicit metadata-only
`--format v2-catalog` reader). Neither is the recommended runtime configuration.
For reference, that fixture shape is:

```json
{
  "version": 1,
  "repositories": ["/absolute/repository"],
  "services": [{"id": "postgres", "runtime": "docker"}],
  "apps": [{
    "id": "example",
    "repository": "/absolute/repository",
    "kind": "app",
    "defaults": {"run": "mocked"},
    "targets": [{
      "id": "mocked",
      "action": "run",
      "runtime": "compose",
      "profile": "Mocked",
      "dependsOn": [{"service": "postgres", "lifecycle": "shared"}]
    }]
  }]
}
```

### Configured dependency bindings

A v2 configuration may add the optional `serviceBindings` section for explicit
borrowed-service identity:

```json
{
  "serviceBindings": {
    "postgres": {
      "kind": "docker-container",
      "socket": "/absolute/docker.sock",
      "containerName": "postgres",
      "image": "postgres:17.4",
      "labels": {
        "com.docker.compose.project": "existing-mocked",
        "com.docker.compose.service": "postgres"
      },
      "network": {"name": "existing-mocked_devenv-local", "alias": "postgres"},
      "readiness": "healthy"
    }
  }
}
```

This is server configuration, not a tool parameter or permission to borrow by
name alone. It requires an explicit local socket, image reference, nonempty label
expectations, network/alias and `running` or `healthy` readiness. `healthy`
requires an actual healthy Docker healthcheck; `running` only establishes the
declared process observation, not database or application health. Only Docker
bindings are supported in this increment; incompatible service runtimes refuse.

A service binding may declare `start: {app, target}`. When the service is absent,
start that configured infrastructure target through the normal direct
`env_execute` path. Once its container identity matches the
binding, the controller records a controller-wide shared service. Dependent run
operations acquire leases at dispatch. `env_stop` on the service owner refuses
while any lease exists; releasing the last dependent lease stops the exact started containers and
marks the shared service released.

Compose service `x-secret-refs` and target `secretRefs` are merged into declared
execution references; conflicting references refuse the target. The dependency
binding service is fixed to a trusted configured repository. It selects declared
target dependencies, freezes their exact container/image/network IDs and
creation/start generations in immutable review bytes, and revalidates without
substituting a replacement. It withholds environment values,
mounts, arguments and health logs. Error/invalid/oversized responses are unknown,
not absence; only a Docker 404 is absent. Shared absence returns an explicit
start-required refusal until the mutation controller exists; external absence
refuses. Owned dependencies cannot gain ownership through this borrowed path.
These preparations are **not durable execution permits**. No container
is started, attached, stopped or adopted, and no existing service configuration
or credentials are modified. A matching network alias is observed metadata, not
an independently verified DNS/connectivity or SQL ownership proof.

Targets identify build/test/run and shell/systemshell/Docker/Podman/Compose/
Kubernetes, but listing one does not claim live runtime availability. A target
that cannot normalize stays visible with a sanitized `executionIssue` code such
as `container-name-prefix`, `compose-service-count`, `kubernetes-invalid` or
`unsupported-provider`. The real v2 configuration has completed the
`environment-mcp-` Compose container-name migration.
An executable target adds a descriptor:

```json
{"id":"build","action":"build","runtime":"shell","executable":{
  "kind":"command","program":"/usr/bin/mvn","args":["-B","verify"],
  "envRefs":{"ARTIFACTORY_PASSWORD":"ARTIFACTORY_PASSWORD"},"timeoutSec":900
}}
```

```json
{"id":"mocked","action":"run","runtime":"compose","dependsOn":[{"service":"postgres"}],
 "executable":{"kind":"compose","socket":"/absolute/docker.sock",
  "file":"/absolute/mocked.compose.yaml","project":"installer-space-mw-mocked",
  "services":["installer-space-mw"],"readinessService":"installer-space-mw",
  "timeoutSec":300}}
```

BuildKit build secrets support the v2 modes directly: a template with declared
`.env`/process references, an absolute nonlinked file of at most 64 KiB, or a
declared environment reference. File/template contents are resolved only at
dispatch and never enter the execution plan or receipts; they are redacted from
build output. `command` runs a fixed absolute program with fixed argv (never a
shell string), an optional declared environment-reference map and a bounded
timeout. It covers
build/test and one-shot commands; exit 0 is completed, any other exit is failed.
`process` starts one fixed `/bin/sh -lc` command through a detached supervisor
that owns the process group and relays output. The supervisor PID/group is
recorded as owned; logs, stop and idle cleanup use only that live handle. Graceful
controller shutdown stops tracked groups, and a controller crash makes each
supervisor kill its group instead of leaving an orphan. A later controller never
adopts a saved PID; a surviving process is inspection-only and is never killed by
PID reuse. `compose` runs
`docker compose -p PROJECT -f FILE up -d SERVICES`, records the container IDs it
created as owned, and waits (at most 60 s) for readiness.
Readiness is reported with its source:

- `endpoint`: every declared `endpoints` URL answered with HTTP 2xx/3xx. This is
  application-level readiness.
- `docker-health`: every container observed by Docker is running and any declared
  healthcheck is healthy.
- `docker-running`: every container is running and no healthcheck/endpoint was
  declared. **This is not application health.**

The v2 `endpoints`/`endpointServices` fields are read directly when present:

```json
{
  "id": "mocked",
  "action": "run",
  "runtime": "compose",
  "endpoints": {"api": "http://127.0.0.1:8081/health"},
  "endpointServices": {"api": "installer-space-mw"},
  "compose": {"file": "compose.captured.yaml", "socket": "/absolute/docker.sock"}
}
```

Endpoints must be explicit `http`/`https` IP-loopback URLs without credentials or
fragments; each needs one service selector naming a service in the Compose source.
If endpoints are declared but the runtime cannot probe them, readiness is
`unknown`, never running-only success. Compose files may live under the user's
private configuration root; the canonical path is frozen into the review. No shell
string, caller command, model-authored argv or arbitrary environment is accepted.
Missing referenced environment variables refuse before issuance; their values are
redacted from command receipts and logs. Kubernetes Helm execution is implemented but no live cluster was available; Podman support is implemented but not live-verified in this environment.

Dependency lifecycle defaults to `shared`, following v1. The schema rejects
unknown fields, duplicate identities, missing dependency references, foreign
repositories and defaults naming the wrong action. Repository paths must be
explicit absolute existing directories; canonical identity is rechecked at reads,
and editing a manifest cannot widen the startup allowlist.

The pure lifecycle decision currently implements these rules, **not I/O**:

| Lifecycle | Ready matching existing service | Absent service | Automatic app cleanup |
| --- | --- | --- | --- |
| shared | Reuse without taking cleanup ownership | Start requires a configured start target/adapter | Never stop shared service |
| external | Reuse without lifecycle mutations | Refuse | Never |
| owned | Reuse only with current controller ownership | Start requires a configured start target/adapter | Only after last reference |

Unready matching services wait for readiness; unknown observation, mismatched
identity or foreign ownership of an owned service refuses. A decision is not
proof of identity/readiness, a lease, an execution permit or a live cleanup capability.

## Configuration doctor

Inspect a v2 configuration without starting a server or creating state:

```sh
bun dist/cli.js --doctor --config-dir /absolute/v2/config-dir
```

It emits a bounded JSON report with app/target counts, executable counts by kind,
unavailable targets, sanitized migration hints and `secretGaps` naming declared
references absent from the config `.env`/process fallback without printing
values. `env_execute` also refuses admission for a target with missing declared
references. It does not print commands, plans, credentials or repository
paths. The real v2 configuration currently
reports **117 executable targets and no unavailable targets**; the Compose
container-name migration, collector-telemetry normalization, Helm targets and
network-only bridge topology are complete. `secretGaps` now lists three remaining targets: Eon installer's EIV Jasypt
password and the hwportal/EFIX external credential sets (plus the frontend AEM
endpoint). Local Redis/Postgres/portal, Eon MySQL/datasource and grid mock values
were added from known local configuration. The three still refuse admission
until their external values are supplied.

## OpenCode cutover via the stdio bridge

OpenCode can keep a local stdio MCP entry while the environment authority runs as
the shared daemon. The bridge forwards the authenticated remote tool list and
calls; it creates no state, runtime or extra authority:

```json
"environment-mcp": {
  "type": "local",
  "command": [
    "/opt/homebrew/bin/bun",
    "/absolute/environment-mcp/dist/cli.js",
    "--connect",
    "--url", "http://127.0.0.1:PORT/mcp",
    "--token-file", "/absolute/private/environment-mcp-token"
  ]
}
```

Alternatively use `--token-env ENV_NAME` with the token in OpenCode's process
environment. The token file must be absolute, mode-0600 and owned by the current
user. Start the daemon separately with `--serve`; use a dedicated client entry/
token for this host. The bridge is tested through a real stdio MCP client against
the shared fixture. The local OpenCode `environment-mcp` bridge is the single
environment authority; the legacy `agentic-environments` entry was removed.

## OpenTUI and capability parity

Every agent action is declared once in `src/interface/capabilities.ts`. MCP tools
and the OpenTUI action API are two entry points over that registry. The UI uses an
authenticated capability transport on the shared HTTP listener:

```sh
bun dist/cli.js --ui \
  --url http://127.0.0.1:PORT/mcp \
  --token-env ENV_MCP_CLIENT_KEY \
  --title "Environment MCP"
```

The token environment variable is the same client key configured in
`clients.json`; only loopback HTTP URLs are accepted. Prefer a distinct client
entry/token for the human UI so its scope and receipts do not race an agent's
scope. The TUI executes agent-capability actions directly. It lists the capabilities
from the server, renders the action's JSON-Schema fields, invokes the same registry
handler MCP uses, and shows the structured result. `q` quits, `r` refreshes,
`Esc` returns/cancels, and Enter submits on the last field. `--ui` requires
`@opentui/core`, which is a normal package dependency; a `dist/cli.js` copied
without `node_modules` still runs stdio/shared MCP but not the TUI.

`src/ui/opentui.ts` exports `mountEnvironmentTui(renderer, api, {mount, onQuit})`
for an OpenCode-hosted OpenTUI root, and `runEnvironmentTui` for the standalone
host. `bun run build` also emits `dist/ui/index.js`, exposed as
`environment-mcp/ui`, so a plugin can import the controller/view without the CLI. If the plugin cannot expose a `CliRenderer`, it can use the exported
`createEnvironmentUiController` with `createHttpUiCapabilityApi` and render the
same states with its own OpenTUI components. The renderer imports only the UI
contract; it never imports MCP registration, listeners or service construction. `test/capability-parity.test.ts`
checks registry/MCP/UI names and schemas; the shared-server scenario checks the
real MCP tool list against the HTTP UI list. Execution is direct; there is no
approval surface or approval capability.

### OpenCode TUI plugin

`opencode-plugin/` is a local OpenCode 2.0.22 TUI plugin that presents the
environment inventory and execution surfaces, not the MCP tool list. It
registers a full-screen `environment` route, `/environment`/`/env`,
`<leader>v`, and a clickable home-footer chip. The shell has Applications,
Libraries, Infrastructure, History and Services tabs; the inventory shows
glyph target summaries (`⚒` build, `✓` test, `▶` run), git branch and
modified/added/deleted counts with ahead/behind, and current run status;
application detail with git/status, targets, owned resources and recent
receipts; a target picker; a live operation view with build steps/logs; and
owned logs and telemetry. An authenticated SSE invalidation stream updates
status/history/git while the panel is open; 15s/30s reconciliation polling
covers missed events and external changes. Build/test/run execute directly and
stream progress before showing the settled receipt. The plugin never constructs MCP registration, listeners, journals,
runtime adapters or an approval surface.

Install locally by linking the package where OpenCode discovers local plugins:

```sh
mkdir -p ~/.config/opencode/plugins
ln -sfn "$PWD/opencode-plugin" ~/.config/opencode/plugins/environment-mcp
opencode plugin list
```

Open with `/environment`, `/env`, or `<leader>v` (default `ctrl+x v`). Override
`ENVIRONMENT_MCP_URL`/`ENVIRONMENT_MCP_TOKEN_FILE` or pass `url`/`tokenFile`
plugin options. The plugin package has its own type-check/test dependencies;
`bun run --cwd opencode-plugin type-check` and `bun run --cwd opencode-plugin test`
are the focused gates, while the server package's lint/type-check/test also
cover its sources. The adapter generates a fresh `requestId` for each exact
review. The current capability registry does not yet expose git
branch/fetch/worktree operations, container stats, Kubernetes cluster
inspection, provider change requests/issues/pipelines, or app/task CRUD; those
screens are intentionally not claimed until the corresponding capabilities
exist.

## Read-only v2 catalog compatibility

This explicitly selected reader copies **only public catalog metadata** from an
existing v2 definitions file. It does not import execution settings, dependency
bindings, credentials, native state or ownership, and does not call either app's
configuration loader:

```sh
bun dist/cli.js --format v2-catalog \
  --config /absolute/v2/environments.json \
  --repository /absolute/repository
```

Repeat `--repository` for every authorized root. This is separate from the
standalone manifest, whose repository allowlist is in the manifest itself.
The response states `validation: v2-catalog-metadata-only` and
`dependencyDeclarations: not-imported`; discarded execution fields have **not**
been validated as runnable plans. No implicit v1/v2 configuration discovery.

## MCP contract and bounds

`env_list({repository?, offset?, limit?})` returns `apps`, each with public target
and declared dependency metadata, `total`, `nextOffset` and explicit inspection-
only semantics. It is the new package contract, not a byte-compatible replacement
for either existing tool output. Offset defaults to 0; page size defaults/maxes to
10. Configurations are bounded to 256 KiB, 64 repositories/apps/services and 256
total targets. MCP stdio input is bounded to 64 KiB; result JSON to 128 KiB.
Symlink configuration files and changed directory/allowlist identities refuse.
This is not an OS sandbox against same-user filesystem replacement races.

## Shared controller and exact dependency review

Use the standalone manifest, an existing canonical user-owned mode-0700 state
directory outside every authorized repository, and explicit client definitions:

```json
{
  "version": 1,
  "clients": [{
    "id": "developer",
    "repositories": [
      "/absolute/canonical/repository",
      "/absolute/another/repository"
    ],
    "tokenEnv": "ENV_MCP_CLIENT_KEY"
  }]
}
```

A legacy single `repository` field remains accepted. Each repository gets its
own scope, owned ledger and operation authority; tools route by an explicit
`repository` or by an unambiguous app identity. `env_status` and `env_history`
accept `repository`; ambiguous app actions refuse instead of guessing. Supply a
securely generated client key through the named process environment
variable; do not put credentials in either JSON file. Then start one controller:

```sh
bun dist/cli.js --serve \
  --config-dir /absolute/v2/config-dir \
  --state-dir /absolute/private-state \
  --clients /absolute/clients.json [--idle-timeout-sec 1800]
```

Optional `--port` pins the listener port; otherwise an ephemeral
numeric-loopback port is used. Optional `--idle-timeout-sec N` stops owned
apps and closes clean scopes after N seconds without any capability use; it is
disabled by default. A busy, in-flight or inspection-required operation keeps the scope open. Observation of a closed scope never reopens it;
the next execution action creates a fresh scope, while historical operation,
history, log and telemetry reads remain available. Borrowed services are never
touched. The HTTP MCP endpoint is `/mcp`. Client keys
bind to fixed principals and one or more repository scopes at startup, never to
caller-authored owners or automatic OpenCode session IDs. This is local bearer auth,
not OAuth or a remote deployment. Compatibility metadata input is not accepted
as a shared-controller manifest. No application starts automatically.

### Agent MCP tools in shared mode

- `env_telemetry({app, traceId?})` reads the bounded in-memory OTLP/HTTP JSON
  logs and trace summaries captured for one owned shell run or Compose collector
  telemetry capture; a trace id returns its spans and parent/child tree, which
  the agent OpenTUI renders as an indented terminal tree. Borrowed services are
  never captured.
- `env_services({})` lists configured service bindings, their optional
  `start: {app, target}` descriptor, readiness and controller-wide shared state/
  leases. It is observation only; start through `env_execute` on the declared
  target.
- `env_history({offset?, limit?})` lists recent durable operation summaries for
  this scope: state, revision, occurrence time, inspection marker and whether a
  result exists. It omits frozen plans, borrowed identities, credentials and
  resource handles. Use `env_operation` for one receipt.
- `env_execute({requestId, app, target})` admits and dispatches one configured
  target directly. The same request id and intent returns the same operation; it
  never re-runs. Command exits are reported exactly (nonzero = failed). Compose
  startup claims the containers it created and reports `starting` until endpoint,
  Docker health or running readiness passes (bounded 60 s). Each receipt names
  `readinessSource`; running-only is not claimed as application health.
- `env_git({repositories?})` reads bounded branch, dirty-file, ahead/behind and
  detached-HEAD status for the authenticated repositories. It is read-only and
  never fetches, checks out, stages or commits.
- `env_git_changes({repository})` lists bounded changed paths with staged/
  worktree status, relative to the application repository; paths outside it
  are omitted.
- `env_git_diff({repository, path})` returns one bounded unified diff for a path
  from the current change list. Untracked regular files are diffed against
  `/dev/null`; binaries, directories and symlinks are refused. It is read-only
  and does not fetch, check out, stage or commit.
- `env_wait({operationId, waitSec?})` waits up to 120 seconds for an issued
  operation to settle and returns its current receipt.
- `env_status({})` reads scope state and owned container IDs. Borrowed services
  never appear and are never stoppable through this surface.
- `env_stop({app})` removes only containers or stops only shell-process groups
  recorded as created for that app in this scope. Partial cleanup leaves the
  remainder recorded, not forgotten.
- `env_logs({app, tail?})` reads bounded Docker/process logs from owned resources only,
  with configured secret values redacted. A successful stop captures the last
  bounded redacted log window in memory, so a later read returns
  `historical: true` and `retainedAt` for this controller lifetime. It is not
  durable across restart.
- `env_operation({operationId, progressOffset?})` reads this scope's immediate
  durable receipt, or live redacted output for an issued operation. Pass the
  returned offset to receive only newer output; `reset` replaces the local
  buffer. Live output is in-memory and bounded, and is not a poll loop,
  implicit retry or resource capability.

### Execution and diagnostics

Execution is direct: `env_execute` admits and dispatches the exact configured
target in one step, and `env_wait` observes the receipt. There is no approval
listener, access file or operator API. The private bounded diagnostics log at
`STATE_DIR/diagnostics.jsonl` remains available for local troubleshooting; it is
never an HTTP surface and never contains plans, arguments or credentials.

### Storage, restart and shutdown

`env_refresh({})` reloads the v2 environment definitions for future executions
without restarting the shared HTTP server or discarding receipts and retained
logs. It is also available through the registry-derived UI capability transport.
Stop owned apps and let active operations settle first: refresh refuses with
`configuration-busy` if **any client** has owned resources, open/uncertain work,
or another capability request in progress. Refresh never stops resources itself.

The reload validates the complete configuration before synchronously publishing
it. Invalid input or a changed repository allowlist returns the sanitized
`configuration-refresh-invalid` refusal and leaves execution definitions unchanged.
Client bindings, authorization and secret values (including `.env`) are not
reloaded; restart for those changes. Referenced configuration sources are read
through the normal loader; no commands or readiness probes run during refresh.
`env_list` remains a fresh inspection of files on disk, not proof that execution
has refreshed. After editing definitions, call `env_refresh` successfully before
executing with a **new request ID**; existing request IDs retain their old receipt.

The package owns `environment.sqlite` with its own application/schema identity;
it never opens native v1/v2 state. `diagnostics.jsonl` is a separate bounded,
sanitized event log for controller troubleshooting; it never contains credentials,
plans or tool arguments. Synchronous `BEGIN IMMEDIATE` transactions and
FULL durability fence operation transitions. A private directory lock permits
one controller; no PID/age-based lock takeover. Startup interrupts prior active
scopes and in-flight operations. Only previously issued uncertainty is marked
inspection-required; it is never reissued automatically. Historical receipts
remain readable.

The initial journal caps retained scopes at 64, operations at 128, plans at 128 KiB and result receipts at 32 KiB. At scope capacity the journal
evicts only the oldest inactive scope with no owned resources, no live review/
issuance and no inspection-required uncertainty; active/scoped-resource history is
never silently deleted, and capacity refuses when no safe scope exists. This is
bounded retention, not idle expiry. Model tools cannot choose another state file
or send executable plans.
Normal SIGINT/SIGTERM joins listener shutdown and releases the original lock. Changed files or uncertain
close retain inspection barriers. After a crash, confirm the old host is stopped
before inspecting any stale lock/access file; do not delete the database to force
reuse. Owned cleanup is limited to resources recorded by issued operations.

## Live installer-space prerequisites

The repository is configured for a real Mocked attempt, but three external inputs
are still required and none may be guessed:

1. **Build credentials.** The image does not exist locally and the v1 Dockerfile
   requires a BuildKit `settings` secret for Artifactory. This package does not
   read `~/.config/agentic-coding/.env`. Either add a `docker-build` executable
   with an explicit file-path secret reference, or build externally and declare
   the resulting immutable image. Template, file and env BuildKit secret modes are
   supported now.
2. **Redis.** Only PostgreSQL is running. The Mocked app also needs Redis. A
   Compose file may start Redis as an **owned** service on the existing
   `document-service-mocked_devenv-local` network while borrowing PostgreSQL; that
   plan is executed as a whole. Existing PostgreSQL must not be recreated,
   reconfigured or attached.
3. **Application secret.** The app references `ICON_APPLICATION_MASTERPASSWORD`;
   it must be supplied as a declared reference at daemon start, never written into
   the manifest or a result.

Once those are provided, start the shared server with the new manifest, execute
the exact build and Mocked targets through `env_execute`, inspect bounded
logs/status, and stop only owned containers. No
existing container or volume may be removed. This live step has **not** been run;
the current suite uses fakes and does not certify Docker/Compose/PostgreSQL parity.

## Capability parity with the OpenTUI

All agent actions are declared once in `src/interface/capabilities.ts`. MCP tools
and the OpenTUI action API are two entry points over that registry. A standalone
OpenTUI injects an in-process registry; the OpenCode plugin uses the same
interface over the authenticated loopback HTTP transport. `test/capability-parity.test.ts` verifies identical action
names, shared input schemas and neutral UI labels, and rejects entry-point-local
action tables. The standalone renderer and built `environment-mcp/ui` entry are
implemented.

## Development and verification
```sh
bun run lint
bun run type-check
bun run test
```

The complete standalone suite is currently 58 tests across 26 files. It
covers v1 lifecycle decisions, strict manifest validation, the copied-artifact
stdio contract, the Unix-socket Docker observer, direct execution/idempotency,
owned-only cleanup, multi-repository routing, idle scope closure/rebinding, container telemetry, trace browsing,
the environment model/keybind helpers,
fake-runtime command/Compose execution and fake-binary network/Helm lifecycle
behavior. The suite itself does not start a real Docker/Compose/Kubernetes/Helm runtime,
database or engine. A separate disposable live Docker check created a temporary
bridge, ran a Redis container, attached it to a temporary Compose service,
confirmed removal refusal while attached, then removed the container, Compose
project and bridge. A second live check started a temporary Compose OpenTelemetry
collector with a generated TLS receiver configuration, posted synthetic OTLP
JSON through its HTTP receiver, and captured the exported trace. A third live
check created a disposable kind cluster, installed a tiny Helm chart with the
real executor, waited for the Deployment to become available, uninstalled the
release and deleted the cluster. A fourth live check used an installed Podman
machine: built a local image, ran a Podman Compose service, resolved its
container ID, created a bridge, ran a container, attached it, confirmed removal
refusal while attached, then removed all resources. No test resource remained;
the Podman machine was stopped afterward.
See the OpenSpec change verification notes for measured runs and limits.

A separate lightweight local Unix-socket HTTP fixture verifies the read-only
Docker adapter and dependency binding service: ready reuse, identity freezing/
replacement refusal, withheld Env/health-log values, unready/absent/unknown
distinctions, response-size bounds and refusal to borrow as owned. It asserts
only GET requests occur. This fixture is not a real Docker daemon or database.

One combined durable journal/HTTP MCP scenario verifies scope isolation, direct
execution, one-time dispatch, immutable replay and conservative reopen using a
fake inspection boundary. One copied-artifact shared CLI scenario checks the
single capability surface, private state and shutdown of the original listener.
A separate fake-runtime scenario verifies direct build/test/Compose execution,
one-time dispatch, nonzero-exit failure, env-reference redaction, owned-container
status/logs/stop and the absence of borrowed services from cleanup. It does not start Docker, a Compose project or a database.

See [PROVENANCE.md](PROVENANCE.md) for copied/adapted behavior and the active
`mcp-v1-environment-parity` OpenSpec change for the remaining work.

See [docs/architecture.md](docs/architecture.md) for the MCP-focused module
boundaries, source-backed v1 parity matrix and installer-space dependency trace.
