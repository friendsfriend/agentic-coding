## ADDED Requirements

### Requirement: Independent environment server package

The MCP SHALL be implemented in a separate package with its own dependency lock,
build, entrypoint, tests and versioned environment-native configuration. Required
v1/v2 functionality SHALL be copied/adapted locally with provenance, not imported
from either source tree or coding harness. Built output SHALL run outside the
checkout. Compatibility readers SHALL be distinct from execution authorization;
unimplemented mutation tools MUST NOT be advertised.

#### Scenario: Run the standalone artifact
- **WHEN** an operator builds the package and copies only its output outside the checkout
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

MCP SHALL use one authenticated environment authority with fixed principal/workspace bindings. Dependency reuse MUST NOT expose operator credentials to agents or restore previous-host mutation/cleanup permits. Changed dependency identity or connectivity SHALL require a new frozen plan and decision rather than modifying an approved record.

#### Scenario: Replaced dependency
- **WHEN** a reviewed shared dependency is replaced before startup
- **THEN** the controller refuses the stale binding rather than following the same container name to the replacement

### Requirement: Representative parity acceptance

Verification SHALL cover selection, ready dependency reuse, meaningful refusal and preservation of shared resources with lightweight tests. Any live acceptance claim SHALL identify what was actually observed and use only separately approved user-requested resources.

#### Scenario: Build and start through MCP
- **WHEN** an approved installer-space Mocked build/start is exercised through OpenCode
- **THEN** receipts distinguish build outcome, dependency reuse and observed application readiness, with bounded logs and no manual Docker lifecycle workaround
