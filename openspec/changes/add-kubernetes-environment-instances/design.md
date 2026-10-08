# Design

## Context

`KubernetesClusterService` and the pure argv planners in
`src/server/runtime/kubernetes.ts` already build kind/helm/kubectl commands;
the cluster defaults to `devenv` with context `kind-devenv`.

## Goals / Non-Goals

**Goals:** concurrent per-instance releases in one cluster; replicas; clean
removal.

**Non-Goals:** per-instance clusters, in-cluster infra, ingress controllers.

## Decisions

- **One shared cluster.** Creating a cluster per instance is far too heavy; a
  namespace per instance gives isolation for names and services.
- **Naming.** Namespace `ac-<instanceId>`; release `<release>-<instanceId>`
  truncated to 53 chars (Helm limit) with hash suffix. `user` keeps the
  configured namespace/release.
- **Image.** Reuse `resolveImageBuild`/`resolveImageReference` with tag
  `AC_IMAGE_TAG`; `kind load docker-image <app>:<instanceId>`; removal runs
  `docker exec <node> crictl rmi` best-effort (failure logged, not fatal).
- **Replicas.** `--set <replicasValuePath>=<n>`; absent → chart default.
- **Infra access.** In-cluster consumers get `AC_INFRA_<SVC>_HOST` =
  `host.docker.internal` (docker provider) / `host.containers.internal`
  (podman) and the published port; exported via Helm `--set-string env.*`
  through the existing secret/values plan, not in plain argv when secret.
- **Opt-in only.** Runtime choice from change 1 already excludes kubernetes;
  this change adds the explicit request path and the cap check.

## Risks / Trade-offs

- [Cluster missing] → start returns typed `cluster-unavailable` with the
  create action id; the agent does not create clusters implicitly.
- [Image load slow] → acceptable for the opt-in path; reported as a step in the
  run tree.
