# Tasks

## 1. Planning

- [ ] 1.1 Extend `planKubernetesDeployment` with instance namespace/release/image tag/replicas and verify exact argv fixtures in `test/runtime-kubernetes.test.ts` for `user` (unchanged) and agent owners.
- [ ] 1.2 Add `replicasValuePath` to `devenv.k8s.json` discovery and verify parsing/default.
- [ ] 1.3 Plan port-forwards on allocated ports and verify argv.

## 2. Execution

- [ ] 2.1 Start: namespace create, image build+load, helm install with infra host-gateway values, wait, port-forwards; verify step tree via executor test doubles.
- [ ] 2.2 Removal: helm uninstall, namespace delete, image rmi best-effort; verify ordering and that rmi failure does not fail removal.
- [ ] 2.3 Explicit opt-in + `max_kubernetes` cap; `cluster-unavailable` when the cluster is absent; verify.

## 3. Checks

- [ ] 3.1 Extend the opt-in Kubernetes smoke test with two concurrent instances of one chart.
- [ ] 3.2 Document kind usage guidance (concurrency only) in `agentic-coding/docs/agent-environments.md`.
- [ ] 3.3 Run `bun run lint`, `bun run type-check` and focused tests with zero diagnostics.
