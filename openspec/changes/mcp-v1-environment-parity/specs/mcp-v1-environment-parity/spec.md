## ADDED Requirements

### Requirement: Independent environment server package

The MCP SHALL be implemented in a separate package with its own dependency lock,
build, entrypoint, tests and versioned environment-native configuration. Required
v1/v2 functionality SHALL be copied/adapted locally with provenance, not imported
from either source tree or coding harness. Built output SHALL run outside the
checkout. Compatibility readers SHALL be distinct from execution authorization;
unimplemented mutation tools MUST NOT be advertised.

#### Scenario: Run the standalone artifact
- **WHEN** a user builds the package and copies only its output outside the checkout
- **THEN** a standard MCP client can inspect a configured fixture without v1/v2 source, an agent host or their state stores

#### Scenario: Preserve the old installation during construction
- **WHEN** the standalone package is being implemented
- **THEN** existing OpenCode connections and old source implementations remain unchanged until explicit verified cutover

### Requirement: V1 behavioral reference

The MCP environment implementation SHALL document and follow v1's configured application/profile/target selection, dependency lifecycle, acquisition and bounded status/log behavior. Catalog equality alone MUST NOT be claimed as behavioral parity. Intentional differences and deferred capabilities SHALL be explicit.

#### Scenario: Select Mocked
- **WHEN** a client requests installer-space-mw with the Mocked preset
- **THEN** the controller resolves that configured preset and its dependency behavior rather than asking the agent to assemble Docker commands

### Requirement: Shared and external dependency reuse

The controller SHALL distinguish owned cleanup capabilities from configured shared/external observations. An existing ready shared dependency SHALL be reused without creating a duplicate. External dependencies SHALL be observed for readiness without start/stop mutations. Unknown or incompatible observations MUST NOT be treated as absence or readiness.

#### Scenario: Existing PostgreSQL
- **WHEN** the configured PostgreSQL prerequisite already runs and satisfies its identity/readiness requirements
- **THEN** the dependent app uses that service without stopping, recreating or acquiring cleanup ownership of it

#### Scenario: Observation failure
- **WHEN** the controller cannot establish a dependency's identity or readiness
- **THEN** startup returns an explicit diagnostic rather than creating a conflicting replacement

### Requirement: Approved dependency connectivity

The controller SHALL resolve a dependent app's actual network/endpoint connectivity as part of the frozen reviewed plan. Model-authored names or port numbers SHALL NOT grant reuse authority. Existing service network/configuration changes SHALL require explicit disclosed authorization; readiness MUST NOT be inferred from a published port alone.

#### Scenario: Existing Compose network
- **WHEN** a borrowed PostgreSQL runs on another configured Compose network
- **THEN** the plan explicitly describes how the new app reaches it or refuses with an actionable connectivity diagnostic before mutation

### Requirement: Cleanup preserves shared services

Stopping, cancelling or expiring an app scope SHALL release its references but MUST NOT stop, remove or reconfigure borrowed shared/external resources or their volumes. Owned dependency cleanup SHALL respect remaining live dependents.

#### Scenario: Stop installer-space
- **WHEN** the requesting scope stops its app after using shared PostgreSQL
- **THEN** PostgreSQL and its data remain intact and cleanup affects only resources the scope is authorized to own

### Requirement: Portable authority and replay fences

MCP SHALL use one authenticated environment authority with fixed principal/workspace bindings. Dependency reuse MUST NOT expose human credentials to agents or restore previous-host mutation/cleanup permits. Changed dependency identity or connectivity SHALL require a new frozen plan rather than modifying an issued record.

#### Scenario: Replaced dependency
- **WHEN** a reviewed shared dependency is replaced before startup
- **THEN** the controller refuses the stale binding rather than following the same container name to the replacement

### Requirement: Representative parity acceptance

Verification SHALL cover selection, ready dependency reuse, meaningful refusal and preservation of shared resources with lightweight tests. Any live acceptance claim SHALL identify what was actually observed and use only separately approved user-requested resources.

#### Scenario: Build and start through MCP
- **WHEN** an approved installer-space Mocked build/start is exercised through OpenCode
- **THEN** receipts distinguish build outcome, dependency reuse and observed application readiness, with bounded logs and no manual Docker lifecycle workaround

### Requirement: Single capability interface and UI parity

