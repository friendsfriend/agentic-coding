# Standalone foundation (tasks 0.1–0.4)

## Live installer-space Mocked attempt (task 3.2)

The old v2 temporary controller is stopped; its pending plans were never approved
and cannot be approved (no access file), so they are inert rather than rearmed.
A private copy of the v2-shaped configuration was used with:
- explicit `serviceBindings.postgres` for the running document-service-mocked
  container (identity/network frozen, `cleanup: never`);
- a Mocked Compose source owning only Redis + installer-space-mw on the existing
  `document-service-mocked_devenv-local` external network;
- the v2 `.env` mechanism for three declared references (build credentials and
  the application master password), values never printed.

Results through the real shared MCP/operator boundary:
- Build plan reviewed/approved, built via `docker-build` and **succeeded**:
  image `devenv-installer-space-mw:latest`, exit 0. The first attempt exposed and
  fixed two server defects: output-bound truncation killed the child (now drains
  without killing and keeps the tail), and long `env_run` was tied to the request
  socket (now returns after durable issuance; `env_wait` provides a bounded wait).
  The build also initially failed on a genuine Artifactory **403** for the
  Maven surefire site descriptor; the private config added
  `-DskipSurefireReport=true -Dmaven.site.skip=true` to get past that repository
  permission issue. This is a local config deviation, recorded here.
- Mocked plan reviewed/approved; compose started Redis + app, recorded both exact
  container IDs as owned, reported Docker `ready`; PostgreSQL was verified as a
  borrowed observation and never entered the owned ledger.
- The application container then **exited (1)**: its logs show Azure Key Vault
  credential discovery failing (Environment/Workload/Managed Identity/CLI all
  unavailable). This is application/profile configuration, not an MCP defect;
  application readiness was **not** achieved. Docker running-state readiness is
  not application health, as documented.
- `env_stop` removed exactly the two owned containers; the borrowed PostgreSQL
  remained running (now subsequently removed by the operator).
- The operator then removed the old document-service containers. The private v2
  configuration now owns PostgreSQL + Redis + the app under one Compose project
  and network, **`environment-mcp`**, with container names `environment-mcp-*`.
  A fresh start created all three containers with
  `com.docker.compose.project=environment-mcp`: PostgreSQL and Redis stayed up;
  the app again exited (1) on the same Azure Key Vault credential failure. The
  group/naming requirement is implemented and verified; application readiness
  still needs Key Vault/profile credentials.

This closes the live exercise honestly: build and dependency-reusing startup work,
but a successful application start still needs the app's Key Vault/profile
credentials. The generated image remains in the local Docker engine.


## V2 configuration reuse (post-review pivot)

The user directed that the configuration structure stay the same as v2. The
standalone package therefore reads `CONFIG_DIR/environments.json` and
`CONFIG_DIR/config.json` directly as its public runtime configuration. The
internal strict manifest and metadata-only catalog reader remain only as fixture/
inspection formats behind explicit `--config FILE`/`--format` options.

Mapping (no file-shape conversion required): v2 shell/systemshell targets become
fixed `/bin/sh -lc <configured command>` executions with literal `environment`,
`secretRefs`, and timeout; v2 Docker build targets with `container.dockerfileSource`
become BuildKit builds with the configured `buildSecrets` templates and references;
v2 Compose run targets become `docker compose` over the declared file or inline
source with project/services read from YAML; Podman is provider-aware and
Kubernetes Helm releases are executable, without a live cluster claim. The optional additive `serviceBindings` section declares explicit
borrowed Docker identities for targets that name `requires`; without it the
dependency review refuses instead of guessing from a name. Compose connectivity is
exactly what the reviewed source declares; nothing attaches or reconfigures an
existing service.

Secrets use the v1/v2 UI mechanism: `CONFIG_DIR/.env` is parsed once with Node's
`parseEnv`, process environment is the fallback, and only declared references are
resolved at dispatch. Values are never written to plans/state/tools and are
redacted from command/build/log output. Dockerfile and Compose inline sources are
materialized only in private mode-0700 temporary directories and removed after use.

Verification: standalone complete suite **11 pass, 0 fail, 0.589 s** (136
assertions) including direct v2-structure mapping and `.env`/template tests; lint
and whole-project type-check are clean. This batch did not run the unfiltered v2
suite again because no v2 source changed; the preceding saved run remains 289
pass, 0 fail, 16.13 s. Live installer-space acceptance (3.2) remains open: the
image is absent and the build/start still require an exact reviewed plan and the
application/Redis secret references. No live container was started or modified.

## Durable approval, shared serving and executable ledger (2.2–2.4, 3.1)

Implemented private standalone SQLite (`environment.sqlite`, own application/
schema identity) with synchronous `BEGIN IMMEDIATE`/rollback, one exclusive
directory lock, environment-native scopes and a single strict document. Startup
interrupts prior active scopes and pending/approved/issued operations; only prior
issued work is inspection-required, and no saved container/process authority is
restored. Exact digest/revision/serialized decision records are content-bound;
replayed decisions and admissions return original receipts rather than resolving
today's resources.

Added separate authenticated operator HTTP inspection/decision endpoints, bounded
bodies/in-flight work, Host/Origin/credential checks and sanitized errors. Added
one shared MCP HTTP listener whose client definitions and credential references
are validated before state opens and whose per-request SDK factories receive
fixed principal/scope sessions. Added explicit shared CLI mode, exclusive mode-
0600 operator-access publication, and shutdown that joins listeners and removes
only the original unchanged option file/lock. Agent keys cannot authenticate to
the operator API; the operator key cannot authenticate to MCP.

Added frozen executable reviews for configured command build/test/run targets and
Compose run targets. A command is a fixed absolute program + argv with declared
environment references; a Compose plan names socket, canonical file, project and
services. Admission never executes. The internal runtime boundary re-observes
frozen borrowed dependencies, durably issues once, then dispatches through a
fixed-argv process adapter. Nonzero command exits are failed receipts. Compose
startup claims only the exact container IDs it created and waits at most 60 s for
Docker running state; it reports `starting`/`running`, never application health.
Configured secret values are redacted from command receipts and owned-container
logs. `env_stop` removes exact owned container IDs only. Borrowed PostgreSQL/Redis
are structurally absent from the owned ledger, so stop/close cannot reach them.

Added the owned-resource ledger with append-under-issued-permit and two-phase
scope close. Confirmed cleanup deletes only its own records; uncertain cleanup
retains them and marks the scope interrupted. A copied permit, foreign scope or
previous host cannot claim or complete resources. This completes the current
v1-compatible execution surface: shared-dependency start and automatic
last-lease cleanup, Compose collector telemetry and Kubernetes Helm are implemented;
idle scope closure, network-only Compose, restart adoption, a dedicated trace
browser and slot-queue acquisition remain pending.

### Verification and boundaries

- Standalone complete unfiltered suite: **9 pass, 0 fail, 0.601 s** (123
  assertions) across 6 files. Latest saved pre-batch JUnit was **7 pass, 0.497 s**;
  an intermediate owned-ledger run was 8 pass, 0.426 s. These are sequential
  development measurements, not a portable timing threshold or a claimed speedup.
- New fake-runtime execution scenario covers approval-gated dispatch, one-time
  command/Compose execution, nonzero-exit failure, environment-reference
  redaction, owned status/logs/stop, and asserts that no borrowed-service name
  reaches a stop/cleanup call. It uses no real Docker, Compose project or database.
- Existing copied-artifact stdio/shared scenarios still pass; the shared CLI
  fixture verifies credential separation and removal of only its own access file.
- Existing V2 complete unfiltered suite (unchanged by this batch): **289 pass,
  0 fail, 16.13 s**. Its unchanged 12–15 s working target is still exceeded; no
  timeout/retry/exclusion/concurrency setting was altered. Against the saved
  preceding batch (17.46 s) this is measurement variation, not a performance claim.
- Original-package lint/boundaries/type gate: **71 pass, 0 fail, 6.87 s**.
- All three packages pass Biome and whole-project `tsc --noEmit`.
- Strict OpenSpec validation passes; `git diff --check` is clean.
- No live installer-space build/start was attempted, no existing container or
  volume was modified, and no OpenCode connection was switched. Read-only
  prerequisite inspection found: the `devenv-installer-space-mw:latest` image is
  absent; only the existing PostgreSQL container is running on
  `document-service-mocked_devenv-local`; Redis is not running; Maven exists on
  PATH; the v1 `.env` contains Artifactory variable names (values were never
  read or printed). The old temporary v2 controller is stopped and its pending
  plans were never approved; its access file is gone, so they cannot be approved
  now. The live acceptance task 3.2 remains open and needs an explicit build-
  credential reference, an owned Redis decision and the application secret
  reference before any plan can be approved.

Artifacts: `standalone-execution-after`, `standalone-execution-v2-after`,
`standalone-approval-after` and `standalone-approval-v2-after` JUnit/log pairs in
the approved temporary directory.

## MCP naming refactor and dependency bindings (0.5, 1.1–1.2, 2.1)

Refactored standalone package identity to `environment-mcp`; renamed internal
symbols and organized modules into MCP registration, CLI options, configuration,
compatibility import, domain, services and runtime adapters. CLI flags, tool
names/outputs and existing refusal behavior were not changed by the refactor.
The original unfiltered suite passed before the refactor (**3 pass, 0 fail,
0.295s**) and again after the naming-only phase (**3 pass, 0 fail, 0.204s**),
before the separate implementation increment below.

Added trusted Docker dependency binding descriptors for exact socket, container,
image, expected labels, network/alias and explicit running/healthy readiness.
These are server configuration, not MCP caller arguments. Added a narrow read-
only container inspection port/Unix-socket Engine adapter and repository-bound
dependency service. Ready shared/external observations become immutable review
bytes/digest binding container/image/network IDs and creation/start identity;
revalidation compares fresh observations without replacing the original review.
Inspector Env, mounts, command arguments and health logs do not enter the
projection. Owned prerequisites cannot obtain handles by observation. Only a
404 is absence; transport/server/JSON/size failures remain unavailable/unknown.
No create/attach/start/stop/delete endpoints exist in this adapter.

This increment later became durable human approval and issuance in the batch
above; at the time it verified observation/preparation only. Shared creation,
owned dependency reference counting, the live acceptance case and richer
diagnostics remain pending. It deliberately advertised no mutation tools and
changed no OpenCode connection.

The source-backed v1 parity matrix and actual Mocked configuration trace are in
`environment-mcp/docs/architecture.md`. Inspection established that the v1 app
template includes Redis/PostgreSQL/network files and uses depends_on, but does
not declare the existing document-service project's network as external. The
service/network mapping must therefore be explicit in the new reviewed plan;
the trace does not certify that cross-project borrowing already works in v1.
No `.env` was read or secret reference expanded; no real runtime was invoked for
this batch. Existing PostgreSQL and its volume remain untouched.

### Gates and measurements

- Independent frozen install, build, lint and whole-project type-check pass.
- New package complete unfiltered suite: **5 pass, 0 fail, 0.280s** (43
  assertions). The copied-bundle stdio scenario remains one public boundary;
  new schema/lifecycle cases remain direct, and the borrowed-service scenario
  uses one disposable Unix-socket HTTP fixture, not Docker or PostgreSQL.
- JUnit: the new binding test file costs **0.016s**; its direct schema case costs
  **0.0004s**, combined read-only adapter/service case **0.0115s**. Existing file
  costs **0.246s**, with its stdio scenario **0.175s**. Timing differences from
  the initial/refactor runs are not claimed as speedups or portable assertions.
- The socket fixture exposed Bun/macOS realpath failure on socket files; the
  adapter now resolves directory identities and explicit symlink hops without
  opening a socket as a regular file. This was fixed rather than excluding the
  transport test, changing a timeout or adding retries.
- Existing packages retain clean lint and whole-project type-check. Original-
  package boundary gate: **71 pass, 0 fail, 12.24s**.
- Existing V2 complete unfiltered suite: **289 pass, 0 fail, 17.85s**. No V2
  source/tests were changed by this batch; the separate package is not imported
  into that suite. Its unchanged 12–15s working target remains exceeded. Against
  the saved earlier `mcp-parity-after` batch (**16.14s**, not a fresh pre-edit
  baseline), largest existing-file changes were source-base +1.075s,
  mermaid-vendor +0.253s, runtime +0.191s, HTTP requests +0.057s and daemon
  +0.055s. Concurrent unrelated work/load and the older comparison limit
  attribution; no slower budget is accepted. No timeout/retry/exclusion/
  concurrency settings were changed.
- Strict OpenSpec validation passes. Changes remain uncommitted.

Final logs/JUnit artifacts use `standalone-bindings-after` and
`standalone-bindings-v2-after` in the approved OpenCode temporary directory.

The user's revised architecture is implemented as a fresh `environment-mcp/`
package, not an adapter importing either coding application. Its own package/
lockfile, official MCP SDK, Zod, Bun build, TypeScript and Biome configuration
require no Pi, workflow, provider or OpenTUI dependencies. Source origins and
adaptations are recorded in the package's `PROVENANCE.md`.

Implemented: strict versioned environment-native selection/dependency manifest;
separate explicitly selected metadata-only v2 reader; bounded no-follow/changed-
file reads; explicit canonical repository authorization rechecked on reads;
bounded strict MCP catalog input/output; pure v1 shared/external/owned lifecycle
decision rules; a fresh stdio composition and self-contained built artifact.

Not implemented/advertised: runtime mutation descriptors and adapters, state/
scope/approval/issuance journal, HTTP shared authority/operator listener, actual
dependency readiness/network observation, diagnostics or build/start/stop tools.
The new manifest declares identities/selection/dependencies, not executable
authority. The v2 compatibility reader explicitly discards unvalidated execution
fields and does not import dependency bindings, credentials or native state.
This foundation is not the final runtime migration or behavioral parity claim.

## Verification

- Independent `bun install --frozen-lockfile`: passes without lock changes.
- New package build: 98 bundled modules, approximately 0.75 MB `dist/cli.js`.
- New package lint and whole-project type-check: pass with zero diagnostics/errors.
- New package unfiltered suite: **3 pass, 0 fail, 0.204s** (25 assertions), plus
  approximately 0.010s build in the final measured run. This is the first package
  baseline, not an asserted portable timing threshold. The earlier failed run
  exposed an incorrect SDK transport constructor argument; it was corrected,
  not hidden by changing timeouts or retries.
