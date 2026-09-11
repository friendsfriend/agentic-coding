## Why

Container and Kubernetes integrations are the final high-risk runtime owners. They must migrate after the Bun action engine can preserve readiness, dependency and command-history semantics.

## What Changes

- Port Docker/Podman lifecycle, build/compose, logs/stats/events and retention behavior.
- Port Kubernetes/Helm cluster, image, secret, health/watch, log and cleanup capabilities.
- Preserve cross-runtime endpoint resolution, dependency leases and explicit already-running/readiness outcomes.
- Preserve remaining infrastructure and runtime-profile behavior from the imported route/action inventory.
- Remove private Go runtime adapters as each capability passes parity; all production routes must be Bun-owned before this change completes.

## Capabilities

### New Capabilities

- `bun-environment-runtime-adapters`: Feature-compatible Bun container and Kubernetes operations.

### Modified Capabilities

None; existing action definition and project identity contracts remain unchanged.

## Impact

Depends on `port-action-execution-to-bun`. Ports imported docker, kubernetes, build, operations and services runtime code. Uses disposable runtime fixtures and backend contract tests. Does not broaden destructive prune/cleanup policies or add new cluster providers.
