## ADDED Requirements

### Requirement: Container capability parity
Bun SHALL preserve Docker/Podman inspection, lifecycle, image/build/compose, log/stat/event and configured cleanup capabilities through the Bun action engine and existing route contracts.

#### Scenario: Container action completes
- **WHEN** a supported container start/build/stop action executes
- **THEN** runtime/profile identity, actual command or SDK-step accounting, readiness and result SHALL match the compatibility fixtures

#### Scenario: Runtime stream reconnects
- **WHEN** a container event/log stream disconnects and reconnects
- **THEN** subscriptions SHALL resume without duplicate listener ownership and support established resynchronization behavior

### Requirement: Kubernetes and cross-runtime parity
Bun SHALL preserve cluster discovery/lifecycle, image loading, kubeconfig, secrets, Helm deployment/readiness, status/watch/logs and cleanup, including cross-runtime endpoint resolution and dependency leases.

#### Scenario: Host workload consumes cluster dependency
- **WHEN** a configured host/compose/Kubernetes combination resolves dependency endpoints
- **THEN** generated endpoints, identities and lease ownership SHALL match the cross-runtime fixture contracts

#### Scenario: Cluster resource fails readiness
- **WHEN** a deployment or dependency does not become ready within its configured bound
- **THEN** startup SHALL NOT report success and owned cleanup/result history SHALL follow the action contract

### Requirement: Safe observation and cleanup
Runtime observation failure SHALL NOT be treated as confirmed resource absence. Cleanup/prune SHALL preserve existing age/ownership/protection policy and SHALL NOT broaden destructive behavior during migration.

#### Scenario: Runtime API is unavailable
- **WHEN** status inspection fails due to unavailable runtime infrastructure
- **THEN** Bun SHALL report uncertainty/failure without unconditionally recreating or deleting the resource

#### Scenario: Protected or unowned resource exists
- **WHEN** cleanup examines a pre-existing unowned/protected container, image or cluster resource
- **THEN** it SHALL retain that resource according to captured protection rules

### Requirement: Runtime work is server-scoped and Bun-owned
All runtime watches/pollers/backoff timers SHALL have cancellable server ownership. Each migrated capability SHALL have one production owner and no private Go adapter after completion.

#### Scenario: Server shuts down during watch reconnect
- **WHEN** shutdown occurs during backoff or active runtime streaming
- **THEN** owned listeners/timers SHALL stop without scheduling another reconnect

#### Scenario: Go backend is disabled after port
- **WHEN** the Go process is unavailable after this change completes
- **THEN** every baseline production route/action SHALL still have its Bun implementation
- **AND** hiding an unsupported feature SHALL NOT count as parity
