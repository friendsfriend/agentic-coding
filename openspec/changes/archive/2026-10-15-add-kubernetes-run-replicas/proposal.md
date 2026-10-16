# Proposal

## Why

Some bugs only show with several replicas (locking, caching, scheduled jobs,
session affinity). kind can reproduce them, but agents can only start Docker or
script targets today: `make-app-runs-exclusive` never picks Kubernetes, and the
controller refuses it. kind is heavy, so it must stay opt-in and reserved for
concurrency checks.

## What Changes

- An explicit Kubernetes start: `runtime: "kubernetes"` or a Kubernetes target
  id, using the target's static release, namespace and port-forwards, under the
  same per-app slot as every other runtime.
- A `replicas` start option, applied as a Helm value (`replicaCount` by
  default, overridable via `replicasValuePath` in `devenv.k8s.json`).
- `cluster-unavailable` when the `devenv` cluster does not exist. Clusters are
  never created implicitly.
- Stopping uninstalls the release and stops its port-forwards.

## Capabilities

### New Capabilities

- `kubernetes-run-replicas`: explicit opt-in Kubernetes runs under the app slot,
  replicas, cluster precondition and stop.

## Impact

- `src/server/runtime/instances.ts` (remove the Kubernetes refusal for explicit
  requests), `src/server/runtime/kubernetes.ts` (replicas override),
  `src/server/actions/discovery.ts` (`replicasValuePath`).
- Tests: `test/runtime-kubernetes.test.ts` argv fixtures; opt-in
  `DEVENV_SMOKE_RUNTIME=kubernetes` smoke.
- Depends on `make-app-runs-exclusive`.