- One representative SDK stdio scenario copies only the bundle outside the
  checkout, exercises a 41-project/>64 KiB catalog, final-page selection,
  secret/command withholding, authority/size refusal and absence of execution.
  Native manifest/schema and lifecycle tables stay in direct production-rule
  tests without extra runtime/database/server fixtures.
- Manual read-only built-stdio check against the actual installed v2 file:
  **41 project IDs and 117 target IDs match exactly**. No real credentials,
  engines, databases, containers, clusters or configured commands invoked.
- Existing packages retain clean lint and whole-project type-check; original
  package's boundary gate: **71 pass, 0 fail, 7.15s**.
- Strict validation of the revised OpenSpec change passes.

The preceding startup-limit correction in the old controller was separately
verified with **289 pass, 0 fail, 16.17s** and both existing packages' gates. It
only aligned a missed 32-project execution-startup cap with shared native limits;
it is not evidence that the new package executes live apps. No runtime adapters
were changed by this foundation batch.

## Preserved live state

The existing global catalog and installer-space scoped OpenCode connections still
point at the old implementation. The temporary old shared controller holds two
unexecuted installer-space plans; neither has human approval. The existing
PostgreSQL remains untouched. No old implementation files were deleted, no
connection was switched, no native state was imported and no commit was made.

## Capability/UI architecture (task 3.4)

Added `src/interface/capabilities.ts` as the single action registry (name,
description, Zod input/output, MCP annotations, neutral UI label, handler). MCP
registration (`src/mcp/tool-surface.ts` + `create-server.ts`) and the
server-independent OpenTUI API (`src/ui/capability-api.ts`) both derive from it.
`test/capability-parity.test.ts` asserts equal names, identical input-schema
identity, nonempty UI labels, and fails if either entry point embeds its own
`env_*` table. A standalone TUI injects an in-process registry; an OpenCode plugin
can inject the same interface over RPC/HTTP. Operator approval remains a separate
human-only surface and is not an agent MCP/UI action. The TUI renderer and plugin
transport are not implemented yet; the interface they require is.

Standalone suite: **13 pass, 0 fail, 0.553 s** (181 assertions); lint and
whole-project type-check clean. No runtime/transport behavior changed by this
refactor; existing shared-server and execution tests still pass.

## OpenTUI/capability transport and readiness (task 3.5)

Added the authenticated capability transport on the shared loopback listener:
`GET /capabilities` and `POST /capabilities/<name>` call the same
`EnvironmentCapabilities` registry as MCP. The standalone OpenTUI uses
`createHttpUiCapabilityApi`, renders fields from each action's JSON Schema, and
invokes the same handlers. `mountEnvironmentTui` accepts an existing renderer
root for embedding; `runEnvironmentTui` owns the terminal for standalone use.

PTY smoke evidence (fixture server, no real application): the TUI listed all
`env_*` actions, opened `env_status`, invoked it through the capability endpoint,
rendered the structured scope/owned result and quit with `q`. This proves the
UI/server/registry path, not application readiness or production deployment.

Readiness now has an explicit source. Compose receipts report `endpoint`,
`docker-health` or `docker-running`; configured loopback `endpoints` are probed
with the v1 2xx/3xx rule, Docker healthchecks are observed through `docker
inspect`, and a declared-but-unprobeable endpoint reports `unknown`. BuildKit
secrets now resolve v2 template, absolute-file and declared-environment modes at
dispatch without serializing values into plans/receipts; file secrets are
no-follow, regular/nonlinked and bounded to 64 KiB.

Standalone suite: **17 pass, 0 fail** (214 assertions); lint and whole-project
type-check clean. The architecture test also scans `src/ui/**` and rejects imports
of MCP, services, operator, persistence or a Bun listener. Tests cover UI controller typing/defaults, real MCP-vs-HTTP-UI
parity over the copied CLI, endpoint probing, and v2 template/file secret
resolution. Live installer-space app readiness remains blocked by missing Azure
Key Vault/profile credentials and the absence of a configured app health endpoint.

## Operator approval TUI and acknowledgement (task 3.6)

Added `src/operator/client.ts`, `controller.ts` and `opentui.ts`: a human-only
OpenTUI over the authenticated operator API. It lists operations, inspects the
exact frozen plan, submits approve/reject decisions fenced by digest/revision, and
acknowledges an inspection-required interrupted revision. `--operator-ui` accepts
the private mode-0600 access file or an explicit loopback URL plus token-env. The
built `environment-mcp/operator-ui` entry is separate from `environment-mcp/ui`
and is never in the agent capability registry.

The journal now persists exact acknowledgement receipts (`acknowledgements`) and
clears `inspectionRequired` only for an interrupted operation at the reviewed
revision. Replay is idempotent; a stale digest/revision is refused. It never
re-arms approval/issuance, restarts work or restores handles.

PTY smoke evidence (fixture executable review, no real build): the operator TUI
listed the awaiting-approval operation, inspected the exact plan, confirmed
approval and displayed `approved` at revision 2. The agent capability list remained
unchanged and did not expose any approval action.

Standalone suite: **19 pass, 0 fail** (231 assertions); lint and whole-project
type-check clean. The v2 suite was last run at **289 pass, 0 fail** (16.35 s) and no
v2 source changed in this task batch.

## Local stdio bridge (task 3.7)

Added `--connect --url <loopback>/mcp` with `--token-env` or a private absolute
`--token-file`. The bridge uses the official MCP client over authenticated HTTP
and the low-level stdio server to forward `tools/list` and `tools/call`; it opens
no journal, scope, listener, service or cleanup authority and never prints the
token. The copied-artifact shared scenario now spawns the bridge as a real stdio
MCP server, lists the same tools, invokes `env_list`, and closes it. This provides
a local OpenCode cutover path while leaving the existing OpenCode entries
unchanged for explicit operator approval.

Standalone suite: **19 pass, 0 fail** (233 assertions).

## Bounded operation/log history (task 3.8)

Added `env_history({offset,limit})` as a read-only capability over the durable
journal. It returns only this authenticated scope's summaries (state, revision,
createdAt, inspectionRequired, historical, hasResult) and omits plans, identities,
credentials and owned handles. MCP and OpenTUI derive it from the same registry.

A successful `env_stop` now captures the last 200 redacted log lines before
removing owned containers and retains them in memory for the controller lifetime.
A later `env_logs` returns `historical: true` with `retainedAt`; it never reads a
borrowed service and is explicitly not durable across restart. Tests cover the
history shape/scope fence and retained-log redaction.

Standalone suite: **19 pass, 0 fail** (244 assertions). Durable diagnostics and
telemetry remain open.

## Safe scope retention (task 3.9)

At the 64-scope cap, scope creation now evicts one oldest inactive scope only when
it has no owned resources, no awaiting/approved/issued operation and no
inspection-required uncertainty. Active/closing scopes and uncertain work are
never evicted; if no safe scope exists, creation still refuses with
`journal-capacity`. Eviction removes the scope's operation/request/decision/
acknowledgement records together. Direct tests cover active refusal and oldest
inactive eviction. This is bounded retention, not idle expiry.

Standalone suite: **21 pass, 0 fail** (247 assertions).

## Idle owned-app cleanup (task 3.10)

Added `--idle-timeout-sec N` (default 0/disabled). Every capability invocation
touches the client activity stamp through both MCP and the UI transport. The
reaper runs on a timer, skips a client with an active operation, stops only apps
from the owned ledger, never touches borrowed services, and leaves the scope
active. Failed cleanup retains the owned record and is retried. This is not full
idle scope closure/rebinding, which remains pending.

Direct tests cover stale/fresh/busy/empty clients and failed-cleanup retention.
Standalone suite: **23 pass, 0 fail** (257 assertions).

## Shell-process ownership (task 3.11)

V2 shell/systemshell run targets now normalize to an owned process executable
instead of a one-shot command. The runtime adapter starts a detached `/bin/sh -lc`
process group, captures bounded output, waits for optional loopback `readyUrl` or
`readyText`, and exposes PID/log/stop. Stop signals the process group, escalates
to SIGKILL after a bound, and confirms only exact owned records. `env_stop`,
`env_logs` and idle cleanup include process-owned apps; operation receipts name
the PID, readiness and source.

A real adapter test starts a sleeping shell process, observes `readyText`, and
stops its group. A shared-server fixture exercised the real path end-to-end:
`env_execute` -> operator approval -> `env_run` -> `env_wait` -> `env_status`
(`kind: process`, `pid: …`) -> `env_logs` -> `env_stop` -> retained historical
logs. A separate shutdown fixture confirmed SIGTERM to the controller stops the
tracked process group. A fake-handle execution test covers the same service path.
No saved PID is adopted after restart; a process that survives a controller crash
is inspection-only and is never killed by PID reuse.

Standalone suite: **25 pass, 0 fail** (270 assertions).

## Execution issue diagnostics (task 3.12)

Unsupported v2 targets now remain catalog-visible with a sanitized
`executionIssue` code instead of silently lacking an executable. A direct test
covers `container-name-prefix`. A read-only pass over the real v2 configuration
reports 31 `container-name-prefix` Compose targets, 2 Kubernetes targets, 2
unsupported Docker targets and 1 Compose service-count issue. No user
configuration was changed; the group-prefix migration remains an explicit
operator step.

Also raised the shell-command argument budget to 64 KiB per argument and 128 KiB
total, which makes the real long-form shell run targets executable. Standalone
suite: **25 pass, 0 fail** (271 assertions).

## Crash-safe process supervision (task 3.13)

Shell process runs now start under a detached Bun supervisor that owns the app
process group and relays output. When the controller disappears without a graceful
stop, the supervisor detects parent death and signals its group. A direct test
starts a controller child, lets it exit without stopping, and verifies the app PID
is gone. Saved PIDs are still never adopted by a later controller.

Standalone suite: **26 pass, 0 fail** (273 assertions).

## Durable controller diagnostics (task 3.14)

Added private mode-0600 `STATE_DIR/diagnostics.jsonl`, capped at 1 MiB with one
rotated segment. Events are limited to `startup`, `capability`, `shutdown` and
`error`; only allowlisted action/code/scope/operation/count fields are stored,
never arguments, plans, credentials or free text. Startup, capability
touch/error and shutdown are recorded. `GET /operator/diagnostics?tail=N` serves
the bounded tail only with operator authentication.

Direct tests cover sanitization, private mode, rotation and tail. The shared CLI
scenario verifies operator-only access, startup/capability events, no agent or
operator token leakage and mode-0600 storage.

Standalone suite: **27 pass, 0 fail** (283 assertions).

## Configuration doctor (task 3.15)

Added `--doctor --config-dir` for a read-only v2 configuration report: app/target
counts, executable counts by descriptor kind, unavailable targets and sanitized
migration hints. It creates no state/listener and does not print commands, plans,
credentials or repository paths. A direct report test covers counts and the
container-prefix hint. A real-v2 run reports 41 apps, 117 targets, 81 executable
(17 docker-build, 52 command, 12 process) and 36 unavailable.

Standalone suite: **28 pass, 0 fail** (287 assertions).

## Real configuration migration and scoped cutover (task 3.16)

With explicit operator authorization, the real v2 configuration was migrated:

- `environments.json` backups: `environments.json.bak-20261122-145144` and
  `environments.json.bak-20261122-145427` (mode 0600).
- 76 explicit `container_name` values in inline Compose sources were prefixed
  with `environment-mcp-` (already-prefixed names untouched).
- The installer-space Mocked source was replaced with the reviewed owned stack
  (group network/volume, no borrowed-service mutation) and its declared
  `ICON_APPLICATION_MASTERPASSWORD` envRef was added.
- A private `.env` (0600) was created in the v2 config directory containing only
  the declared Artifactory/application references copied from the existing v1
  secret file; no secret values were printed.
- Doctor result improved from 81/117 to 112/117 executable targets; remaining:
  2 Kubernetes, 2 Docker-run, 1 network-only Compose target.

The standalone shared service is installed as launchd agent
`dev.environment-mcp` with fixed loopback ports 38471/38472, a dedicated
mode-0600 client token file and a private state directory. The bridge listed all
10 tools and `env_list` succeeded. The scoped OpenCode entry was replaced with
`environment-mcp` using `--connect` and `--token-file`; the config was backed up
as `opencode.json.bak-20261122-145506`. The global `agentic-environments` entry
remains because this controller's authority is one repository/scope.

No application approval or run was performed during cutover. One awaiting-approval
review for `installer-space-mw`/`run-compose-mocked` was created for operator
inspection only.

## Podman and single-container run (task 3.17)

Added provider-aware build/Compose execution and a single-container run descriptor
for Docker and Podman. Podman uses the `podman`/`podman-compose` binaries with
`--url`/`CONTAINER_HOST`, provider-specific inspect/stop/log calls and the same
exact owned-ID ledger. Single-container runs publish only declared loopback
ports, pass environment names rather than secret values on argv, and verify
Docker/Podman running or health readiness. Two real `run-docker` targets now
normalize as executable, bringing the doctor to 114/117.

Tests cover Podman build argv, podman-compose project argv, container-run argv
without secret values, v2 normalization, and the approved execution/stop/log
path. Podman was not installed locally, so no live Podman runtime compatibility
is claimed.

Standalone suite: **32 pass, 0 fail** (308 assertions).

## Controller-wide shared-service leases (task 3.18)

Added an optional `serviceBindings.<id>.start: {app,target}` descriptor. A
successful owned start of that exact infrastructure target verifies the binding
identity and installs a controller-wide shared-service record. `env_services`
exposes the binding/start/shared state; dependent executable runs acquire leases
at dispatch. Stopping the service-owner app is refused while any lease exists;
stopping a dependent releases its leases, and scope close also releases them.
Restart marks shared records uncertain and clears leases without adoption.

A cross-scope test starts PostgreSQL through an infrastructure target, runs a
dependent app from another scope, verifies the lease and refuses owner cleanup.
Stopping the dependent releases the last lease, automatically stops the exact
started containers, deletes their owned records and marks the shared service
released. A dedicated start/stop capability remains open.

Standalone suite: **50 pass, 0 fail** (446 assertions).