Every agent-triggerable environment action SHALL be declared once in the shared
capability registry with its input schema, annotations, UI label and handler. MCP
tools and the OpenTUI action surface SHALL derive from that registry; neither
entry point may carry an independent action table or handler. The UI layer SHALL
NOT import MCP registration, listeners, journals or runtime/service construction.
Execution SHALL be direct and idempotent. There SHALL be no approval, decision
or acknowledgement capability in the agent registry or UI.

#### Scenario: Add an agent action
- **WHEN** a capability is added to the registry
- **THEN** it appears in both MCP and the UI with the same input schema, and an architecture test fails if either entry point defines a private action

#### Scenario: UI without a server process
- **WHEN** the OpenTUI runs standalone or is embedded in a host
- **THEN** it consumes the UI contract over an injected capability source and does not construct the environment server

### Requirement: Readiness source is explicit

Compose execution SHALL report whether readiness came from a declared application
endpoint, Docker health, or only Docker running state. Running-only readiness
MUST NOT be described as application health. Declared endpoints SHALL be explicit
loopback HTTP(S) URLs with matching Compose service selectors; an unavailable
probe SHALL be unknown, not a successful readiness claim. BuildKit secret values
SHALL remain out of execution plans and receipts and SHALL be redacted from output.

#### Scenario: Application endpoint
- **WHEN** a Compose target declares a loopback endpoint and it returns HTTP 2xx/3xx
- **THEN** the receipt reports readiness `ready` with source `endpoint`

#### Scenario: No application probe
- **WHEN** a Compose target has no endpoint or healthcheck
- **THEN** the receipt reports `docker-running` and does not claim application health

### Requirement: Direct execution and receipts

`env_execute` SHALL admit and dispatch one exact configured target in a single
step. Replaying the same request id and intent SHALL return the same operation
and MUST NOT re-run it. `env_wait` SHALL observe the settled receipt. There SHALL
be no approval, decision, acknowledgement, operator listener or operator access
file. Issued uncertainty SHALL remain inspection-required and MUST NOT be
reissued automatically.

#### Scenario: Execute directly
- **WHEN** an authorized client invokes `env_execute` for a configured app/target
- **THEN** the operation is admitted and dispatched without a separate approval step, and its receipt names the exact readiness source

#### Scenario: Replay is not a rerun
- **WHEN** the same request id and intent is invoked again
- **THEN** the original operation is returned and no second dispatch occurs

### Requirement: Local stdio bridge preserves authority

The local stdio bridge SHALL forward only the authenticated remote MCP tool list
and calls. The bridge MUST NOT create a second journal, scope, listener, runtime
or cleanup authority, and MUST NOT print the bearer token.

#### Scenario: OpenCode local entry
- **WHEN** a host starts the bridge with a loopback MCP URL and private credential
- **THEN** its tool list and calls match the shared server, and stopping the bridge leaves the shared authority and state unchanged

### Requirement: Bounded diagnostics history

The controller SHALL expose bounded per-scope operation summaries and MAY retain
the last redacted log window after owned-container cleanup. Summaries MUST omit
frozen plans, borrowed identities, credentials and resource handles. Retained
logs MUST be redacted, bounded, explicitly marked historical and MUST NOT be
described as durable across restart.

#### Scenario: Read history after restart
- **WHEN** an authenticated scope lists recent operations after a controller restart
- **THEN** it sees only summary fields for that scope and no plan or foreign scope data

#### Scenario: Read logs after stop
- **WHEN** owned containers were successfully stopped and logs were captured
- **THEN** `env_logs` returns the retained redacted window with `historical: true` and a retention time

### Requirement: Bounded scope retention

When the journal reaches its scope cap, the controller SHALL evict only the
oldest inactive scope that has no owned resources, no live review or issuance and
no inspection-required uncertainty. It MUST NOT evict an active/closing scope or
uncertain work, and MUST refuse scope creation when no safe scope exists.

#### Scenario: Capacity with only active scopes
- **WHEN** the scope cap is reached and every scope is active
- **THEN** creating another scope refuses instead of deleting active history

#### Scenario: Inactive history at capacity
- **WHEN** an inactive scope has no owned resources, live review or uncertainty
- **THEN** it may be evicted oldest-first to admit the new scope, and its related request/decision records are removed with it

### Requirement: Idle owned-resource cleanup

