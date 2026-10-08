# Tasks

## 1. OTel wiring

- [ ] 1.1 Add `AC_OTEL_*` variables per runtime and standard `OTEL_*` for script instances (definition values win); verify values for compose, script and Kubernetes consumers.
- [ ] 1.2 Add `telemetry.receiver.container_bind` with Linux auto-detection; verify bind addresses never include `0.0.0.0`.
- [ ] 1.3 Index and query the trace store by `ac.instance`; verify filtering and that spans without the attribute are excluded.

## 2. Tools

- [ ] 2.1 Add `otel_query` route + tool with list and tree modes and bounds; verify.
- [ ] 2.2 Add `db_query` with read-only transaction, timeout, search_path/USE, caps, rollback; verify statements through an injected SQL port and refusal for non-isolated infra and `user` instances.
- [ ] 2.3 Add `http_request` restricted to owner endpoints with body cap and redaction; verify refusal of non-instance hosts.
- [ ] 2.4 Add debug-tool guidance to `agent-definitions/instructions/workflow-agent-protocol.md`.

## 3. Checks

- [ ] 3.1 Opt-in smoke: a script instance exporting a span appears in `otel_query`.
- [ ] 3.2 Run `bun run lint`, `bun run type-check` and focused tests with zero diagnostics.
