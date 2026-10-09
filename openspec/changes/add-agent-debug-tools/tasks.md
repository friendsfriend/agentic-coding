# Tasks

## 1. OTel wiring

- [ ] 1.1 Add a grant id per slot grant and the `AC_OTEL_*` variables per runtime, plus standard `OTEL_*` for script runs (definition values win); verify values for compose, script and Kubernetes consumers.
- [ ] 1.2 Add `telemetry.receiver.container_bind` with Linux auto-detection; verify the bind addresses never include `0.0.0.0`.
- [ ] 1.3 Index and query the trace store by `ac.owner`/`ac.run`; verify a previous holder's spans and spans without the attributes are excluded.

## 2. Tools

- [ ] 2.1 Add the `otel_query` route and tool with list and tree modes and bounds; verify.
- [ ] 2.2 Add `InfraService.query` parsing and `db_query` (read-only transaction, timeout, schema selection, caps, rollback, held-app precondition); verify statements through an injected SQL port and refusal when no held app requires the infra.
- [ ] 2.3 Add `http_request` restricted to held apps' endpoints, with the body cap and redaction; verify refusal for an app the workflow does not hold.
- [ ] 2.4 Add debug-tool guidance to `agent-definitions/instructions/workflow-agent-protocol.md`.

## 3. Checks

- [ ] 3.1 Opt-in smoke: a span exported by a script run appears in `otel_query`.
- [ ] 3.2 Run `bun run lint`, `bun run type-check` and the focused tests with zero diagnostics.