When a user configures an idle timeout, the controller SHALL stop only owned
apps after that much capability inactivity. A client with an active operation
MUST be exempt. Borrowed/shared/external resources MUST NOT be stopped, and a
failed cleanup MUST retain its owned record for a later retry. Idle cleanup MUST
NOT be described as scope closure or durable expiry.

#### Scenario: Idle owned app
- **WHEN** a client has no capability use for the configured timeout and no active operation
- **THEN** its owned apps are stopped through the owned-only cleanup path

#### Scenario: Borrowed service
- **WHEN** idle cleanup runs for a client that only borrowed a service
- **THEN** that borrowed service is untouched

### Requirement: Owned shell-process lifecycle

A shell run target SHALL execute as an owned detached process group with bounded
output and optional loopback `readyUrl` or `readyText`. The controller SHALL
record the exact PID as owned, expose bounded logs, and stop only the tracked
group. Graceful shutdown SHALL stop tracked processes. A controller crash SHALL cause a
live supervisor to stop its process group. Restart MUST NOT adopt or kill a saved
PID; a surviving process is inspection-only and MUST NOT be described as cleanup
authority.

#### Scenario: Ready shell app
- **WHEN** an approved shell run reaches its configured readiness signal
- **THEN** the receipt reports the PID/readiness source and the process remains owned by the scope

#### Scenario: Stop a shell app
- **WHEN** the owner stops the app
- **THEN** the tracked process group is terminated and only exact confirmed records leave the owned ledger

#### Scenario: Restart
- **WHEN** a controller restarts with a previously owned process record
- **THEN** it does not adopt or kill that saved PID

### Requirement: Durable controller diagnostics

The controller SHALL maintain a private, bounded, sanitized diagnostics event
log for local troubleshooting. It MUST NOT expose an HTTP diagnostics or operator
surface, store credentials, plans, tool arguments or free text, and diagnostics
failures MUST NOT fail a capability request.

#### Scenario: Diagnose capability activity
- **WHEN** the local diagnostics log is read after a capability call
- **THEN** it includes allowlisted event/action/scope fields and no bearer token, plan or argument

#### Scenario: Log rotation
- **WHEN** the diagnostics file reaches its bound
- **THEN** it retains one older segment and continues writing a fresh bounded current segment

### Requirement: Read-only configuration doctor

The package SHALL provide a read-only configuration report for users. It MUST
not create state or listeners, and MUST not print commands, plans, credentials or
repository paths. It SHALL report executable/unavailable counts and sanitized
migration hints.

#### Scenario: Unsupported Compose target
- **WHEN** a user runs the doctor against a configuration with a non-prefixed Compose container name
- **THEN** the report counts it as unavailable and includes the sanitized prefix-migration hint

### Requirement: Provider-aware container execution

The controller SHALL support explicit Docker and Podman providers for build,
Compose and single-container run targets. Provider argv/state/log/stop calls
SHALL use the matching binary, single-container runs SHALL publish only declared
loopback ports, and secret values MUST NOT be passed on the command line. A live
Podman compatibility claim requires a real runtime verification.

#### Scenario: Podman build
- **WHEN** a Podman build target is approved and dispatched
- **THEN** the build uses the Podman provider and its remote socket prefix

#### Scenario: Container run
- **WHEN** a Docker or Podman single-container run reaches its declared readiness
- **THEN** its exact container identity enters the owned ledger and later stop/log calls use the same provider

### Requirement: Controller-wide shared-service leases

The controller SHALL support a configured service binding naming an exact
infrastructure `start` app/target. A successful approved owned start SHALL verify
the binding identity before publishing a controller-wide shared-service record. Dependent run operations
SHALL acquire a lease at dispatch, owner cleanup MUST be refused while leases
exist, and scope close SHALL release that scope's leases. Restart MUST mark prior
shared-service records uncertain and MUST NOT adopt their containers.

#### Scenario: Cross-scope dependent
- **WHEN** one scope starts a shared service and another scope runs a dependent app
- **THEN** the dependent lease blocks owner cleanup until it is released

#### Scenario: Last-release cleanup
- **WHEN** the last dependent releases its lease
- **THEN** the controller stops the exact started containers, removes their owned records and marks the shared service released

### Requirement: Native shell telemetry

