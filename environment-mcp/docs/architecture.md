# Standalone MCP architecture

## Names and dependency direction

```text
src/cli.ts                       executable composition, stdio lifecycle
src/cli/options.ts               server launch argument parsing
src/mcp/create-server.ts         MCP tool names/schemas/results; no runtime rules
src/services/catalog-service.ts  authorized, bounded catalog reads
src/services/dependency-binding-service.ts
                                 scope-bound preparation and revalidation
src/configuration/               the standalone server's own schemas/readers
src/compatibility/v2-catalog.ts  explicitly selected legacy metadata import only
src/domain/                      environment decisions, identities and ports
src/adapters/docker/             read-only local Engine API observation
src/persistence/journal-store.ts private versioned SQLite and exclusive lock
src/services/operation-journal.ts
                                 scope/decision/issuance state transitions
src/services/dependency-operation-service.ts
                                 exact dependency review over original bindings
src/services/multi-repository-session.ts
                                 client-level routing over partitioned scopes
src/operator/                    separate authenticated human inspection/decision
src/transports/http/             bounded body and bearer verification helpers
src/services/shared-server.ts    shared-mode composition and private access file
```

MCP names belong at the transport surface; domain/service names describe
environment behavior, not coding agents, native tasks or a particular client.
Only the compatibility directory uses a legacy-format name. Package identity is
`environment-mcp`; no sibling source/package alias or broad re-export barrel is
provided. The naming refactor preserves CLI flags, wire tool names, output fields
and refusal behavior. Adding bindings is a separate implementation increment.

The MCP surface calls services; services depend on pure domain rules and narrow
ports. Adapters implement those ports. Configuration is trusted server input,
not model-authored authority. This package never imports an old application's
manager to obtain a hidden coding-agent runtime or state connection.

## Source-backed v1 parity matrix

Paths below are relative to `agentic-coding/src/`; they are reference evidence,
not code dependencies.

| Behavior | V1 source | Standalone status / extraction boundary |
| --- | --- | --- |
| Build/test and run target/profile choice | `agent-host/environment-tools.ts`, `server/actions/default-target.ts`, `server/environment/agent-routes.ts` | Manifest identities/default validation and exact target selection implemented. Build/test run fixed `command` descriptors; run uses `compose`, a single container run (Docker/Podman) or an owned shell-process group. Unsupported descriptors remain visible with a sanitized `executionIssue` code. Declared-default application to MCP calls remains a catalog concern, not a hidden fallback. |
| One environment composition | `server/environment-stack.ts` | Fresh CLI/MCP/service/adapter composition, no host/runtime import. Do not copy the full composition root with its workflow integration services. |
| Multi-repository client routing | Fresh | One client token binds several canonical repository scopes; explicit `repository` or a unique app chooses the scope, ambiguous actions refuse. Status/history aggregate with repository filters; owned ledgers remain partitioned. No cross-scope cleanup. |
| Atomic app acquisition and retained waits | `server/runtime/instances.ts`, `server/environment/agent-routes.ts` | Pending standalone slot queue. Compose startup has a bounded readiness wait and explicit `starting` receipt; there is no cross-app atomic acquisition or queue yet. |
| Shared/external/owned dependencies | `server/actions/target-compile.ts` (`dependencyLifecycle`, `compileDependencySteps`) | Default-shared decision rules copied; configured borrowed Docker binding preparation implemented. External has readiness only. Missing shared requires future approved start, never duplicate creation on an observation error. |
| Already-ready/shared execution identity | `server/actions/coordinator.ts`, `server/actions/engine.ts` | Frozen generation/revalidation and durable dependency-review issuance implemented. A service binding may name an exact infrastructure `start` app/target; successful owned start installs a controller-wide shared-service record, dependent runs acquire leases, owner cleanup is refused while leases remain, and the last dependent stop automatically stops the exact started containers. Shared app coordination is not implemented. |
| Readiness vs process existence | `server/actions/readiness.ts`, `server/environment/agent-routes.ts` (`summarizeAcquire`) | Explicit running/healthy Docker predicates for dependency observations; Compose startup probes declared loopback `endpoints`, observes Docker health, or reports running-only with an explicit source. App-level TCP probes remain pending. |
| Owned cleanup and dependents | `server/runtime/leases.ts` | Domain cleanup policy copied and an owned-resource ledger implemented. `env_stop` removes exact created container IDs or stops tracked process groups; shell processes run under a detached supervisor that kills its group if the controller crashes. No saved PID is adopted. Scaffold close fences and uncertain cleanup remain conservative. Opt-in idle cleanup stops owned apps and closes clean scopes after inactivity while busy/pending/inspection work keeps the scope open. A closed scope is reopened lazily by the next execution action; observation and historical reads never reopen it. Owned dependency reference counting and durable expiry remain pending. |
| BuildKit build secrets | v2 `src/environment/container.ts`, `src/environment/build-secrets.ts` | V2 template (with XML/text encoding), absolute regular/nonlinked file and declared environment modes resolved only at dispatch; values stay out of plans/receipts and are redacted from output. |
| Kubernetes Helm release | v2 `environment/kubernetes-helm.ts`, `helm-chart.ts`, `cluster.ts` | Fresh `helm install` only; repo chart bounded/hashed and rechecked at admission/dispatch; offline render rejects cluster-scoped/cross-namespace objects; Deployment availability readiness; exact revision/label cleanup. No kind provisioning, upgrades, CRDs, subcharts, hooks, lookups, port forwards or selector-based logs. |
| Helm receipts/cleanup | v2 `environment/kubernetes-helm.ts` original-receipt rules | Owned `helm-release` record stores only the observed namespace/release/revision/label and cluster digest; stop re-observes and refuses a changed release. Native chart logs are not inferred. |
| Networking/composition | `server/actions/compile.ts` (`composeLifecycleArgs`), `server/actions/compose-env.ts`, `server/actions/target-compile.ts`; v2 `compose-network.ts` principles | Configured Compose file/project/services. `networkOnly` creates one exact owned bridge with a deterministic app/target name; `networkFrom` members attach their own containers; an absent network-only prerequisite can be created under the approved member operation, and then owned by that member until empty. Attachment is checked against the original bridge labels; source networks are not otherwise mutated. |
| Status/log/debug tools | `agent-host/environment-tools.ts`, `server/environment/agent-routes.ts`, `server/debug/` | Bounded owned-container status/logs, per-scope operation summaries (`env_history`) and last-redacted-log retention after a successful stop are implemented in memory. Native shell, Compose collector and container-run OTLP/HTTP JSON spans/logs are captured in memory and exposed through `env_telemetry`; the shared OpenTUI has a selectable trace browser and result tree renderer. Debug queries remain pending. Compose service `x-secret-refs`/target `secretRefs` are injected through a private override file at dispatch, never into plans or receipts. |
| Restart | `server/runtime/leases.ts` (`adopt`) | Intentional difference: fresh borrowed observations may be prepared, but previous-host owned cleanup handles/issuance are never restored from saved IDs. |

