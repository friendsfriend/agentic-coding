## Why

The MCP exposes v2 definitions but not v1's environment behavior. Trying installer-space-mw with Mocked revealed that an already-running shared PostgreSQL service becomes a startup conflict instead of a reusable prerequisite; the user explicitly selected v1 as the behavioral reference. The user additionally requires a fresh standalone package, copying the necessary functionality into a new server rather than depending on either coding harness.

## What Changes

- Build `environment-mcp/` as an independently installable/buildable/testable Bun/TypeScript MCP server with its own dependency lock, configuration contract and entrypoint. No source, package, agent-host or runtime dependency on v1/v2 is permitted.
- Copy/adapt only required v1/v2 functionality with recorded provenance and package-local tests; replace harness-shaped contracts with environment-native boundaries. Keep compatibility readers separate from the new versioned server configuration.
- Establish v1's application/target/profile selection, dependency readiness, shared/external/owned lifecycles, acquisition and bounded diagnostic behavior as the MCP parity reference, rather than treating v2 adapter delegation as parity.
- Add controller-managed observation/use of configured existing shared or external prerequisites without granting cleanup ownership. Preserve exact human approval, authenticated scope binding and no automatic replay of uncertain mutations.
- Resolve dependency identity, network reachability and readiness inside the controller, not through agent-authored Docker commands or manual port-conflict workarounds.
- Capture a source-backed parity matrix, reuse existing environment services/domain rules where possible, and verify one representative build/start/log/stop flow.
- Keep restart recovery conservative: fresh observation of a configured shared dependency is not import/adoption of saved cleanup authority.

## Capabilities

### New Capabilities

- `mcp-v1-environment-parity`: V1-compatible environment selection and shared/external dependency reuse through portable MCP tools with explicit ownership boundaries.

### Modified Capabilities

None. Owned-resource cleanup, exact-plan approvals and authenticated MCP transport requirements remain unchanged; borrowed dependency observations confer no process handles or cleanup authority.

## Impact

New `environment-mcp/` package, fresh MCP/controller orchestration, dependency configuration and runtime readiness/network adapters; v1 environment source is the reference. Existing global OpenCode catalog and installer-space scoped connection must remain usable until explicit verified cutover. No deletion of old implementations/concurrent user work. No change to coding-agent orchestration, transcript UI or approval authority. Existing databases/containers must not be stopped, recreated, reconfigured or network-attached as an unreviewed migration side effect. Live validation is limited to the user-requested installer-space Mocked scenario after exact plan approval; no unrelated infrastructure may be changed.