The controller SHALL support the v2 native shell telemetry declaration with an
OTLP/HTTP JSON loopback receiver. The receiver SHALL require a per-run bearer
credential, bound and redact stored spans/logs, inject standard `OTEL_*` values
into the process, and expose only an authenticated `env_telemetry` read surface.
Container-run telemetry is a separate declared path.

#### Scenario: Shell run telemetry
- **WHEN** an approved shell run with native telemetry emits OTLP logs and spans
- **THEN** `env_telemetry` returns bounded redacted logs and trace summaries for that app

#### Scenario: Unauthorized telemetry request
- **WHEN** a loopback request lacks the per-run bearer credential
- **THEN** the receiver rejects it without storing data

### Requirement: Compose secret references

The controller SHALL keep the v2 Compose service `x-secret-refs` and target
`secretRefs` as per-service container environment references, separate from the
Compose process interpolation references in `compose.envRefs`. The controller
MUST refuse a conflict with a literal service environment key or a conflicting
reference. Secret values MUST NOT enter plans or receipts.

#### Scenario: Service secret reference
- **WHEN** a Compose service declares `x-secret-refs`
- **THEN** the executable carries the per-service reference, resolves it only at dispatch and injects it through a private Compose override

### Requirement: Compose collector telemetry

The controller SHALL support the v2 Compose collector telemetry declaration with
an exact unexposed OpenTelemetry collector service, an explicit host gateway and
a TLS host-gateway receiver. The receiver SHALL require a per-run bearer
credential, use a fresh ephemeral certificate, and bound/redact stored spans and
logs. The controller MUST mount only the public certificate into the collector
and MUST NOT persist the private key or received telemetry.

#### Scenario: Compose collector telemetry
- **WHEN** an approved Compose run with a valid collector telemetry declaration starts
- **THEN** the collector receives generated exporter configuration and a CA mount, and `env_telemetry` reads bounded redacted data

#### Scenario: Untrusted collector declaration
- **WHEN** the declared collector differs from the exact image, command, exposure or host-gateway shape
- **THEN** the target is not executable and the doctor reports a sanitized issue

### Requirement: Telemetry trace rendering

The agent OpenTUI SHALL provide a selectable trace browser for
`env_telemetry` snapshots with trace summaries, and SHALL render the selected
trace as a bounded, indented parent/child tree. Snapshot logs MUST remain bounded
and readable. The browser MUST derive from the capability result and MUST NOT add
a UI-only action or invoke runtime services directly.

#### Scenario: Trace tree result
- **WHEN** `env_telemetry` returns a trace with child spans
- **THEN** the result view shows an indented tree with duration and status

#### Scenario: Unknown telemetry shape
- **WHEN** a telemetry result does not match a known bounded shape
- **THEN** the result view falls back to JSON instead of fabricating a tree

### Requirement: Container-run telemetry

The controller SHALL support an explicit `otlp-http-json` container-run
telemetry declaration. It SHALL start a fresh TLS host-gateway receiver, inject
standard OTLP exporter variables, mount only the public CA into the container and
bound/redact captured spans and logs. It MUST NOT claim image-specific
instrumentation or live compatibility without verification.

#### Scenario: Container telemetry capture
- **WHEN** an approved container run with telemetry emits OTLP logs or spans
- **THEN** `env_telemetry` reads the bounded redacted capture for that app

### Requirement: Kubernetes Helm releases

The controller SHALL support the v2 `helm-release-v1` target with an explicitly
configured cluster or the v1-compatible default `devenv`/`kind-devenv`
connection. The chart SHALL be bounded, hashed and rechecked at admission and
dispatch. Before any cluster effect, an offline render SHALL refuse
cluster-scoped, cross-namespace, list, CRD, subchart, hook, resource-policy and
`lookup` objects, and MUST name at least one apps/v1 Deployment. Installation
MUST be a fresh `helm install`, never an upgrade or adoption. Cleanup MUST
re-observe the exact created revision and per-operation label before uninstall.
The controller MUST NOT claim cluster provisioning, selector-based logs or live
compatibility without a live verification.

#### Scenario: Fresh Helm release
- **WHEN** an approved Helm target renders only namespaced Deployment objects and the release name is absent
- **THEN** the controller installs once, records the exact release revision/label, waits for Deployment availability and reports its readiness source