## Native shell telemetry (task 3.19)

Added a loopback OTLP/HTTP JSON receiver per approved shell process telemetry
target. It accepts only `/v1/traces` and `/v1/logs` with a per-run bearer token,
stores bounded spans/log summaries in memory, redacts declared secrets, and
injects standard `OTEL_*` variables into the process. `env_telemetry({app,
traceId?})` exposes the capture; the receiver closes on stop while its snapshot
remains readable for the controller lifetime.

The live OpenCode bridge was reloaded and `environment-mcp` connected. Direct
OpenCode MCP calls to `env_services` and `env_status` succeeded after the shared
service/lease changes. The native telemetry receiver is covered by direct OTLP
and process-execution tests. Compose collector telemetry is implemented; a
dedicated trace browser and container-run telemetry remain pending.

Standalone suite: **50 pass, 0 fail** (446 assertions).

## Compose secret reference merging (task 3.20)

Compose service `x-secret-refs` and target `secretRefs` remain per-service
container environment references; explicit `compose.envRefs` remains the Compose
process interpolation reference. Conflicting references or literal service
environment keys refuse the target. Values resolve only at dispatch and are
injected through a private Compose override file, with `$` escaped for Compose
interpolation. Missing values still refuse before any container starts.

Standalone suite: **50 pass, 0 fail** (446 assertions).

## Compose collector telemetry (task 3.21)

The exact v2 TLS host-gateway collector declaration is now executable. The
controller creates a fresh ephemeral certificate, starts a host-gateway receiver
with bearer authentication, emits `OTEL_COLLECTOR_CONFIG`, and mounts only the
public CA into the declared collector through a private Compose override. The
private key is never written to disk. Received spans/logs use the same bounded
redaction as shell telemetry and remain readable through `env_telemetry` after
the receiver closes.

The real doctor now reports 117 executable targets out of 117. The
`grid-allocation-backend/run-compose-default`, both Helm targets and the
network-only bridge target are executable. The receiver and injection paths are
fake-backed tests; no live Compose
collector run is claimed. A live run still requires the image, Docker secrets
and the missing v2 `.env` references.

After restarting the launchd service on the new build and reloading OpenCode,
`environment-mcp` connected. A direct OpenCode `env_list` filtered to the
grid-allocation repository returned `run-compose-default` as a Compose
executable with `collectorService: "otel-collector"` and per-service secret
references for `postgres` and `grid-allocation-backend`. Direct `env_services`
and `env_status` calls also succeeded. No run was dispatched.

Standalone suite: **50 pass, 0 fail** (446 assertions).

## Telemetry trace rendering (task 3.22)

The shared OpenTUI result view formats `env_telemetry` summaries and trace
responses as bounded terminal text. Trace IDs render an indented parent/child
tree with duration, status and a few attributes; snapshots render bounded log
and trace lists. The formatter filters control characters, caps nodes/lines and
falls back to JSON for an unknown shape. It remains inside the capability
registry and adds no UI-only action.

Standalone suite: **50 pass, 0 fail** (446 assertions).

## Kubernetes Helm execution (task 3.23)

The two real `helm-release-v1` targets are now executable descriptors. Charts are
bounded, no-follow-walked, hashed at startup and rechecked at admission and
dispatch. The v1-compatible default cluster is `devenv` with context
`kind-devenv`; optional `clusters.json` entries provide a config-contained
kubeconfig digest, context, authorized repositories and a bounded client
environment. No kind provisioning or kubeconfig rewriting is performed.

Installation is a fresh `helm install` only. Before any cluster effect, an
offline `helm template` render must contain only namespaced objects and at least
one `apps/v1` Deployment; CRDs, subcharts, hooks, resource policies and `lookup`
are refused. The per-operation release label and revision are verified through
`helm get metadata`, the installed manifest must match the offline render, and
readiness waits for the rendered Deployments to become Available. Cleanup
re-observes the exact revision/label before `helm uninstall`; a changed or
missing release is retained for inspection. Chart workload logs are explicitly
reported as unavailable rather than inferred from selectors.

Offline verification against both real repositories rendered:
`icon-customer-external-api-deployment` and
`icon-grid-allocation-backend-deployment`; chart digests were obtained without
printing chart contents. No live cluster was available, so no install, readiness
or uninstall against a real cluster is claimed. Fake helm/kubectl binaries cover
fresh install, readiness, metadata verification and uninstall; a service-level
test covers approval, ownership, native-log refusal and exact cleanup.

The real doctor now reports **117 executable / 117 targets**; no descriptor is
unavailable.

Standalone suite: **50 pass, 0 fail** (446 assertions).

## Multi-repository client authority (task 3.24)

A shared client may now declare `repositories` instead of one `repository`.
Each canonical repository gets its own scope, execution session, dependency
session and owned ledger. The composite session routes by an explicit
`repository` argument or by an app identity that exists in exactly one authorized
repository; ambiguous app actions refuse with `repository-ambiguous`.
`env_status` and `env_history` accept a repository filter and aggregate across
scopes when it is omitted. `env_stop`, `env_logs` and `env_telemetry` accept the
same filter and never clean another repository's scope.

A direct composite-session test covers unambiguous routing, explicit-repository
routing, ambiguity refusal, scoped status, stop/log/telemetry routing and
aggregate history. A shared-server test starts the real listener with one client
bound to two repositories and verifies partitioned `env_status` and the
repository filter. The single-repository `repository` field remains accepted.

The local OpenCode client was changed from the installer-space-only repository
to all 35 authorized repositories. Backups:
`clients.json.bak-20261123-095129` and
`opencode.json.bak-20261123-095200`. The launchd service restarted successfully;
OpenCode `environment-mcp` reconnected. A direct `env_list` returned all 41
applications and `env_status` returned 35 partitioned scopes. The legacy
`agentic-environments` entry was then removed; `opencode mcp list` showed only
`environment-mcp` connected. No operation was approved or dispatched by this
change.

Standalone suite: **50 pass, 0 fail** (446 assertions).

## Compose network-only bridges (task 3.25)

The real `host-infra-network` network-only descriptor is now executable, and the
six `host-infra-*` members carry an exact `networkFrom` reference. A network-only
target requires exactly empty services and creates one owned bridge with a
deterministic app/target name. Members inspect the bridge labels, start their own
Compose stack, then attach only their newly created container IDs. The bridge
owner refuses removal while any container remains attached; members never own or
remove the bridge. Controller shutdown stops member apps before network owners.

Fake Docker tests cover network create/inspect/connect/remove and a service-level
test covers bridge ownership, member attachment, member stop, empty-bridge
removal and the network-only log response. No live Docker bridge creation or
member attachment is claimed. The real doctor now reports **117 executable
targets and no unavailable targets**.

Standalone suite: **50 pass, 0 fail** (446 assertions).

## Prerequisite visibility and secret gaps (task 3.26)

Normalized targets now retain their declared v2 `prerequisites` and expose them
in `env_list`. A `networkFrom` member is refused at admission with
`network-prerequisite-unavailable` until the exact labelled bridge exists;
admission never creates it. The fake network service test covers the refusal
before bridge creation and success afterward.

The doctor now reports `secretGaps`: declared environment references absent from
the config `.env` and process fallback. Only reference names are emitted, never
values. The real report has 117/117 executable descriptors and still lists
missing `V2_*`/portal references for some Compose targets; those runs refuse at
dispatch rather than starting with an incomplete environment.

Standalone suite: **50 pass, 0 fail** (446 assertions).

## Automatic network-only prerequisites (task 3.27)

A member whose target declares a matching `networkOnly` prerequisite is admitted
even when the bridge is absent. The approved descriptor now carries that exact
prerequisite executable. Dispatch inspects the bridge first; if present it is
borrowed, and if absent the member operation creates and owns it before
attaching the member containers. Cleanup stops containers before removing the
empty bridge, so shared members retain it while attached. Other prerequisite
kinds remain explicit operations.

The network service test now covers admission with an approved prerequisite,
automatic creation, member attachment, member-owned bridge cleanup and a later
network-only target run. No live Docker bridge was exercised.

Standalone suite: **50 pass, 0 fail** (446 assertions).

## Idle scope closure and rebinding (task 3.28)

Repository scopes are now backed by a runtime that keeps the current scope and
closed historical scopes. The idle reaper stops owned apps, then asks each clean
scope to close. Closure is refused while the scope is busy, has owned resources,
has an awaiting/approved/issued operation, or has an inspection-required record.
A closed scope remains visible to status/history and its historical operations/
logs/telemetry remain readable; observation never reopens it. The next execution
or dependency action opens a fresh scope and retains the old scope for history.

Direct tests cover clean closure, historical scope lookup, reopened scope
identity and the idle-reaper close call after owned cleanup. The shared-server
suite continues to exercise the composite runtime. No live idle expiry was
waited out.

Standalone suite: **50 pass, 0 fail** (446 assertions).

## Container telemetry and trace browser (task 3.29)

Container-run targets can now declare `otlp-http-json` / `0.0.0.0:0`
telemetry. The controller starts the same TLS host-gateway receiver used by
Compose, injects standard OTLP exporter variables and the public CA path, adds
the host gateway and read-only CA mount to the container run, and stores bounded
redacted spans/logs for `env_telemetry`. This is not an image-specific
instrumentation claim; only standard OTEL environment support is assumed.

The OpenTUI now provides a selectable trace browser. An `env_telemetry` snapshot
with traces opens a trace list; selecting a trace invokes the same capability
with its ID and renders the parent/child tree. No UI-only action or additional
approval authority was added.

Tests cover receiver container environment, container runtime mount/extra-host
arguments, service-level receiver injection, and controller trace selection/back
navigation. No live container telemetry source was exercised.

Standalone suite: **50 pass, 0 fail** (446 assertions).

## Live Docker network and Compose verification (task 3.30)

A disposable live Docker check used the real runtime executor:
- created `environment-mcp-live-verify-*` bridge and inspected its exact ID,
- started a temporary `redis:7-alpine` container and attached its ID,
- confirmed attached-container removal refusal,
- stopped/removed the container and bridge,
- then created another temporary bridge and started a one-service Compose
  project (`redis:7-alpine`),
- attached the exact Compose container, confirmed attached removal refusal,
- stopped the service, removed the Compose project and bridge.

Both checks returned `attached: 1`, `refusedWhileAttached: true` and
`removed: true`. Post-check inspection found no surviving `environment-mcp-live`
network or container. This verifies live Docker network create/inspect/connect/
remove and Compose container attachment; it does not claim Kubernetes, Podman or
application telemetry compatibility.

Standalone suite: **50 pass, 0 fail** (446 assertions).

## Live Compose collector telemetry (task 3.31)

A disposable live Docker/Compose check started the real
`otel/opentelemetry-collector-contrib:0.162.0` service with a generated
`OTEL_COLLECTOR_CONFIG`, the ephemeral public CA mount and a host-gateway mapping.
Synthetic OTLP JSON was posted to the collector's HTTP receiver, and the
receiver captured the collector-exported trace (`traceId` matched, one trace).
The temporary Compose project and receiver were removed; no surviving
`environment-mcp-live-otel` container or network was found. This validates the
collector/TLS receiver path, not application-specific instrumentation.

Standalone suite: **50 pass, 0 fail** (446 assertions).

## Secret preflight (task 3.32)

Executable admission now resolves every declared environment reference through
the same private secret source used at dispatch. A missing reference refuses with
`secret-reference-unavailable` before review, so an operator does not approve a
target that would fail immediately for incomplete configuration. The error does
not include the reference value.

Standalone suite: **50 pass, 0 fail** (446 assertions).

## Live kind/Helm verification (task 3.33)

A disposable kind cluster (`kindest/node:v1.33.1`) was created with a private
temporary kubeconfig. A temporary repository/chart declared one `nginx`/`pause`
Deployment. Through the real execution service and executor, the controller:

- admitted and approved a Helm release,
- installed the chart into `environment-mcp-live`,
- observed the rendered Deployment,
- waited for it to become Available,
- reported `status: completed`, `readiness: ready`,
- uninstalled the exact release and confirmed `remaining: 0`,
- deleted the namespace and kind cluster.

The live run exposed and fixed two compatibility issues: Helm v4 rejects the
legacy `helm list --all` flag, and image pull/startup can exceed the previous
60-second Deployment readiness window. The executor now omits `--all` and waits
up to 300 seconds (bounded by target timeout). The suite asserts `--all` is not
emitted. The real customer/grid charts and cluster-specific images were not live
verified; the kind run used a minimal chart.

Standalone suite: **50 pass, 0 fail** (446 assertions).

## Local secret completion (task 3.34)

The private v2 `.env` was backed up as
`.env.bak-20261123-131155`. Known local-only values were added without printing
them: the local Redis password used by the customer-external local profile, a
Postgres trust-auth placeholder, and the existing v1 customer-portal master
password. The file remains mode 0600. No existing database was started, stopped,
recreated or reconfigured.

Doctor `secretGaps` dropped from 21 targets to 4: Eon installer directory
(MySQL/datasource), grid Entra client secret, hwportal/EFIX Postgres/API DB
passwords, and the remaining EFIX external credentials. Those targets refuse
admission until the operator supplies the external values.

Standalone suite: **50 pass, 0 fail** (446 assertions).

## Live Podman verification (task 3.35)

Podman 6.2.0 and its krunkit machine were installed and started for a disposable
live check. A locally loaded `redis:7-alpine` image avoided the environment's
TLS-intercepting registry path. The real executor then:

- created and inspected a Podman bridge,
- ran the container through the Podman provider,
- attached the exact container ID,
- confirmed network removal is refused while attached,
- stopped/removed the container and bridge.

Result: `attached: 1`, `refusedWhileAttached: true`, `removed: true`; no
surviving test container or network. The machine was stopped afterward. The live
run exposed that Podman's low-level `network rm` could remove an attached
bridge; the executor now pre-inspects attachments and refuses removal, with a
dedicated regression test. Podman build and Compose were not live-verified.

Standalone suite: **50 pass, 0 fail** (446 assertions).

## Live Podman build/Compose (task 3.36)

