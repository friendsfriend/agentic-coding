## Context

Depends on `port-action-execution-to-bun`. Bun now owns action definitions, run state, process/script execution and environment persistence. Container/Kubernetes work still crosses private Go runtime adapters. Existing devenv cross-runtime fixtures are the starting compatibility oracle.

## Goals / Non-Goals

**Goals:** Bun-owned container/cluster capabilities with complete route/action parity and no remaining production Go calls.

**Non-Goals:** New runtime providers, broader cleanup policies, replacing container daemons or merging resource and workflow identities.

## Decisions

1. Port Docker/Podman inspection, start/stop/restart, build/image/compose and logs/stats/events first. Preserve runtime detection, health normalization, event reconnect and container naming. Prefer native protocol/library support already available; use tool argv adapters only where behavior is equivalent. Do not replace structured API access with unbounded shell scripts merely to reduce code.
2. Port Kubernetes cluster discovery/create/recreate/delete, images, kubeconfig, secrets, Helm deployment/readiness, status watches/logs and cleanup. Preserve provider/profile/runtime IDs, endpoint resolution across host/compose/Kubernetes and dependency lease lifecycle. Use existing cross-runtime fixtures, then disposable actual runtimes for acceptance.
3. Every runtime handler plugs into the existing Bun action engine. Startup returns success only after readiness, and already-running never fabricates a command. Reconciliation and process/resource adoption preserve canonical identity; unavailable observation is not confirmed absence. Keep command/SDK distinction and snapshot provenance intact.
4. Pollers/watchers are server-owned cancellable scopes. Stop subscriptions and backoff timers on shutdown and reconnect without duplicated listeners. Runtime logs remain command/resource streams, not repurposed OTEL spans; shared UI can display both while retention stays domain-specific.
5. Preserve prune/cleanup policy exactly, including age filters and protected resources. Do not broaden startup pruning or introduce automatic destructive cleanup during tests. Destructive integration fixtures require isolated namespaces/projects and explicit owned-resource markers.
6. Finish the baseline inventory, including infrastructure profiles, endpoint generators, system utilities and miscellaneous routes not covered by named groups. Reassign any remaining production Go owner to a concrete Bun implementation before completion; removing UI affordances is not a valid way to close inventory rows.

## Risks / Trade-offs

- SDK/tool semantic differences → record chosen adapter per capability and test auth/TLS/errors/output/readiness before cutover.
- Fixture-only testing misses real runtime quirks → disposable Docker/Podman/Kubernetes smoke tests and explicit unavailable-runtime skips, never false success.
- Duplicate background reconciler changes live state → disable old Go poller before enabling Bun owner and verify one subscription/lease authority.
- Cleanup deletes user resources → ownership/age/label checks and negative protection tests.

## Migration Plan

Port and switch each runtime family at a quiescent action boundary; remove its private Go adapter only after parity. Run cross-runtime endpoint, readiness, logs, restart/adoption and cancellation acceptance. At completion the Go process can be disabled without losing any production route/action; deleting build/source is reserved for final change. Rollback returns ownership only after Bun actions settle and never issues duplicate create/start operations.

## Open Questions

Runtime SDK dependencies are chosen per concrete parity spike during implementation. New dependencies require demonstrated need; no up-front generic container abstraction is required.