#### Scenario: Changed release
- **WHEN** Helm metadata no longer matches the owned revision or label
- **THEN** cleanup refuses and retains the owned record for inspection

### Requirement: Multi-repository clients

The controller SHALL allow one authenticated client to bind multiple canonical
repositories. Each repository SHALL retain a separate scope, owned ledger and
operation authority. Execution, dependency and resource actions MUST route by an
explicit repository or by an app identity present in exactly one authorized
repository; an ambiguous action MUST refuse. Status and history SHALL accept a
repository filter and SHALL aggregate without crossing cleanup authority.

#### Scenario: Unambiguous multi-repository app
- **WHEN** a client bound to two repositories requests an app that exists in only one
- **THEN** the action routes to that repository's scope

#### Scenario: Ambiguous app
- **WHEN** the same app identity exists in more than one authorized repository and no repository is supplied
- **THEN** the controller refuses with `repository-ambiguous` rather than guessing

#### Scenario: Repository-scoped cleanup
- **WHEN** an app is stopped in one repository scope
- **THEN** owned resources in the other repository scopes remain untouched

### Requirement: Compose network-only bridges

The controller SHALL support the v2 `networkOnly` Compose target and
`networkFrom` membership. A network-only target MUST declare exactly empty
services and create one owned bridge with a deterministic app/target name.
Readiness MUST mean bridge creation only, not application health. A member MUST
verify the original bridge identity/labels, start only its own Compose stack and
attach only the container IDs it created. The member MUST NOT own or remove the
bridge. The bridge owner MUST refuse removal while containers remain attached.
Shutdown MUST stop member apps before network owners. Names or copied labels MUST
NOT restore ownership after restart.

#### Scenario: Network-only creation
- **WHEN** an approved network-only target has exactly empty services and its bridge name is absent
- **THEN** the controller creates and records one exact bridge

#### Scenario: Member attachment
- **WHEN** an approved networkFrom member starts and the prerequisite bridge identity matches
- **THEN** the controller attaches only that member's new containers and retains bridge ownership with the prerequisite

#### Scenario: Attached cleanup
- **WHEN** the bridge owner is stopped while a member container remains attached
- **THEN** removal is refused and the owned bridge record is retained

### Requirement: Network prerequisite admission

A member with an explicit `networkFrom` prerequisite SHALL be refused before
dispatch when the exact labelled bridge is absent and no matching configured
network-only prerequisite exists, or when an existing bridge does not match the
declared app/target. Admission MUST NOT create the bridge. The declared target
`prerequisites` SHALL remain visible in catalog metadata. Dispatch MAY create a
configured network-only prerequisite bridge when absent; it MUST then own only
that original bridge and remove it only after all attached containers settle.

#### Scenario: Missing bridge with approved prerequisite
- **WHEN** a member with a matching approved network-only prerequisite is admitted before the bridge exists
- **THEN** admission is allowed and dispatch creates the exact prerequisite bridge

#### Scenario: Missing bridge without prerequisite
- **WHEN** a member has no matching network-only prerequisite and the bridge is absent
- **THEN** the controller refuses with `network-prerequisite-unavailable`

### Requirement: Secret gap diagnostics

The configuration doctor SHALL report declared environment references that are
absent from the config `.env` and process fallback. It MUST emit only reference
names, never values. Executable admission SHALL refuse a missing declared
reference before human review.

#### Scenario: Missing declared reference
- **WHEN** an executable target declares a reference with no configured value
- **THEN** the doctor lists the app, target and missing reference name

#### Scenario: Missing reference at admission
- **WHEN** a target with a missing declared reference is prepared for review
- **THEN** admission refuses with `secret-reference-unavailable` and no operation is created

### Requirement: Idle scope closure

The idle reaper SHALL stop owned resources and MAY close a repository scope only
when it has no owned resources, no live execution and no pending or
inspection-required operation. Observation of a closed scope MUST NOT reopen it.
A later execution or dependency action SHALL create a fresh scope. Historical
operations, history, retained logs and telemetry from closed scopes SHALL remain
readable for the controller lifetime.

#### Scenario: Clean idle scope
- **WHEN** an idle client has no owned resources or pending work
- **THEN** the scope closes and the next execution action opens a fresh scope

#### Scenario: Busy idle scope
- **WHEN** an idle client has a running or pending operation
- **THEN** the scope remains active