The Podman machine was restarted and `podman-compose` 1.6.0 installed. A
disposable build used a locally loaded `redis:7-alpine` base to avoid the
environment's TLS-intercepting registry path, producing a local image. The real
executor then started a Podman Compose project, resolved exactly one container
ID, and cleaned up the project and image.

The live run exposed that `podman-compose ps` does not accept service names after
`-q`. The executor now omits service names for the Podman provider while keeping
them for Docker; a direct fake-runtime test asserts the Podman argv. Podman
network/container attach and attached-removal refusal were previously verified.
All test images, containers, projects and networks were removed; the Podman
machine was stopped.

Standalone suite: **50 pass, 0 fail** (446 assertions).

## Real chart live attempt (not claimed)

A disposable kind cluster was prepared with minimal CRDs for ExternalSecret,
HTTPRoute and ScaledObject. The real customer-external chart rendered and its
resources were accepted with the private app image retagged to a local pause
image. The Deployment could not become ready because the chart requires its
private image, ExternalSecret-materialized credentials and HTTP probes on the
application port. The test was cleaned up (namespace, CRDs and kind cluster
deleted) and no live real-chart claim is made. Real chart verification requires
the private registry image and its secret material.

## Additional local secret completion (task 3.37)

Backed up `.env` again as `.env.bak-20261123-135831`. Added known local values
from the reviewed local compose/application configuration: Eon MySQL root and
datasource password, hwportal Postgres and API DB password, and the grid mock
Entra client secret. The file remains mode 0600; no existing database was
started or modified.

Doctor `secretGaps` dropped to three targets: Eon installer `EIV_JASYPT_PASSWORD`,
hwportal/EFIX external credentials, and the Efix frontend AEM endpoint. Those
remain operator-supplied external values.

## Live idle closure/rebinding (task 3.38)

A shared-server integration test started a one-repository client with a 1-second
idle timeout. After the reaper ran, `env_status` reported the scope closed.
Calling `env_list` and `env_status` again did not reopen it. A subsequent
`env_execute` created a fresh active scope and returned an awaiting-approval
operation. The test uses the real shared server, journal, reaper and HTTP
capability transport; no external runtime was needed.

Standalone suite: **50 pass, 0 fail** (446 assertions).

## Real chart live install (task 3.39)

A disposable kind cluster was prepared with minimal ExternalSecret, HTTPRoute and
ScaledObject CRDs, a local HTTP substitute image retagged as the chart's private
application image, dummy secret material and the chart's required node label.
The real customer-external chart then:

- installed successfully,
- reported its rendered Deployment,
- became `readiness: ready`,
- uninstalled and confirmed `remaining: 0`.

The live run exposed that `helm install -o json` output can exceed the executor's
64 KiB output bound because it embeds chart files. The executor now runs install
without `-o json` and takes the created release revision/label from the small
`helm get metadata` response. All cluster, CRDs, namespace and substitute image
were removed. The real private application image and ExternalSecret material
were not available, so application behavior is not claimed.

Standalone suite: **50 pass, 0 fail** (446 assertions).

## OpenCode TUI plugin (task 3.40)

Added a local OpenCode 2.0.22 TUI plugin under `environment-mcp/opencode-plugin/`.
It registers a full-screen `environment` route, `/environment`/`/env` and
`<leader>v`, and renders the existing `UiCapabilityApi`/controller states with
Solid/OpenTUI components: a searchable Inspect/Operate/Observe capability list,
schema forms, result scrolling, telemetry trace drill-down, a two-column `?` help
dialog and a special-key footer. It reads the same authenticated loopback URL and
client token file and does not import MCP registration, listeners, journals,
runtime adapters or the operator surface.

The plugin's structural TUI contract types are a local copy of the OpenCode
2.0.22 `packages/plugin/src/tui` shape; provenance is recorded in `PROVENANCE.md`.
The UI follows the agentic-coding v1/v2 keybind/footer/help conventions (plain
keybind data, standard navigation hidden from the footer, full catalog in `?`).

Live verification used a disposable OpenCode 2.0.22 TUI (`--standalone`, temporary
config directory with a symlink to the plugin) against the running shared
environment-mcp service:

- The home footer showed the clickable `● Environment` chip.
- `/environment` and `<leader>v` opened the route; `Esc` returned home.
- The list showed 12 registry capabilities; filtering `telemetry` narrowed to
  one match and `status` to `Show scope status`.
- `env_list` ran from its form and returned the configured repository catalog.
- `env_status` ran from its form and returned the active scopes.
- `env_services` ran with no inputs via Enter and returned `{ "services": [] }`.
- A missing telemetry app produced `operation-unavailable`; the error view
  showed `Request failed`, `r` refreshed the capability list, and `Esc` returned.
- `?` opened the two-column help dialog from list/traces/result/error; in a form,
  `?` typed into the focused input instead of opening help.
- `env_execute` prefilled a fresh `requestId` UUID.

The global config symlink is installed at
`~/.config/opencode/plugins/environment-mcp`; `opencode plugin list` resolves it
as a local plugin and the running OpenCode log shows a 13-plugin reconciliation
with no plugin error. The disposable TUI was closed after verification. No
engine, cluster or container was started.

The controller now prefills `requestId` form fields with a UUID; a focused UI
test covers it. Standalone suite: **57 pass, 0 fail** (479 assertions, 28 files,
8.44s). `bun run lint` and `bun run type-check` are clean.

## App-centric OpenCode environment UI (task 3.41)

Replaced the capability browser with an app-centric OpenCode TUI surface. The
new shell has Applications, Libraries, Infrastructure, History and Services
tabs; an application table with target summaries, repository and owned count; an
application detail with defaults, targets, owned resources and recent receipts;
a target picker; an exact-review operation view; owned logs; and telemetry
trace drill-down. The old schema-form/capability-list plugin files were removed.

Operation views now include a safe `subject` projection `{app, target, action?,
repository?}` parsed from the frozen plan. The plan and identity remain
operator-only; a direct projection test asserts both are absent. This makes
history and operation detail attributable without exposing execution commands,
secrets or the review body.

Live verification used a disposable OpenCode 2.0.22 TUI against the restarted
shared environment-mcp service:

- The table showed 41 apps with tabs **Applications (25)**, **Libraries (9)**,
  **Infrastructure (7)**, **History**, **Services** and `35/35 scopes active`.
- Opening `customer-external-mw` showed six targets, defaults, scope and zero
  owned resources.
- `b` opened the build target picker; Enter prepared an exact review and showed
  **awaiting-approval** with app/target/action/repository and receipt fields.
- `d` while awaiting approval refused with “Approve the exact review in the
  operator surface first”; `Esc` returned to the application detail.
- History showed the new operation with subject attribution from the backend
  projection; Services reported no configured bindings.
- `S` stopped zero owned resources and reported zero remaining.
- `l`/`e` on an app without owned output reported “No owned logs or retained
  output” / “No telemetry captured” instead of a raw refusal.
- `?` opened the new two-column help; `Esc` returned through detail to the table.
- The global plugin symlink hot-reloaded in the running TUI (13 plugins, no
  plugin error).

The environment-mcp service was rebuilt and restarted; the OpenCode MCP bridge
reconnected and the doctor reported **117 executable / 0 unavailable** with the
same three external-secret gaps.

Standalone suite: **60 pass, 0 fail** (478 assertions, 28 files, 7.78s).
Plugin focused suite: **7 pass** (25 assertions). `bun run lint` and
`bun run type-check` are clean.

Not yet ported because the capability registry has no backend for them: git
branch/fetch/worktrees, container stats, Kubernetes cluster inspection,
provider change requests/issues/pipelines, and app/task CRUD. The UI does not
claim those screens.

> The approval workflow described in the preceding section was removed by
> task 3.42; execution is now direct.

## Direct execution and operator removal (task 3.42)

Removed the separate human operator approval surface. `env_execute` now admits
and dispatches one exact configured target in a single step; `env_wait` observes
the settled receipt. The same request id and intent returns the existing operation
and never re-runs it. The `env_run` and `env_prepare_dependencies` capabilities
were removed, leaving 10 direct capabilities.

Removed:

- `src/operator/` client/controller/OpenTUI/HTTP API;
- `--operator-ui`, `--operator-port` and the operator access file;
- the second operator listener and its launchd argument;
- operator/approval tests and the dependency-review service;
- decision/acknowledgement writes for new operations.

The launchd plist was backed up as
`dev.environment-mcp.plist.bak-20261124-direct-execution`, the
`--operator-port 38472` arguments were removed, and the service was reloaded.
Only `127.0.0.1:38471` is listening; `operator-access.json` was removed; the
OpenCode MCP bridge reconnected; the doctor reports **117 executable / 0
unavailable** with the same three external-secret gaps.

Live direct execution used the owned network-only infrastructure target
`host-infra-network` / `run-compose-default`:

- `env_execute` returned an issued operation with safe subject attribution;
- `env_wait` returned a completed network receipt;
- `env_stop` removed the exact network and reported `remaining: 0`;
- no test network remained.

The disposable OpenCode TUI then executed the same target from the Infrastructure
tab: the operation view settled to completed with the network receipt, and `S`
stopped the owned network (`Stopped 1 resource; 0 remaining`). No approval step
was presented.

Legacy `awaiting-approval`/`rejected` journal records remain readable but are
never created by new operations; startup interrupts prior ready/issued work and
never reissues it automatically.

Standalone suite: **58 pass, 0 fail** (411 assertions, 26 files, 9.85s).
Plugin focused suite: **8 pass** (26 assertions). `bun run lint` and
`bun run type-check` are clean.


## Filter focus and navigation (task 3.43)

Fixed the application filter interaction:

- While the filter input is focused, `↑/↓` moves the filtered result selection
  without stealing `j/k` from the text field.
- `Enter` now blurs the filter and returns focus to the list; it no longer opens
  the selected application.
- After blurring, the normal list keymap is active again: arrows/`j/k` navigate,
  `Enter` opens the selected application, `/` re-focuses the filter, and `Esc`
  closes.
- `Esc` while filtering clears the query and restores the full list.
- The footer changes from `Enter list · Esc clear` while filtering to the normal
  list keys after focus returns.

Live-tested in a disposable OpenCode TUI: filter `customer`, move with `↓`/`↑`
while the input stayed focused, press `Enter` to blur, navigate to `customer-fe`
with `↓`, then `Enter` to open its detail. The filter remained applied.

Standalone suite: **58 pass, 0 fail** (411 assertions, 26 files, 9.85s).
Plugin focused suite: **8 pass** (26 assertions). Lint/type-check clean.

## Split panel and fullscreen (task 3.44)

The environment dashboard opens inside an OpenCode session through
`ui.panel.open("environment", { presentation: "panel" })`; the full-screen
route remains the fallback when no session panel is available. The panel
auto-focuses on open and its keymaps are gated on `panel.focused`, so the
session keeps its own keys while the panel is unfocused. `f` toggles fullscreen
and windowed mode, and widths below 96 columns use compact header/tabs and
application rows.

Live-tested in a disposable OpenCode TUI: the split opened beside the session,
`f` toggled fullscreen both ways, filtering and `Enter`/arrow navigation worked,
and `Esc` closed the panel and returned to the unchanged session. A full-width
blank line now separates the content from the footer; the footer background
starts at the status message, not at the gap.

## Build steps and logs (task 3.45)

`OperationView` now has Info/Steps/Logs tabs. Docker-build receipts are parsed
into ordered BuildKit steps by `opencode-plugin/src/environments/build.ts`;
each step keeps its title, status (running/done/cached/error/canceled), duration
and own log lines. Unrecognized lines and global build output remain in the
Logs tab, and no line is reordered or invented. The Steps tab is selected
automatically for a build receipt, the first failing step is selected, and
`Tab`/`Shift+Tab`/`1–3` switch tabs while `↑/↓`/`j/k` move the step. The step
list scrolls the selection into view.

Parser tests cover the success/cached shape and a failing BuildKit block with
its `ERROR`/`------` payload. Live verification in the disposable OpenCode TUI:

- `customer-fe/build-docker-default` executed through the direct capability
  (no approval) and completed in 9 ordered steps with durations and per-step
  logs (the base-image step retained 114 log lines, the `npm install` step 29);
  the Steps tab opened first and the selected step log updated as `j` moved the
  selection.
- The earlier `installer-space-mw` failed receipt rendered its failing step as
  an error with the `ERROR` block and build log lines. That receipt was
  truncated at the journal output cap, so the truncated header fell back to
  `Step 10` instead of a title.
- `Tab`/`1`/`2` switched between Logs, Info and Steps; `Esc` returned to the
  operation history; the footer showed `Tab tabs · r refresh · Esc back ·
  ? help · f fullscreen`.

Environment-mcp suite: **60 pass, 0 fail** (420 assertions, 27 files, 9.03s).
Plugin focused suite: **10 pass, 0 fail** (35 assertions). `bun run lint` and
`bun run type-check` are clean.

## Live build progress (task 3.46)

`env_operation` now also serves in-flight output. `env_execute` starts the
direct dispatch; `env_operation` returns `progress: { offset, text, reset? }`
for an issued operation, capped at 64 KiB per response, while the controller
keeps a redacted 4 MiB rolling buffer. Output is redacted before buffering,
including secrets split across chunks, and the buffer is released when the
operation settles.

The panel polls `env_operation` every second while the operation is issued,
accumulates deltas up to 8 MiB, and feeds them through the BuildKit parser.
Steps and their logs therefore appear while the build runs: the running step is
selected automatically, its log tails the newest lines, and the view settles
without pressing `r`. A settled receipt is merged back by step id so the
authoritative final status and duration win even though the journal receipt is
tail-truncated. The "Dispatched — press r to refresh" hint was removed; the
footer already lists `r refresh`.

Live-tested with `installer-space-mw/build-docker-default` in the disposable
OpenCode TUI:

- while the operation was `issued`, Steps showed all nine steps, including
  cached (`↻`) and the running (`◌`) `build 2/2` step;
- the running step's log followed the newest output (line 922) instead of the
  first line;
- the view changed to the settled state on its own when the build finished; the
  receipt reported the maven failure (HTTP 403 resolving a site descriptor);
- after a plugin reload only the tail-truncated receipt remained, so verbose
  historical builds can still show only the final steps. Live output is
  in-memory and does not survive a service restart.

