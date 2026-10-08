# Proposal

## Why

Some bugs only show with several replicas (locking, caching, scheduled jobs,
session affinity). The kind runtime can reproduce them, but today a Kubernetes
run target deploys one fixed Helm release into one namespace of the shared
`devenv` cluster, so concurrent workflows collide. kind is heavy and must stay
opt-in.

## What Changes

- Agent-owned Kubernetes instances deploy into namespace `ac-<instanceId>` with
  release `<release>-<instanceId>` in the shared kind cluster; the image is
  built/tagged `<app>:<instanceId>` and loaded into kind per instance.
- Port-forwards bind allocated host ports (`AC_PORT_<NAME>`) per instance.
- Starts accept `replicas`, passed as a Helm value override (`replicaCount` by
  default, overridable via `devenv.k8s.json` `replicasValuePath`).
- Kubernetes targets start only when explicitly requested
  (`runtime: "kubernetes"` or a kubernetes target id) and count against
  `max_kubernetes`.
- Removal uninstalls the release, deletes the namespace, and removes the
  instance image from the kind node.
- Infra endpoints for in-cluster consumers resolve via `host-published`
  (host gateway), so shared infra stays outside the cluster.

## Capabilities

### New Capabilities

- `kubernetes-environment-instances`: per-instance namespace/release/image/
  port-forward for kind, explicit opt-in, replicas.

## Impact

- `src/server/runtime/kubernetes.ts` (`planKubernetesDeployment`,
  `helmImageOverrides`, `portForwardCommand`), `src/server/actions/discovery.ts`
  (`replicasValuePath`), instance variables.
- Tests: `test/runtime-kubernetes.test.ts` argv fixtures; opt-in
  `DEVENV_SMOKE_RUNTIME=kubernetes` smoke.
- Depends on `add-environment-instances`, `add-environment-instance-lifecycle`.
