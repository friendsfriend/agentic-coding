# Tasks

## 1. Planning

- [x] 1.1 Add `replicasValuePath` to `devenv.k8s.json` discovery and verify parsing and the default.
- [x] 1.2 Add the replicas override to `planKubernetesDeployment` and verify exact argv fixtures with and without `replicas` in `test/runtime-kubernetes.test.ts`.

## 2. Execution

- [x] 2.1 Allow explicit Kubernetes starts in the slot controller (still never implicit); verify implicit selection still picks Docker.
- [x] 2.2 Return `cluster-unavailable` when the cluster is absent; verify no cluster create is issued.
- [x] 2.3 On stop, uninstall the release and stop the port-forwards; verify ordering.

## 3. Checks

- [x] 3.1 Extend the opt-in Kubernetes smoke test with a two-replica start.
- [x] 3.2 Document kind usage (concurrency only) in `agentic-coding/docs/agent-environments.md`.
- [x] 3.3 Run `bun run lint`, `bun run type-check` and the focused tests with zero diagnostics.