Standalone suite: **64 pass, 0 fail** (436 assertions, 28 files, 8.50s).
Plugin focused suite: **12 pass, 0 fail** (39 assertions). `bun run lint` and
`bun run type-check` are clean.

## Application status and git state (task 3.47)

The Applications/Libraries/Infrastructure inventory now derives each row's
current run status from owned resources and issued operations: `running` with an
owned count, `building`/`testing`/`starting` while an operation is in flight, or
`stopped`. The repository column and the separate owned column were replaced by
`Git` and `Status`; the full repository path remains in the application detail.
Compact rows show the app and status on the first line, then targets, branch and
working-tree state.

A new read-only `env_git` capability reads `git status --porcelain=v2 --branch`
for the authenticated repositories with an 8-way concurrency limit, a 3-second
per-repository timeout and a 256 KiB output bound. It reports branch, short head,
detached HEAD, modified/added/deleted file counts and ahead/behind; it never
fetches, checks out, stages or commits. Requests outside the client's repository allowlist are
rejected with `repository-unauthorized` (409).

Live verification:

- the controller returned 35 authorized repositories; `customer-fe` reported
  `qa` with 1 added file, `devenv` reported `main` with 1 modified and 2 added,
  and clean repositories reported their current branches;
- the panel rendered `Git` and `Status` columns with a one-column gap. The Git
  cell shows a yellow `~modified`, green `+added`, red `-deleted` and
  ahead/behind above a truncated branch; application names are bold and use the
  base text color. `devenv` rendered `~1 +2`, and `document-service` rendered
  `+2 ↑1` over a truncated `feature/DAC…` branch;
- after running `host-infra-network/run-compose-default`, its row showed
  `running` and `1 owned`; `env_stop` removed the network with `remaining: 0`,
  and the row returned to `stopped`;
- an unauthorized repository request returned HTTP 409.

Environment-mcp suite: **67 pass, 0 fail** (450 assertions, 29 files, 10.11s).
Plugin focused suite: **12 pass, 0 fail** (39 assertions). `bun run lint` and
`bun run type-check` are clean.

## Target glyphs (task 3.48)

The inventory target summary, the application-detail target rows and defaults,
and the target-picker heading now use compact glyphs instead of the words
`build`, `test` and `run`:

- `⚒` build
- `✓` test
- `▶` run
- `•` fallback for an unknown action

Counts append directly to the glyph (`⚒2`, `▶3`) and summaries are joined by
spaces. The inventory rendered `⚒2 ✓ ▶3` for `customer-external-mw`, its detail
rows showed the glyph in a two-column action slot, and pressing `b` opened the
picker with the heading `⚒ customer-external-mw`.

The model test now asserts `⚒ ✓ ▶2` for the fixture. Suite: **67 pass, 0 fail**
(450 assertions, 29 files, 10.11s). `bun run lint` and `bun run type-check` are
clean.

## Live status and git refresh (task 3.49)

This was the polling baseline: while the panel was open on an inventory tab or
the application detail, the store polled `env_status` and `env_history` every 5
seconds and `env_git` every 10 seconds. Task 3.50 replaces the primary path with
SSE invalidation and keeps a 15s/30s reconciliation poll as fallback.

The application detail Overview now shows `Git` (branch, modified/added/deleted
counts and ahead/behind) and `Status` (running, building/testing/starting or
stopped), using the same status rule as the inventory row.

Live verification:

- starting `host-infra-network` externally changed its inventory row from
  `stopped` to `running` / `1 owned` within 7 seconds without pressing `r`; the
  detail showed the same status;
- stopping it externally returned the detail to `stopped` / `0 owned` within
  7 seconds;
- creating a disposable untracked file in the infrastructure repository changed
  the detail line to `main · ~13 +1 -1 ↑3` within 11 seconds; removing the file
  restored `main · ~13 -1 ↑3`.

Environment-mcp suite: **67 pass, 0 fail** (450 assertions, 29 files, 7.74s).
`bun run lint` and `bun run type-check` are clean.

## Event invalidation (task 3.50)

The capability listener now serves an authenticated `/events` SSE stream in
addition to request/response capabilities. Events are invalidation hints, not
state payloads:

- `status`, `git`, `operation` and `services` events carry only the repository
  and optional operation id; the plugin re-reads the existing capabilities.
- Events are filtered to the authenticated client's repository allowlist.
- The bus keeps a bounded 256-event ring. Reconnects send `Last-Event-ID` and
  receive missed events followed by a snapshot marker; heartbeats run every
  15 seconds. The stream is capped at 64 subscribers.
- The execution service emits `operation`/`status` when an operation is issued,
  `operation`/`status`/`git`/`services` when it settles, and
  `status`/`services` when an operation stops or a scope closes.
- The plugin reconnects with backoff and `Last-Event-ID`, refreshes status/history
  on status/operation events, refreshes only the affected repository on git
  events, and uses a latest-request-wins rule so a stale response cannot
  overwrite a newer observation. A 15s status/history and 30s git reconciliation
  poll remains for missed events and external changes (Docker stops, file edits).

Live verification:

- a raw SSE connection received `snapshot`, then issue/settle
  `operation`/`status`/`git`/`services` frames for a real network run, and
  `status`/`services` frames on stop;
- in the TUI, starting `host-infra-network` changed the row to
  `running` / `1 owned` and stopping it returned to `stopped` within a few
  seconds without pressing `r`; the backend reported owned 1 then 0;
- the Git column and detail remained populated, and `r` still performs an
  explicit full refresh.

Tests add the event-bus filtering/replay unit and an authenticated SSE snapshot
test.

### Heartbeat parser regression (task 3.51)

The first SSE client parser used a `continue` for frames without `data` before
advancing to the next frame boundary. The first 15-second heartbeat therefore
left the loop on the stale boundary and spun forever, freezing the TUI at 100%
CPU. The parser now consumes every complete frame before continuing, ignoring
comment-only heartbeats. `drainSseFrames` is a pure function covered by tests
for heartbeat-then-data, multiple frames and partial remainders.

Isolated CPU check in a disposable TUI: with events and live refresh enabled,
CPU stayed at 0.1–1.2% through 60 seconds (past two heartbeats); disabling only
SSE left the baseline similarly low, confirming the heartbeat loop was the
cause.

Environment-mcp suite: **71 pass, 0 fail** (463 assertions, 32 files, 11.77s).
Plugin focused suite: **14 pass, 0 fail** (43 assertions). `bun run lint` and
`bun run type-check` are clean.

## Read-only git changes and diff (task 3.52)

Added `env_git_changes` and `env_git_diff`, both restricted to the authenticated
repository allowlist:

- `env_git_changes` parses NUL-delimited porcelain v2, reports modified, added,
  deleted, renamed, copied, conflicted and untracked paths with staged/worktree
  presence, and caps the list at 500 entries. Paths are made relative to the
  application repository even when it is a subdirectory of a larger worktree;
  paths outside the app repository are omitted.
- `env_git_diff` validates the requested path against the current change list,
  refuses absolute paths and `..` segments, and returns at most 48 KiB of unified
  diff. Untracked regular files are diffed against `/dev/null`; binaries,
  directories and symlinks return a note instead of content. No fetch, checkout,
  stage or commit is performed.
- The application detail exposes `c` → Changes (`↑/↓`/`j/k`, `Enter`, `r`,
  `Esc`) and the diff view (`r`, `Esc`, scrollable body). The footer/help
  catalogs include both surfaces.

Live verification:

- `env_git_changes` returned 31 app-relative paths for the `devenv-config/devenv`
  worktree and 3 for `development/devenv`; the deleted
  `.pi/extensions/tools-jira.ts` diff returned 16,649 characters;
- the Changes view rendered `M`/`A` glyphs, paths and `worktree` flags; `Enter`
  opened the diff, including a `truncated` badge for the 48 KiB `tui/bun.lock`
  diff; `Esc` returned Changes → detail;
- a `../etc/passwd` path was refused as `invalid-path` in the adapter test.

Environment-mcp suite: **74 pass, 0 fail** (500 assertions, 33 files, 8.35s).
Plugin focused suite: **15 pass, 0 fail** (47 assertions). `bun run lint` and
`bun run type-check` are clean.

## Guarded git actions (task 3.53)

Added read-only `env_git_branches` and `env_git_worktrees`, plus
`env_git_action` in shared execution mode. The action capability is not exposed
by read-only stdio mode.

- `fetch` and fast-forward-only `pull` are bounded and non-interactive
  (`GIT_TERMINAL_PROMPT=0`).
- `checkout` requires an existing local branch; switching to the current branch
  is a no-op and is allowed on a dirty tree. Switching elsewhere refuses a dirty
  worktree.
- `worktree-add` requires an absolute path outside the repository whose parent
  exists and whose target does not. It accepts an existing branch or creates a
  new one when `create: true`; branch names are checked with
  `git check-ref-format`.
- `worktree-remove` refuses the current worktree and a target worktree with
  uncommitted changes.
- Actions are serialized per repository; non-fetch actions refuse while an
  environment operation is in progress. Outcomes include bounded output and a
  reason code.

UI:

- detail `g` opens the Git view (`Enter` switch, `f` fetch, `p` pull,
  `w` worktrees, `r` refresh, `Esc` back);
- Worktrees (`a` add, `x` remove) and the new-worktree path form (prefilled
  outside the repository, `Esc` cancel);
- the Git view displays the last action outcome and reason.

Live verification:

- the Git view showed `customer-fe` on `qa` with `origin/qa` and the expected
  footer; the Worktrees view showed the repository as current; the add form
  prefilled a sibling path outside the repository;
- checking out the current branch completed even with a dirty tree; adding a
  worktree for the current branch was refused as `branch-in-use` and created
  nothing;
- the backend scenario covered local-remote fetch, fast-forward pull, branch
  checkout, dirty-tree refusal, worktree add/remove, current/dirty removal
  refusals and creating a new branch in a worktree;
- panel CPU stayed at 0.3–1.4% across the new views.

Limitation: the UI worktree form uses the branch selected in the Git view;
backend-only `create: true` support is not exposed there yet. UI fetch/pull was
not run against a real remote; the local-remote scenario covers the command
path.

Environment-mcp suite: **75 pass, 0 fail** (530 assertions, 34 files, 9.13s).
Plugin focused suite: **15 pass, 0 fail** (47 assertions). `bun run lint` and
`bun run type-check` are clean.

## Git for the agent cwd (task 3.54)

`env_git_branches`, `env_git_worktrees` and `env_git_action` accept
`session: true` for a supplied working directory. This bypasses the configured
repository allowlist for the git surface only; `env_git_action` remains gated on
shared execution mode, so read-only stdio exposes only read-only branch/worktree
listing. Authenticated local clients can therefore target any local git
repository through the session flag, but never environment execution.

The plugin adds `<leader>shift+g` (leader then Shift+G; displayed as `<leader>G`;
command palette title "Git actions for current directory") and the
`/git-actions` slash command with alias `/git-cwd`. The plain `/git` slash name
is already the existing Git usage command, so the plugin command does not
override it.

- resolves `process.cwd()`, or a plugin `directory`/`cwd` option when present;
- sets a one-shot session request consumed by the environment page;
- opens the panel/full-screen environment and shows the Git view for that
  repository, hiding the environment tab header;
- `Esc` closes the session Git view/panel; `<leader>v` still opens the normal
  environment.

Live verification:

- the agent cwd `/Users/fabiankellner/agentic-coding` returned HTTP 409 through
  the normal allowlisted path and listed its branches through `session: true`
  (current `feat/agentic-coding-v2`);
- `ctrl+x Shift+G` and `/git-actions` opened the Git view with the
  agentic-coding branch list and no environment tabs; CPU stayed at 0.5%; `Esc`
  returned to the session and `ctrl+x v` opened the normal Applications table;
- `ctrl+x g` remained the timeline search and did not open the environment;
- checkout of the already-current branch through the session action completed.

Limitation: `process.cwd()` is process-wide in the plugin runtime; distinct
OpenCode sessions sharing one process may not have distinct cwds. Set the
plugin `directory`/`cwd` option if needed.

Environment-mcp suite: **75 pass, 0 fail** (530 assertions, 34 files, 11.87s).
Plugin focused suite: **15 pass, 0 fail** (47 assertions). `bun run lint` and
`bun run type-check` are clean.

## Git branch filter (task 3.55)

The Git view now mirrors the applications filter:

- `/` focuses the branch input; typed text filters by branch name or upstream;
- `Enter` returns focus to the filtered list, `↑/↓` move through the filtered
  branches without stealing `j/k` from the input, and `Esc` clears/blurs;
- while filtering, global environment keys (`r`, tabs, fullscreen, help) and
  Git actions are gated off so letters reach the input;
- the filter row shows `visible of total`; the footer switches to
  `Enter list · Esc clear`, and the `?` help lists the Git filter/action keys.

Live verification: `/feature` on the agentic-coding Git view reduced 196
branches to 193; `Enter` returned to the list and `↓` moved the selection; the
panel stayed responsive.

Environment-mcp suite: **75 pass, 0 fail** (530 assertions, 34 files, 11.69s).
Plugin focused suite: **15 pass, 0 fail** (47 assertions). `bun run lint` and
`bun run type-check` are clean.

## Git view header (task 3.56)

The Git view now uses a header outside the padded content box, styled like the
environment shell:

- raised background, two-column (one in compact) horizontal padding and the same
  vertical spacing as the environments header;
- bold lowercase `git` title, green current-branch dot and branch name, muted
  app id, right-aligned `N branches · M worktrees` (hidden in compact mode);
- the `/` filter input and `visible of total` count live in the header’s second
  row, matching the shell’s title-plus-tabs structure.

The Git branch list, outcome line and actions remain in the content area.
Live verification: the session Git header showed
`git ● feat/agentic-coding-v2 agentic-coding … 196 branches · 10 worktrees`,
with the filter row showing `196 of 196`; typing reduced it to `193 of 196`.
CPU stayed at 0.4%.

Environment-mcp suite: **75 pass, 0 fail** (530 assertions, 34 files, 10.75s).
Plugin focused suite: **15 pass, 0 fail** (47 assertions). `bun run lint` and
`bun run type-check` are clean.

## Git polish (task 3.57)

