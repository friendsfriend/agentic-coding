## 1. Parity and adapters

- [ ] 1.1 Confirm port-action-execution-to-bun is implemented and inventory remaining Go runtime/routes/pollers.
- [ ] 1.2 Port existing cross-runtime endpoint/readiness/protection fixtures into Bun tests.
- [ ] 1.3 Select concrete API/library/tool adapters per capability with recorded parity rationale and dependency review.

## 2. Containers

- [ ] 2.1 Port Docker/Podman discovery/inspection/status normalization and credential/TLS/error behavior.
- [ ] 2.2 Port start/stop/restart and readiness through Bun action handlers with already-running tests.
- [ ] 2.3 Port image/build operations and exact SDK-versus-command history accounting.
- [ ] 2.4 Port compose configuration, lifecycle and readiness behavior.
- [ ] 2.5 Port logs/stats/events and bounded reconnect/cancellation behavior.
- [ ] 2.6 Port prune/retention with unchanged age/protection policy and negative unowned-resource tests.

## 3. Kubernetes and infrastructure

- [ ] 3.1 Port cluster/provider/profile validation and discovery/status.
- [ ] 3.2 Port cluster create/recreate/delete and kubeconfig export with owned-resource protections.
- [ ] 3.3 Port image build/load and cross-runtime endpoint resolution.
- [ ] 3.4 Port secret preparation/handling with redaction and no secret persistence.
- [ ] 3.5 Port Helm/infrastructure deployment and configured readiness/failure cleanup.
- [ ] 3.6 Port status watches/logs/pollers and shutdown during reconnect/backoff.
- [ ] 3.7 Port dependency lease adoption/release and cluster/runtime cleanup semantics.

## 4. Cutover and remaining inventory

- [ ] 4.1 Disable each old Go poller/adapter before enabling its Bun owner; test no duplicate listeners or resource starts.
- [ ] 4.2 Exercise disposable Docker/Podman/compose smoke fixtures and record missing-runtime skips separately.
- [ ] 4.3 Exercise disposable Kubernetes/Helm and cross-runtime smoke fixtures without touching user resources.
- [ ] 4.4 Close remaining infrastructure/profile/system/miscellaneous inventory rows with concrete Bun implementations and tests.
- [ ] 4.5 Run application with Go backend disabled and assert every production route/action remains implemented.
- [ ] 4.6 Run combined verification and full environment TUI journeys; document quiescent rollback and mark Go production owners zero.
