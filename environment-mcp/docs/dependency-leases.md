# Shared dependency start and lease design

Status: controller-wide leases implemented. Start descriptors are declared as
`serviceBindings.<id>.start: {app, target}` and use the existing executable
approval/run path. Dependent runs acquire leases at dispatch; owner cleanup is
refused while leases exist; scope close releases leases; the last dependent stop
stops the exact started containers and marks the service released. Restart
adoption and a dedicated start/stop capability remain open.

## Invariants

- A borrowed (shared/external) observation never grants cleanup ownership.
- Starting an absent service is a mutation and needs an exact human-approved plan.
- A started service may be reused by any number of dependents while leased.
- The last lease release may stop only resources created by that exact start
  operation; volumes and pre-existing services are never stopped or reconfigured.
- Restart never adopts a saved container ID or process handle. A service started
  by an old host remains inspection-only until an operator resolves it.
- External services are observation-only and are never started.
- Cross-repository borrowing must not imply cross-repository cleanup authority.

## Current gap

`serviceBindings` describes an existing Docker container identity
(socket/name/image/labels/network/readiness). An absent shared dependency returns
`dependency-start-required`; there is no reviewed start descriptor, no
controller-level service record, and no lease count. `env_stop(app)` only sees
per-scope owned containers.

## Options

### A. Scope-local owned start

Add an optional `start` descriptor to a service binding. On a missing shared
service, prepare a start review in the same client scope. Record the created
containers as owned by a synthetic service app, and record leases for dependent
apps in that scope. Release on app stop/scope close; stop the service when the
last lease leaves.

Pros: smallest change; reuses the existing journal, approval and owned ledger.
Cons: only shares within one fixed-repository client scope; another client
cannot reuse the started service.

### B. Controller-wide shared-service leases

Add a journal-level `sharedServices` record keyed by service id with:

- exact start operation id and creation identity (container/image/network IDs),
- owner host and state (`starting|ready|stopping|uncertain`),
- leases `{scope, app, target, operation}`.

A start capability admits an exact plan, a separate approval issues it, and a
successful start installs the service record. Dependency preparation leases an
existing ready service or returns start-required. App stop/scope close releases
leases. Last-release cleanup stops only the exact created containers; failure
retains the record as uncertain.

Pros: matches the "shared" semantics across repositories and clients; gives the
operator one authoritative view.
Cons: larger schema/state surface; cross-repository policy, restart uncertainty
and operator inspection need explicit rules.

### C. Manual infrastructure-app start (operational bridge)

Use the existing `env_execute`/`env_run` flow on a configured infrastructure app
whose Compose target starts the service. Add `serviceBindings` for the resulting
container so dependent targets can observe it. No automatic leases; the operator
must stop the infrastructure app only after dependents stop.

Pros: available today, no new authority model.
Cons: no reference counting or automatic cleanup; easy to stop a shared service
while a dependent still uses it.

## Recommendation

Adopt **B** if the cutover will have multiple client scopes/repositories sharing
services; otherwise start with **A** and document the scope boundary. In both
cases keep the `start` descriptor explicit and reuse the existing exact approval,
one-use issuance, owned-only cleanup and restart-conservative rules.

## Open decisions

1. Is a started service shared only within one client scope, or across all
   authorized repositories?
2. What start descriptor is authoritative: a Compose source/file, a single
   container image/argv, or an infrastructure app/target reference?
3. When is a lease acquired: dependency preparation, exact app start, or first
   successful use?
4. When a dependent is still active, should stopping the service be refused or
   deferred until the last lease releases?
5. Should an operator be able to adopt a still-running service after a controller
   restart, or must it remain inspection-only?