- **Worktree form** — path and branch are both editable inputs; `Tab` switches
  the focused field and the header shows `existing branch` or `new branch`.
  The action infers `create: true` when the typed branch is not local, and the
  suggested path follows the branch until the path is edited manually.
- **Session changes/diff** — `c` from the session Git view opens the same
  Changes/Diff surfaces using the session repository. `env_git_changes` and
  `env_git_diff` accept `session: true`.
- **Per-side diff** — `env_git_diff` accepts `side: all|staged|worktree`;
  the diff header shows the current side and `s` cycles and reloads it.

Live verification:

- the session Git view for `/Users/fabiankellner/agentic-coding` showed 27
  changes on `c`; the selected deleted file opened with side `all`, `s` switched
  to `staged` and correctly reported no staged diff;
- the worktree form showed editable Path/Branch fields, `Tab field`, an
  `existing branch` badge, and switched to `new branch` when the branch name was
  edited; nothing was created during the test;
- adapter tests assert staged (`+index`, no `+worktree`) versus worktree
  (`+worktree`) versus all (`+worktree`) diffs.

Environment-mcp suite: **76 pass, 0 fail** (537 assertions, 34 files, 10.40s).
Plugin focused suite: **15 pass, 0 fail** (47 assertions). `bun run lint` and
`bun run type-check` are clean.

## Branch deletion and remotes (task 3.58)

- `env_git_action` adds safe `branch-delete` (`git branch -d`), `remote-add` and
  `remote-remove`. Deletion refuses the current branch; Git refuses unmerged or
  worktree-checked-out branches with reason mapping.
- `env_git_remotes` returns remotes with sanitized URLs: HTTP(S) userinfo is
  stripped and credential-bearing HTTP URLs are refused for add.
- The Git view adds `d` delete and `m` remotes; the Remotes view lists
  name/fetch URL/split-push marker, `a` opens a two-field add form (`Tab`
  switches), and `x` removes the selected remote.
- All actions keep the per-repository lock, active-operation refusal and session
  mode.

Live verification:

- the session Git header counted 1 remote; the Remotes view showed
  `origin git@github.com:friendsfriend/agentic-coding.git`;
- deleting the current branch (`feat/agentic-coding-v2`) was refused as
  `current-branch`;
- the remote add form rendered Name/URL fields and the credential guidance;
- backend tests covered deleting a merged branch, current-branch refusal,
  adding/removing a remote, credential-URL refusal, and remote listing.

Limitations: running environment targets from a linked worktree and validating
fetch/pull against real credentialed remotes are not implemented; the local
remote scenario covers the command path.

Environment-mcp suite: **77 pass, 0 fail** (554 assertions, 34 files, 10.92s).
Plugin focused suite: **15 pass, 0 fail** (47 assertions). `bun run lint` and
`bun run type-check` are clean.

## Linked-worktree execution (task 3.59)

- `env_execute` accepts an optional `worktree`. Admission resolves the real path,
  requires the configured repository and worktree to share a git common
  directory, requires the worktree path to be its git top-level, and derives the
  app-relative working directory from the configured repository prefix.
- Repository-local command programs/arguments and Docker build context/dockerfile
  paths are rewritten to the linked worktree, so the checked-out branch is what
  runs. Process cwd and command cwd use the worktree directory.
- Compose, container-run and Helm targets refuse with `worktree-unsupported`;
  their resource names and service bindings are repository-scoped.
- The operation plan records the execution worktree, the operation subject
  exposes it, and the UI shows an `execution` badge in Worktrees plus a
  Worktree row in detail/history. `u` in Worktrees selects or clears it.
- Removing the active worktree clears the worktree execution selection.

Live verification:

- a non-worktree path to `env_execute` was refused with `worktree-unsupported`;
- the plugin Worktrees footer showed `a add  u use  x remove  r refresh`, and
  `u` on Session Git reported `Session Git has no environment targets.`;
- backend tests covered accepted linked-worktree cwd/program rewriting and
  Compose refusal.

Limitations: fetch/pull against real credentialed remotes still requires
authorized credentials and network access; the local-remote scenario covers the
command path.

## Read-only provider surface (task 3.60)

- The shared HTTP server reads the v2 `config.json` provider registry and
  resolves `tokenRef` from the process environment or configuration `.env` at
  call time. Only provider name/type/base URL/username and `hasToken` are
  projected; token references and values are never returned.
- `env_provider_repos`, `env_provider_changes`, `env_provider_issues`,
  `env_provider_pipelines` and `env_provider_jobs` are bounded read-only
  capabilities (20/50/50/30/30) with `open`/`closed`/`all` state where relevant.
- GitLab calls use the `/api/v4` prefix and encode project paths for nested namespaces; GitHub issue lists
  exclude pull requests. GitHub merged changes report `merged`; GitLab
  `opened` maps to `open`.
- Requests are HTTPS-only except loopback HTTP, refuse redirects, time out at
  12s, cap response bytes at 256 KiB, and map 401/403/404/429/400/422/5xx to
  bounded refusals. Tokens are redacted from parsed responses.
- The plugin adds `p` from the applications table, a Providers list, repository
  search, and Changes/Issues/Pipelines/Jobs views with `/` filtering, headers,
  `c`/`i`/`l` switches, `s` state cycling and `Enter` job navigation.

Live verification:

- `env_providers` returned `github-friendsfriend` and `gitlab-iconnect` with
  their types, base URLs, usernames and `hasToken: false`; neither `tokenRef`
  nor secret material appeared in the response.
- The plugin showed the two providers, `/` filtering to `gitlab-iconnect`,
  repository search entry/blur/back navigation, and the read-only footer.
- No provider network request was made: both configured token references are
  absent from the v2 configuration `.env` and the service process environment,
  so live repository/change/issue/pipeline reads remain credential-blocked.
  Adapter behavior is covered with fake-fetch tests only.

Environment-mcp suite: **83 pass, 0 fail** (622 assertions, 35 files, 9.32s).
Plugin focused suite: **18 pass, 0 fail** (60 assertions). `bun run lint` and
`bun run type-check` are clean.

## Provider detail, files, discussions and job logs (task 3.61)

- `env_provider_change`, `env_provider_change_files`,
  `env_provider_change_versions`, `env_provider_issue`,
  `env_provider_discussions` and `env_provider_job_logs` extend the read-only
  surface. Change files cap at 100 paths and 48 KiB aggregate patch text;
  versions at 100; discussions at 50 flattened notes; job logs at 64 KiB.
- GitHub change detail maps additions/deletions/changed files; GitHub issue
  detail refuses pull-request numbers. GitLab detail maps description,
  `changes_count`, `diff` patches and flattened discussion notes with resolved
  state.
- GitHub job logs fetch the signed redirect target without credentials; GitLab
  traces use the project job trace endpoint. Both redact the provider token and
  mark truncation.
- Plugin drill-down: change/issue `Enter` opens detail; change `d` opens files,
  `h` opens discussion history; file `Enter` opens the patch; job `Enter` opens
  logs; `Esc` returns through the provider view stack.
- Adapter tests cover GitHub and GitLab detail mapping, patch and log caps, and
  token redaction.
- A disposable loopback GitHub fixture (temporary config, client token, state
  and fake provider server) served every new capability successfully. The
  plugin browsed provider → repository search → changes → change detail →
  files → patch → discussions, issues → issue detail, and pipelines → jobs →
  job log. No external network or real credential was used.
- The real configured provider token references still do not resolve, so live
  GitHub/GitLab reads remain blocked; GitLab detail mapping is unit-tested only.

Environment-mcp suite: **83 pass, 0 fail** (674 assertions, 35 files, 9.94s).
Plugin focused suite: **18 pass, 0 fail** (69 assertions). `bun run lint` and
`bun run type-check` are clean.

## Container stats and Kubernetes inspection (tasks 3.62-3.63)

- `env_container_stats` aggregates only containers owned by the bound scopes or
  registered shared services across the client's repositories. The Docker/Podman
  Engine adapter uses the configured socket, verifies socket identity before and
  after, caps stats JSON at 256 KiB, and projects CPU, memory, network and PID
  values. Engine failures count as `unavailable`; other host containers are never
  enumerated.
- `env_clusters` lists clusters whose configured repository scope intersects the
  client's repositories. `env_cluster_resources` validates a non-system namespace
  and runs one fixed read-only `kubectl get
  deployments,statefulsets,pods,services --output wide` with the explicit
  context/kubeconfig, a 10s request timeout, 15s process timeout and 128 KiB
  output cap. No arbitrary kubectl arguments are exposed.
- The plugin adds `m` container stats from application detail and `K` cluster
  inspection from the applications table, with a namespace prompt and bounded
  resource view.

Live verification:

- `env_container_stats` returned an empty owned/shared set (no running owned
  containers) with `unavailable: 0`.
- `env_clusters` returned the implicit `devenv`/`kind-devenv` cluster scoped to
  the 35 configured repositories.
- The plugin showed the cluster list, namespace prompt, back navigation and the
  empty container-stats view.
- Kubernetes resource execution was not run against a live cluster; the fixed
  command, namespace refusal, authorization scope and missing-kubectl behavior
  are covered by a disposable fake-kubectl test.

Environment-mcp suite: **89 pass, 0 fail** (714 assertions, 36 files, 10.52s).
Plugin focused suite: **22 pass, 0 fail** (77 assertions). `bun run lint` and
`bun run type-check` are clean.

## Provider writes (task 3.64)

- Writes use a two-step preview-confirm contract. The first call returns a
  SHA-256 digest of the exact provider/action/target/body/head intent and sends
  no outbound request; the same call with that `confirm` digest performs the
  action. A mismatched digest remains a preview.
- `requestId` is persisted in a private `provider-writes.json` journal. Same ID
  and digest replays the receipt without a second call; different digest is
  `request-conflict`; an in-progress ID is `provider-write-in-progress`.
  Attempts left `attempting` by a restart are marked
  `provider-write-interrupted` and are never resent.
- Receipts are bounded to 512 on disk and 50 returned, with an atomic
  `0600` temp-file/rename write. `env_provider_writes` exposes only
  request/provider/action/target/digest/state/timestamps, bounded result or
  error code, and never token material.
- Actions: change/issue comments (16 KiB max), GitHub/GitLab exact-head approval
  with a re-read head check, and pipeline retry/cancel. No merge, close, rebase,
  unapprove or discussion resolution.
- The plugin adds `c`/`a` on changes, `c` on issues, `t`/`x` on pipelines, `y`
  confirmation, and `w` durable receipt listing.

Live verification against a disposable loopback GitHub fixture:

- preview returned a digest without a write;
- confirm completed and replay returned the same receipt without a second call;
- a different body under the same request ID was refused as `request-conflict`;
- exact-head approval completed; pipeline retry/cancel completed;
- the provider write list showed all receipts and no token material;
- the plugin completed comment, approval, retry and cancel flows through the
  preview-confirm UI and listed seven receipts.
- The real provider preview returned a digest without an outbound call because
  its token reference is unavailable; no real provider write was made.

Environment-mcp suite: **94 pass, 0 fail** (768 assertions, 37 files, 10.16s).
Plugin focused suite: **23 pass, 0 fail** (83 assertions). `bun run lint` and
`bun run type-check` are clean.

## Direct application provider navigation (task 3.65)

- `env_provider_repository({repository})` reads the authorized repository's
  fetch remotes and matches their host/path to configured provider base URLs.
  It handles SCP-like and URL remotes, GitHub `api.` hosts, nested GitLab
  namespaces, `.git` suffixes, and rejects traversal-like or malformed paths.
  No network call or token is used.
- The applications table now maps `c` to change requests and `i` to issues for
  the selected app. The plugin resolves the provider repository, selects the
  provider, and opens the list directly; `Esc` returns to the applications
  table rather than the longer provider stack.
- The provider path (`p` → repository → changes/issues) remains available.

Live verification:

- the disposable app fixture resolved `git@127.0.0.1:org/repo.git` to
  `fixture-github`/`org/repo`; table `i` opened the fixture issue list and `Esc`
  returned to the table; table `c` opened the fixture change list;
- the real service resolved `customer-fe` to
  `gitlab-iconnect`/`funke-iconnect/icon-customer-v2` and `customer-mw` to
  `funke-iconnect/icon-customer-services` without a network call.
- Provider reads still require the configured provider token references.

Environment-mcp suite: **96 pass, 0 fail** (785 assertions, 38 files, 10.24s).
Plugin focused suite: **24 pass, 0 fail** (86 assertions). `bun run lint` and
`bun run type-check` are clean.

## Provider token fallback and TLS (task 3.66)

- `--provider-env-file /absolute/.env` adds a provider-only fallback secret
  source. The path may be the operator-owned environment `.env` symlink; its
  canonical target must be a private regular file. Config-root `.env` and
  process values still take precedence.
- The launchd job now passes
  `--provider-env-file /Users/fabiankellner/.config/agentic-coding/.env` and
  sets `SSL_CERT_FILE=/usr/local/share/ca-certificates/cacert.pem`; without that
  CA bundle, launchd rejected the GitHub API certificate chain.
- GitHub repository paths now use literal `/` between owner and repository;
  GitLab keeps encoded project paths for nested namespaces.

Live verification:

- `env_providers` reports `hasToken: true` for both `github-friendsfriend` and
  `gitlab-iconnect`;
- GitHub open issues/changes for `friendsfriend/agentic-coding` return
  successfully (0 open items);
- GitLab open issues for `funke-iconnect/icon-customer-v2` return successfully
  (0 items), and application-table `c` shows 10 open changes;
- table `i` opens the GitLab issue list with the correct `gitlab-iconnect`
  provider label.

Environment-mcp suite: **97 pass, 0 fail** (788 assertions, 38 files, 11.46s).
Plugin focused suite: **24 pass, 0 fail** (86 assertions). `bun run lint` and
`bun run type-check` are clean.

## Provider detail selection fix (task 3.67)

- `openProviderIssue` and `openProviderChange` previously defaulted to the
  already-loaded detail before the selected list row, so opening a second item
  reused the first detail. They now default to the selected row; refresh passes
  the current detail explicitly.
- A disposable fixture with three issues verified: issue #1 opened, `Esc`
  returned to the list, `Down` + `Enter` opened issue #2, then issue #3, each
  with its own title and body. The same fix applies to change detail.