The smallest reusable units are pure selection/lifecycle rules, runtime
observation/projection and bounded adapters. Copy those locally and record
provenance, rather than proxying to the old host or running two authorities.

## Installer-space Mocked trace

Read-only inspection of v1 configuration established:

- `apps/compose/installer-space-mw-Mocked-compose.yml` declares the app image and
  `depends_on: [redis, postgres]` on logical network `devenv-local`.
- Its Compose `include` list names `infrastructure/compose/redis-compose.yml`,
  `postgres-compose.yml` and `network-compose.yml`.
- The infrastructure files define named Redis/PostgreSQL services. The network
  template declares a bridge but **not** an external/global network identity.
- The app template declares Compose project `installer-space-mw-mocked`.
- Prior authorized live metadata inspection found the existing PostgreSQL under
  Compose project `document-service-mocked`, attached to
  `document-service-mocked_devenv-local`, with a data volume and port 5433.

The v2 capture flattened the included services into a stack that would try to
create another named PostgreSQL. That is not equivalent to borrowing it. Nor do
the original templates alone prove that another project's container is reachable
on a new app project's network. V1's dependency model is the reference, not a
claim that every old template implements safe cross-project reuse automatically.

The selected seam is an explicit standalone **configured dependency binding**:
local socket, container name plus image/expected Compose labels, exact network
name/alias and readiness predicate. The read-only adapter captures immutable
container/image/network IDs and creation/start identity; the service freezes and
rechecks them. This establishes reviewed observation, not ownership or actual
application connectivity. The future app plan must explicitly join the approved
compatible network, or refuse before mutation. It must not attach/reconfigure the
existing database as an undisclosed convenience.

No v1 database, lease record, `.env`, inspector environment values or credentials
are imported. The actual configured reuse plan must be freshly observed/reviewed
before execution. The old pending installer-space plans cannot authorize the new
behavior and must be superseded, not edited or rearmed.

## Current preparation contract

`createDependencyBindingService(manifest, repository, inspectionPort)` is bound
by trusted server code to one configured repository. It resolves only that
repository's declared app/target dependencies. `prepare` returns immutable review
bytes/digest for ready shared/external services; missing, unready, mismatched and
unobservable services return distinct refusals. It cannot grant an owned handle.
`revalidate` only accepts its own original preparation, reads fresh observations
and compares with the original bytes. It never replaces those bytes with a new
generation. This host-local handle is not the eventual durable approval journal.

The Docker adapter issues only a bounded GET over the explicit Unix socket. It
does not use Docker CLI, default context, caller credentials, TCP or mutation
endpoints. Socket symlinks are resolved explicitly and directory/socket identity
is rechecked; this is not an OS security boundary against a hostile same-user
namespace writer. A 404 is absence, while transport/server/JSON/size failures are
unknown. Inspector Env, mounts, arguments and health logs are withheld from the
prepared projection. Network aliases are observed metadata, not proof of unique
DNS resolution or application/database protocol readiness.

## Durable review and shared serving

