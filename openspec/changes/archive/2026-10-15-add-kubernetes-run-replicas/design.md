# Design

## Context

`planKubernetesDeployment`, `helmImageOverrides` and `portForwardCommand` in
`src/server/runtime/kubernetes.ts` already produce the kind/helm/kubectl argv.
The cluster defaults to `devenv` with context `kind-devenv`.

## Goals / Non-Goals

**Goals:** let an agent run an app with N replicas when a bug needs
concurrency.

**Non-Goals:** per-workflow namespaces, cluster creation, in-cluster infra.

## Decisions

- **Same slot.** A Kubernetes run of `customer-mw` holds the `customer-mw`
  slot like a compose run. Static release, namespace and port-forward ports
  keep routing unchanged.
- **Replicas.** `--set <replicasValuePath>=<n>`. Without `replicas`, the chart
  default applies.
- **Infra access** follows the target's existing values. No new mechanism.
- **Guidance.** Agent instructions say to use kind only when the problem
  depends on more than one replica.

## Risks / Trade-offs

- [Image build and kind load are slow] → acceptable on the opt-in path, and
  shown as a step in the run tree.