- The store also clears stale change/issue detail when loading a list or moving
  the selection, and the keymap passes the selected row explicitly.
- Running OpenCode processes were started before this source change and keep
  the previously loaded plugin modules; a full OpenCode restart is required to
  load the fix. No user process was terminated.

## Application-table provider action selection (task 3.68)

- Table `i`/`c` previously called `selectedApp()`, which preferred the last
  opened `selectedAppId`. After opening one application, moving the table
  selection and pressing `i` still resolved the old application's provider
  repository.
- The table view now forces `selectedApp()` to the highlighted row, and
  `openAppProvider` explicitly uses `filteredApps()[selectedIndex()]`.
- A two-app disposable fixture verified: move from `app-a` to `app-b`, press
  `i`, see `org/repo-b` / `Issue B`, not app-a's issues.

## Provider diff/discussion keys (task 3.69)

- `f` is reserved for panel fullscreen. Provider change detail now uses `d`
  for changed files/diffs and `h` for discussion history; `c` and `a` remain
  comment and exact-head approval.
- Clearing list filters no longer resets the selected provider index. Opening
  files, discussions, jobs or switching change/issue state keeps the provider
  header and follow-up reads on the same provider.
- Live verification on `customer-fe` change #1881: change detail showed
  `gitlab-iconnect`, `d` opened its three changed files, and `h` opened its
  discussion history (`y5114 approved this merge request`) with the same
  provider.

Environment-mcp suite: **97 pass, 0 fail** (789 assertions, 38 files, 10.68s).
Plugin focused suite: **24 pass, 0 fail** (87 assertions). `bun run lint` and
`bun run type-check` are clean.

## Provider detail UI (task 3.70)

- Change and issue descriptions now render through OpenTUI `MarkdownRenderable`
  with a renderer-owned syntax style cached by renderer/theme. Headings, bold,
  inline code, lists and links render as Markdown instead of raw markers.
- The provider file view uses the built-in OpenTUI `DiffRenderable` with line
  numbers, add/remove signs and colors, word wrapping and a scrolling parent.
  No patch text is synthesized; non-textual diffs show a clear fallback.
- Discussion history is a timeline: system events get approval/merge/close
  glyphs, author/timestamp/resolved badges form the header, and each note body
  renders as Markdown under the timeline rail.
- Syntax styles are created with the active renderer owner and cached per
  renderer/theme. Creation is wrapped: if the host rejects the owner, Markdown
  falls back to streamed host rendering and the panel stays alive instead of
  crashing `session.panel`. Diff keeps the renderable's own context-owned
  fallback. Markdown bodies also use streaming so text appears before the
  syntax pass.

Live verification:

- disposable Markdown fixture: `# Summary`, bold, inline code, a two-item list
  and a link rendered without markers; the diff showed numbered context/add/
  remove lines; the timeline showed an approval event with `✓` and a Markdown
  comment with bold, inline code and a list.
- real `customer-fe` change: the provider diff rendered the actual source patch
  with line numbers and removed lines under the correct `gitlab-iconnect`
  provider.

Environment-mcp suite: **97 pass, 0 fail** (789 assertions, 38 files, 10.79s).
Plugin focused suite: **24 pass, 0 fail** (87 assertions). `bun run lint` and
`bun run type-check` are clean.

## OpenTUI ResourceContext crash fix (task 3.71)

- The initial explicit style path could raise
  `SyntaxStyle requires an explicit resource owner` in a panel slot. The style
  path now catches that mismatch and falls back to the host renderable's own
  handling; markdown renders with `streaming` so text is visible without a
  successful syntax pass.
- Re-tested provider change Markdown, native diff and the discussion timeline in
  a disposable panel after the fix; no slot crash and all three views rendered.

Environment-mcp suite: **97 pass, 0 fail** (789 assertions, 38 files, 12.88s).
Plugin focused suite: **24 pass, 0 fail** (87 assertions). `bun run lint` and
`bun run type-check` are clean.

## List readability and scrollbars (task 3.72)

- Provider change rows are two lines: number/title/state, then source → target
  and author. Issue rows are two lines: number/title/state, then author and
  labels (or `no labels`).
- All scrollboxes previously forced `verticalScrollbarOptions.visible = false`;
  that override was removed, so OpenTUI's native vertical scrollbar appears on
  the right only when the content overflows. Horizontal scrollbars remain
  hidden.
- Live verification: the 41-application table showed a right-edge scrollbar;
  `customer-fe` changes showed two readable lines per row with branch and author
  while keeping the correct `gitlab-iconnect` provider.

Environment-mcp suite: **97 pass, 0 fail** (789 assertions, 38 files, 13.46s).
Plugin focused suite: **24 pass, 0 fail** (87 assertions). `bun run lint` and
`bun run type-check` are clean.

## Application and target CRUD (task 3.73)

- Added `env_config_revision` and preview-confirm `env_app_create`,
  `env_app_update`, `env_app_delete`, `env_target_create`,
  `env_target_update` and `env_target_delete`.
- Writes require the exact current digest and confirmation digest, serialize,
  validate the whole v2 configuration, create a private
  `environments.json.mcp-bak-*` backup, atomically replace the file and refresh
  the execution catalog. A refresh failure restores the prior bytes.
- App deletion refuses targets unless explicit cascade is confirmed and always
  refuses external prerequisite references. Target deletion refuses defaults and
  references. Repository changes refuse while targets exist.
- `profile` is only a target label; no profile entity or MCP profile action was
  added.
- UI: `n` new app, `E`/`X` edit/delete app, target picker `n`/`d`/`e`/`x`,
  digest preview and `y` confirmation.

Live verification:

- a disposable service created `app-b`, observed the new revision and a backup,
  then completed a second write against the refreshed configuration;
- the panel created `app-c` through the preview-confirm form and refreshed the
  applications table;
- target picker navigation showed the new `n`/`d`/`e`/`x` actions; target
  mutations were exercised through the disposable service tests, not applied to
  the real configuration.
- The real configuration was previewed only; no real configuration write was
  made.

Environment-mcp suite: **101 pass, 0 fail** (856 assertions, 39 files, 10.02s).
Plugin focused suite: **26 pass, 0 fail** (93 assertions). `bun run lint` and
`bun run type-check` are clean.

## Provider issue comments and version history (task 3.74)

- `env_provider_issue_comments` reads at most 50 GitHub issue comments or
  GitLab issue notes. Issue detail `h` renders them through the same Markdown
  timeline as change discussions.
- Change detail `v` opens the existing `env_provider_change_versions` history
  as a two-line version list with SHA, message/date and author when supplied.
- Provider JSON response limit increased from 256 KiB to 1 MiB after a large
  public GitHub issue page exceeded the old bound; the consumer mapping remains
  capped at 50 items and the capability result stays under 128 KiB.

Live verification:

- GitHub `anomalyco/opencode` issue #66549 opened its comment timeline with the
  Markdown comment body under `github-friendsfriend`;
- `customer-fe` change #1882 showed one version (`1bbffb60`) under
  `gitlab-iconnect`.

Environment-mcp suite: **101 pass, 0 fail** (863 assertions, 39 files, 10.65s).
Plugin focused suite: **26 pass, 0 fail** (94 assertions). `bun run lint` and
`bun run type-check` are clean.

## Timeline connectors and event glyphs (task 3.75)

- Discussion and issue-comment timelines render a dedicated rail column: the
  event glyph sits directly on the rail and the connector continues beneath it
  through the Markdown body and into the next entry.
- Event glyphs distinguish resolved/approved (`✓`), unapproved/removed (`✗`),
  merged (`◆`), closed (`✕`), reopened (`○`), assigned (`→`),
  unassigned (`←`), labels (`▣`), commits/added (`↑`), review (`?`) and ordinary
  comments (`●`).
- Change version history uses a commit glyph (`◆`) and connector between
  versions.
- Verified with a fixture containing approval, close, reopen and comment events:
  all four glyphs and the connector rail rendered correctly; live GitHub issue
  comments and GitLab version history also rendered.

Environment-mcp suite: **101 pass, 0 fail** (863 assertions, 39 files, 10.74s).
Plugin focused suite: **26 pass, 0 fail** (94 assertions). `bun run lint` and
`bun run type-check` are clean.

Environment-mcp suite: **101 pass, 0 fail** (863 assertions, 39 files, 11.27s).
Plugin focused suite: **26 pass, 0 fail** (94 assertions). `bun run lint` and
`bun run type-check` are clean.

Environment-mcp suite: **101 pass, 0 fail** (863 assertions, 39 files, 10.96s).
Plugin focused suite: **26 pass, 0 fail** (94 assertions). `bun run lint` and
`bun run type-check` are clean.

## Provider HTML normalization (task 3.76)

- Provider bodies are passed through a bounded HTML-to-Markdown normalizer before
  Markdown rendering. It handles paragraphs, headings, bold/italic/deleted,
  inline code, fenced code blocks, lists, blockquotes, details/summary, links,
  images, line breaks, horizontal rules, entities and relative GitLab links.
- Change/issue descriptions, timeline notes and version messages all use the
  same normalizer. Ordinary Markdown is left intact apart from entity decoding.
- Converter tests cover GitLab system-note lists/links/code, details and code
  blocks, entities, relative links and plain Markdown passthrough.

Environment-mcp suite: **104 pass, 0 fail** (874 assertions, 40 files, 10.59s).
Plugin focused suite: **29 pass, 0 fail** (105 assertions). `bun run lint` and
`bun run type-check` are clean.

## Provider merge/issue-state/rebase and cwd slash commands (tasks 3.77-3.78)

- `env_provider_merge_change` re-reads the head SHA before GitHub/GitLab merge,
  supports GitHub merge/squash/rebase methods, and stores a normal durable
  receipt. `env_provider_set_issue_state` opens/closes issues.
  `env_provider_rebase_change` is GitLab-only and refuses other providers.
- UI: change detail `M` merge, `B` rebase; issue detail `o` toggle state. All use
  the existing preview-confirm receipt flow.
- `env_provider_repository` accepts `session: true` for the current cwd outside
  the configured allowlist. `/issues` and `/changes` request that resolution and
  open the matching provider list in the panel.
- Live: session resolution of `/Users/fabiankellner/agentic-coding` returned
  `github-friendsfriend/friendsfriend/agentic-coding`; merge preview returned a
  confirmation digest without a write. Real merge/close/rebase writes were not
  performed.
- Merge/state/rebase command paths are covered by fake GitHub/GitLab writes.

Environment-mcp suite: **105 pass, 0 fail** (894 assertions, 40 files, 10.88s).
Plugin focused suite: **29 pass, 0 fail** (105 assertions). `bun run lint` and
`bun run type-check` are clean.

## Plugin launch aliases (task 3.79)

- Slash commands are now exactly `/environment`, `/git`, `/issues` and
  `/changes`; the `/env`, `/git-actions`, `/git-cwd`, `/provider-issues` and
  `/provider-changes` aliases were removed. Keyboard binds remain
  `<leader>v` and `<leader>G`, and the home footer chip remains.
- Live OpenCode test: `/git` listed and opened the Git view; `/issues` opened
  `friendsfriend/agentic-coding` issues for the cwd outside the configured
  allowlist.

Environment-mcp suite: **105 pass, 0 fail** (894 assertions, 40 files, 11.35s).
Plugin focused suite: **29 pass, 0 fail** (105 assertions). `bun run lint` and
`bun run type-check` are clean.

## Provider unapprove, discussions, labels/assignees and job retry (tasks 3.80-3.81)

- New capabilities: `env_provider_unapprove_change`,
  `env_provider_reply_discussion`, `env_provider_set_discussion_resolved`,
  `env_provider_add_labels`, `env_provider_set_assignees` and
  `env_provider_retry_job`. All use the existing exact intent digest,
  request-id replay/conflict handling and durable receipts.
- GitHub unapproval re-reads the exact head, resolves the configured account,
  finds its latest APPROVED review and dismisses that review. GitLab unapproval
  sends the exact head SHA to the unapprove endpoint.
- Discussion replies support change review threads and issue threads. GitLab
  discussion resolution toggles the whole discussion; GitHub resolution refuses
  because the REST API exposes no thread-resolution endpoint and this
  implementation does not use GraphQL. GitLab note ids now retain their parent
  discussion id for replies.
- Labels are appended to changes or issues. Assignees replace the current set;
  GitLab usernames are resolved to user ids before the update.
- Individual job retry posts to GitHub workflow-job rerun or GitLab job retry.
- Panel keys: change `u` withdraw, `l` labels, `A` assignees; issue `l`/`A`;
  discussion `c` reply and GitLab `x` resolve/unresolve; jobs `t` retry. The
  reply/label/assignee forms use the same preview/edit/confirm flow.
- The write editor now binds Enter to preview explicitly. Without this the
  OpenTUI input did not advance the stage in the PTY.
- Discussion replies previously lost the selected thread after the view
  switched to `provider-write`; selection now follows the recorded write origin.
- PTY verification with a disposable fake GitHub provider completed:
  reply (`POST /issues/1/comments`), labels (`POST /issues/1/labels`),
  assignees (`PATCH /issues/1`), job retry (`POST /actions/jobs/12/rerun`) and
  unapprove (`GET /user`, `GET` reviews, `PUT` dismissal). Direct capability
  checks completed the GitLab resolve, reply, labels, assignees, job retry and
  unapprove paths. No real provider writes were performed.

Environment-mcp suite: **107 pass, 0 fail** (936 assertions, 40 files, 11.99s).
Plugin focused suite: **29 pass, 0 fail** (105 assertions). `bun run lint` and
`bun run type-check` are clean.

## Guarded Git writes (tasks 3.82-3.83)

- New capability `env_git_write` previews and confirms eight writes: `push`,
  lightweight `tag`, `branch-rename`, `remote-set-url`, stage-all `commit`,
  `stash`, `merge` and `rebase`. The first call returns a SHA-256 digest of the
  exact repository and request without running git; the same request with that
  digest executes it.
- Push never uses force and refuses unknown branches or remotes. Tags and
  renamed branches are validated with `git check-ref-format` and checked for
  collisions. Remote URLs reject credential-bearing HTTP forms. Commit and
  stash refuse an empty change set. Merge and rebase refuse the current branch
  and a dirty worktree.