`startSharedServer` composes the standalone manifest, fixed client definitions,
private operation journal, Docker inspection adapter and two separate listeners.
It validates client credential references before opening state, creates scopes
from trusted configuration, and keeps per-request SDK factories side-effect-free.
It never creates an environment manager or coding host per client connection.

The shared MCP surface exposes catalog reads, dependency-review admission and
receipt reads. The human listener exposes bounded operation summaries, one exact
snapshot and digest/revision-fenced decisions. Neither listener exposes an
issuance or execution tool. Operator capability publication is exclusive/private
and shutdown removes only the original unchanged file after joining listeners.

Dependency reviews contain original scope/workspace identity and binding review
bytes. Content-bound request replay does not re-read current resources; a changed
intent refuses. Approval does not issue a permit. The internal operation service
revalidates the original host-bound bindings before a synchronous durable issuance
transaction, then provides one immutable host-local permit. Completion also
revalidates before recording a successful observation. Copies, foreign scopes and
old-host permits do not grant completion authority. Uncertainty is retained,
never automatically resent or used to stop borrowed resources.

The journal has its own SQLite application/schema identity and a single private
JSON document with explicit retained-record budgets. Synchronous transactions
avoid an alternate async persistence orchestration layer. This initial journal
is deliberately bounded and does not automatically prune durable evidence.
Startup interrupts old active scopes and pending/approved/issued operations;
issued uncertainty is inspection-required, while completed receipts remain
historical. Lock takeover by PID/age is not implemented.

These records have kind `dependency-bindings`: they authorize observations only.
They are **not executable app plans**, a source snapshot, a database permission or
owned process handles. Executable records are a separate kind with their own
human approval and issuance. No old dependency approval can implicitly authorize
a future build/start plan.

## Execution ledger and mutation boundary

Executable admissions freeze the target descriptor, repository HEAD, normalized
intent and (for a run) the reviewed dependency observations. Approval is still
only a decision; `env_run` re-observes frozen dependencies, journals issuance,
then dispatches through a fixed process adapter. A nonzero command exit is a
failed receipt. Compose startup records the exact container IDs it created in the
owned ledger, bounded to the declared services; a failed `up` is interrupted and
inspection-required because containers may exist.

The owned ledger is append-only during an issued operation and removed only after
confirmed exact-ID cleanup. `env_stop` and scope close can therefore never reach a
borrowed PostgreSQL/Redis: those are observations, not owned records. A copied
permit, another scope or another host cannot claim or complete the operation.
Partially cleaned resources stay; restart marks prior issued work uncertain and
never adopts saved container IDs. Kubernetes Helm releases use the same ledger:
the fresh install's release revision and label authorize uninstall, not a name or
copied state. Idle scope closure/rebinding and network-only Compose bridge
ownership are implemented; owned dependency reference counting and live bridge
creation remain unverified.

## Capability interface and UI parity

`src/interface/capabilities.ts` is the only action registry. It defines each
capability once: name, description, Zod input/output schemas, MCP annotations,
neutral UI label and the handler. Two entry points consume it:

```text
src/mcp/create-server.ts       MCP tools (derived via src/mcp/tool-surface.ts)
src/ui/capability-api.ts       UI contract over EnvironmentCapabilities
src/ui/http-capability-api.ts  authenticated HTTP implementation
src/ui/opentui.ts              standalone or embedded OpenTUI view
```

Neither entry point owns an action table or a second implementation. Adding a
capability to the registry makes it appear in both; removing it removes both.
`test/capability-parity.test.ts` asserts equal names, identical input-schema
identity and neutral labels, and fails if either entry point embeds its own
`env_*` names. The shared-server scenario additionally compares the real MCP tool
list with the authenticated HTTP UI action list over the same listener.

OpenCode can keep a local stdio entry through the `--connect` bridge, which
forwards the authenticated remote tool list/calls and creates no environment
authority or state. It is tested with a real stdio MCP client against the shared
fixture; the existing OpenCode entries are not switched automatically.

The UI package imports only the interface types and its transport, not MCP
registration, HTTP/Bun listeners or service construction. A standalone OpenTUI
injects `createHttpUiCapabilityApi`; an embedded OpenCode OpenTUI can mount the
same view under its own renderer root or inject an in-process registry. Both
hosts consume the same contract, so the view does not depend on the server
process or MCP transport.

Compose readiness now reports its source: declared loopback `endpoints` are
application-level probes, `docker-health` uses actual healthchecks, and
`docker-running` is running state only. If endpoints are configured but cannot be
probed, readiness is `unknown` rather than a running-only success. Docker-build
secrets resolve v2 template, absolute file and declared environment modes at
dispatch only; values never enter the plan or receipt and are redacted from output.

Operator approval is deliberately a separate capability set: it is human-only,
not an MCP tool, and is served by the authenticated operator API. `src/operator/`
adds an operator OpenTUI client/controller/view over that interface: exact-plan
approve/reject decisions plus inspection-required acknowledgement. It is built as
`environment-mcp/operator-ui`, never enters the agent registry and is never
importable from `src/ui/` by the architecture test. The agent MCP/UI parity rule
applies only to agent capabilities.