- Confirmation replay is cached per service process; git itself remains the
  durable record. Unlike provider writes, Git writes do not use a durable
  receipt journal.
- Panel: `P` push, `t` tag, `R` rename, `C` commit all, `s` stash, `M` merge,
  `B` rebase, and remotes `e` edit URL. The confirmation screen shows the exact
  target (for example `main → origin`) and digest; `y` executes. The result view
  shows status, reason, branch/head and bounded output with remote credentials
  redacted.
- Backend test covers all eight actions against local repositories and a local
  bare remote, plus digest replay, request conflict, dirty-worktree refusal and
  stash/commit/merge/rebase outcomes.
- PTY verification against a disposable repository completed commit, tag,
  merge, push, stash, branch rename and remote URL update, including target
  display and result output. Rebase is covered by the backend test.
- Existing Git reads and direct fetch/pull/checkout/worktree/remote actions are
  unchanged.

Environment-mcp suite: **108 pass, 0 fail** (961 assertions, 40 files, 11.52s).
Plugin focused suite: **29 pass, 0 fail** (105 assertions). `bun run lint` and
`bun run type-check` are clean.

## Kubernetes inspection depth (tasks 3.84-3.85)

- `env_cluster_resources` now runs the same fixed `kubectl get
  deployments,statefulsets,pods,services` with JSON output and returns up to 200
  structured items (kind, name, status, readiness, restarts, containers, age)
  plus a bounded table fallback. Raw objects are not returned.
- New read-only capabilities: `env_cluster_events` (up to 100 namespace events),
  `env_cluster_describe` (one resource from a fixed kind set) and `env_pod_logs`
  (up to 1000 tail lines, optional container). All keep cluster authorization,
  non-system namespace checks, fixed kubectl arguments, 128 KiB output bounds and
  the existing kubeconfig/environment non-disclosure.
- Panel: resources are selectable two-line rows; `Enter` describes, `e` opens
  namespace events, `l` reads pod logs using the pod's first container, `r`
  refreshes and `Esc` returns to resources.
- Unit test covers structured resources, events, describe, pod logs, fixed argv,
  invalid resource names/kinds/tails, namespace and authorization refusals.
- PTY verification against a fake kubectl fixture completed resources →
  describe → pod logs → events. No live cluster was available; live-cluster
  behavior remains manually unverified.

Environment-mcp suite: **108 pass, 0 fail** (985 assertions, 40 files, 10.57s).
Plugin focused suite: **29 pass, 0 fail** (105 assertions). `bun run lint` and
`bun run type-check` are clean.

## Tags, stashes and staging (tasks 3.86-3.87)

- New read capabilities `env_git_tags` (up to 200 tags with annotated state,
  subject and date) and `env_git_stashes` (up to 100 stashes with index, branch,
  message and date).
- Git writes now include annotated `tag` (optional message), `tag-delete`,
  `stash-pop`, `stash-apply` and `stash-drop`. `commit` keeps the existing index
  and refuses when nothing is staged; new `commit-all` stages every change
  first.
- New direct, reversible git actions `stage`, `unstage`, `stage-all` and
  `unstage-all`. Paths must match a reported change and may not escape the
  repository.
- Panel: `T` tags, `t` create tag (name + optional message), `d` delete tag;
  `S` stashes, `p` pop, `a` apply, `d` drop; `C` commit staged, `A` commit all;
  Changes `s` toggle stage, `a` stage all, `u` unstage all.
- The changes header shows the staged count. Tag/stash data refreshes without
  replacing the completed-write result screen.
- Backend tests cover annotated tags, tag delete, stash list/pop/apply/drop,
  stage/unstage/all, staged versus all commits, path validation and refusal
  reasons.
- PTY verification completed staged commit and commit-all, annotated tag
  creation, tag deletion, and stash pop/drop through the panel.

Environment-mcp suite: **109 pass, 0 fail** (1020 assertions, 40 files, 12.82s).
Plugin focused suite: **29 pass, 0 fail** (105 assertions). `bun run lint` and
`bun run type-check` are clean.

## Force-with-lease push and rebase abort (task 3.88)

- `push-force` refuses unless the selected branch tracks the requested remote
  and a local remote-tracking ref exists. The adapter resolves that ref and
  passes it as the exact `--force-with-lease=<branch>:<sha>` value, so a moved
  remote is rejected rather than overwritten.
- `rebase-abort` refuses when no rebase is in progress and otherwise runs
  `git rebase --abort`.
- Panel: Git `F` force push with lease, `X` abort rebase. Both show the exact
  target and digest before running.
- Backend test covers a successful force push after local history rewrite,
  refusal without an upstream, a real rebase conflict followed by abort, and
  refusal when no rebase is active.
- PTY verification completed force-with-lease push against a disposable bare
  remote and rebase abort after a real conflict.

Environment-mcp suite: **110 pass, 0 fail** (1028 assertions, 40 files, 14.32s).
Plugin focused suite: **29 pass, 0 fail** (105 assertions). `bun run lint` and
`bun run type-check` are clean.

## Configuration polish and editing skill (tasks 3.89-3.90)

- App create/edit now exposes build/test/run defaults. App update sends the full
  defaults object, so clearing a field clears that default.
- Shell target create/edit exposes environment, secret references and ready
  text. `env_target_update` now accepts and clears shell `environment` and
  `secretRefs`; non-shell targets refuse those fields.
- Target edit exposes profile, action, command, timeout, ready text, endpoints,
  endpoint services and prerequisites. Endpoints and endpoint services are only
  sent when they were visible in `env_list` or edited, so hidden values are not
  cleared accidentally. Prerequisites are always exposed and replaced from the
  form.
- Added `environment-config-editing` as a skill under the plugin package and
  linked it into `~/.config/opencode/skills`; it covers profiles, bulk edits,
  secret handling and full shell/Compose/container/Helm descriptors.
- PTY verification against a disposable configuration set app test/run defaults,
  edited a shell run target's environment and secret references, set endpoints,
  and preserved prerequisites. The resulting `environments.json` was checked
  directly. No real configuration was written.

Environment-mcp suite: **110 pass, 0 fail** (1035 assertions, 40 files, 14.58s).
Plugin focused suite: **29 pass, 0 fail** (105 assertions). `bun run lint` and
`bun run type-check` are clean.

## Kubernetes log and event polish (task 3.91)

- `env_pod_logs` accepts `previous` and passes `--previous` to kubectl; the
  returned log record carries the previous flag.
- Multi-container pods open a container picker before fetching logs. Selecting a
  container always starts with current logs; `p` in the log view toggles the
  previous container instance and reloads.
- Namespace events gain a `/` filter over type, reason, object and message, with
  Esc clearing the filter before leaving the view.
- Adapter test covers `--previous` argv and the returned flag. PTY verification
  covered the two-container picker, current/sidecar logs, previous-container
  logs and event filtering against a fake kubectl fixture.

Environment-mcp suite: **110 pass, 0 fail** (1037 assertions, 40 files, 14.62s).
Plugin focused suite: **29 pass, 0 fail** (105 assertions). `bun run lint` and
`bun run type-check` are clean.

## Worktree execution for Compose, container and Helm (task 3.92)

- `env_execute` now accepts `worktree` for Compose, container-run and
  helm-release targets as well as command/process and Docker builds.
  Network-only targets remain refused because they represent a shared bridge.
- Compose projects, container names and Helm releases receive a deterministic
  `-wt-<8-hex>` suffix derived from the canonical worktree path, preventing
  collisions with the main checkout and other worktrees.
- Repository-local Compose files are resolved through the worktree; a Compose
  file outside the repository refuses worktree execution. Helm charts are
  recaptured from the worktree, including a fresh chart digest, before admission
  verifies them; values remain chart-relative. Container-run has no repository
  paths, so only its name changes.
- Unit test covers Compose file/project rewriting, outside-file refusal,
  container-name suffixing, Helm chart/digest/release rewriting and command
  path behavior. Integration test admits, executes and observes Compose and
  container-run targets from a real linked worktree with a mock executor,
  asserting worktree cwd, rewritten Compose file/project and suffixed container
  name.
- Docker-build image tags and container-run images that match a build target's
  configured image receive the same per-worktree suffix, so a worktree build
  feeds the matching worktree container. External images and explicit Compose
  image names are not rewritten.
- Helm worktree execution is covered by the rewrite/digest unit test only; no
  live Helm worktree run was available.

Environment-mcp suite: **112 pass, 0 fail** (1050 assertions, 42 files, 13.50s).
Plugin focused suite: **29 pass, 0 fail** (105 assertions). `bun run lint` and
`bun run type-check` are clean.

## Container stats trends (task 3.93)

- The panel records a bounded 60-sample history per container while the stats
  view is open, sampling every two seconds without flipping the busy state or
  changing the view. History is pruned to currently reported containers.
- Each row now shows CPU and memory sparklines, CPU and memory deltas, network
  receive/transmit deltas and the sample count; a single sample shows a
  collecting state.
- Pure helper tests cover sample appending/pruning, sparkline scaling, deltas
  and missing values.
- History is UI-local and resets when the panel closes. No live running
  container was sampled in tests; live container verification remains pending.

Environment-mcp suite: **114 pass, 0 fail** (1059 assertions, 43 files, 13.49s).
Plugin focused suite: **31 pass, 0 fail** (114 assertions). `bun run lint` and
`bun run type-check` are clean.

## Force-with-lease digest binding (task 3.94)

- `push-force` now resolves the local remote-tracking ref before computing the
  intent digest and includes that SHA in the canonical request. The preview
  target shows `branch → remote (force-with-lease @<sha8>)`.
- If the tracking ref moves between preview and confirmation, the digest no
  longer matches and the service returns a new confirmation with the new lease.
  The panel updates the digest/target and asks again instead of silently using a
  newer lease.
- The adapter no longer re-resolves the lease at execution; it uses the
  digest-bound value.
- Backend test asserts the preview target contains the lease, that a moved
  remote-tracking ref produces a new confirmation, and that missing upstream/ref
  refuses.

Environment-mcp suite: **114 pass, 0 fail** (1061 assertions, 43 files, 14.42s).
Plugin focused suite: **31 pass, 0 fail** (114 assertions). `bun run lint` and
`bun run type-check` are clean.

Environment-mcp suite: **114 pass, 0 fail** (1062 assertions, 43 files, 14.56s).
Plugin focused suite: **31 pass, 0 fail** (114 assertions). `bun run lint` and
`bun run type-check` are clean.

## Kubernetes namespace listing (task 3.96)

- New read capability `env_cluster_namespaces` returns at most 200 non-system
  namespace names from a fixed `kubectl get namespaces -o json`.
- The cluster namespace view now loads the list, selects `default` when present,
  supports ↑/↓ selection, click selection and `/` for a typed custom namespace.
  Enter inspects the selected/typed namespace.
- Adapter test covers the JSON parse, `kube-*` filtering, sorting and fixed argv.
  PTY verification selected a listed namespace and inspected a typed custom
  namespace against a fake kubectl fixture.

Environment-mcp suite: **114 pass, 0 fail** (1069 assertions, 43 files, 13.78s).
Plugin focused suite: **31 pass, 0 fail** (114 assertions). `bun run lint` and
`bun run type-check` are clean.

## GitHub review-thread resolution (task 3.97)

- `set-discussion-resolved` now supports GitHub. It queries review threads
  through the provider GraphQL endpoint, finds the thread containing the
  selected review-comment database id and calls `resolveReviewThread` or
  `unresolveReviewThread`. Already-matching state is a no-op.
- GraphQL URLs derive from the configured base URL: `api.github.com/graphql`
  for github.com, otherwise the host plus `/api/graphql` after stripping
  `/api/v3`. Tokens are redacted from responses and errors.
- GitHub change discussions now read GraphQL review threads, so each comment
  carries its thread id and existing resolved state before any write. Issue
  comments remain REST. The panel also updates the selected discussion badge
  locally after a successful write.
- Provider-write test covers thread lookup, resolve, unresolve and the exact
  thread id passed to GraphQL. Provider-read test covers GraphQL thread
  mapping, token redaction and the resolved flag.

Environment-mcp suite: **115 pass, 0 fail** (1073 assertions, 43 files, 14.34s).
Plugin focused suite: **31 pass, 0 fail** (114 assertions). `bun run lint` and
`bun run type-check` are clean.

Environment-mcp suite: **115 pass, 0 fail** (1073 assertions, 43 files, 14.53s).
Plugin focused suite: **31 pass, 0 fail** (114 assertions). `bun run lint` and
`bun run type-check` are clean.

## Provider merge method and target display (task 3.99)

- Change `M` on GitHub opens a merge-method picker: merge commit, squash or
  rebase. GitLab continues to merge directly using the project's configured
  method.
- The chosen method is bound into the existing exact-head merge digest, and the
  confirmation/completed view shows the exact target, for example
  `org/repo:2 (squash)`.
- Provider write confirmations now show `intent.target` for all actions, not
  just merge.
- PTY verification selected squash, confirmed the digest and observed
  `PUT /pulls/2/merge` with `merge_method: "squash"` against a disposable fake
  provider.

## Git commit history (task 3.100)

- New read capability `env_git_log` lists at most 50 commits from the current
  HEAD history with full/short SHA, subject, author, ISO date and ref names.
- Git view `L` opens commit history with selectable two-line rows and HEAD/tag/
  remote ref badges.
- Backend test covers ordering, short SHA, subject, author and tag refs. PTY
  verification showed the two-commit history with `HEAD -> main` and `tag: v1`
  badges.
- The capability action-list bound was raised from 64 to 128; the live surface
  now exposes 65 capabilities.

Environment-mcp suite: **116 pass, 0 fail** (1083 assertions, 43 files, 13.87s).
Plugin focused suite: **31 pass, 0 fail** (114 assertions). `bun run lint` and
`bun run type-check` are clean.

## Git commit detail (task 3.101)

- New read capability `env_git_commit` returns one commit's full message,
  author/email/date, parents, up to 200 changed-file stats and a bounded 48 KiB
  unified diff.
- Git history `Enter` opens the detail: full message line-by-line, parents, file
  and line totals, per-file stats and native diff blocks split per file.
- Backend test covers message body, email, parents, file stats and diff content.
  PTY verification showed a two-file commit with its multi-line body and both
  per-file diffs.
