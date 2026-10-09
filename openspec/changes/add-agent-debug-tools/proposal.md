# Proposal

## Why

Logs alone rarely explain a failing request. Agents need the app's traces, the
data it wrote, and direct API calls against the app they hold. The shell already
runs an OTLP receiver and trace store, but apps launched through the
environment do not export to it (open TODO), and nothing ties a span to the
workflow run that produced it. Since an app runs once at a time with static
routing, attribution must come from the run, not from distinct hosts or ports.

## What Changes

- **OTel wiring per app run:** variables `AC_OTEL_ENDPOINT`, `AC_OTEL_PROTOCOL`,
  `AC_OTEL_SERVICE_NAME` and `AC_OTEL_RESOURCE_ATTRIBUTES` (`ac.app`,
  `ac.owner`, `ac.run` = slot grant id), resolved per runtime (container → host
  gateway, script → loopback). Script runs also receive the standard
  `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME` and
  `OTEL_RESOURCE_ATTRIBUTES` unless the definition sets them. Compose and Helm
  definitions reference the `AC_OTEL_*` variables explicitly (added by
  `env-setup`).
- `otel_query({app?, since?, status?, name?, traceId?, limit?})` returns trace
  summaries or one bounded span tree, limited to runs of the calling workflow.
- `db_query({infra, sql, schema?, limit?})` runs a read-only transaction
  against an infra database that declares a `query` connection, allowed only
  while the workflow holds an app that requires that infra.
- `http_request({app, endpoint, method, path, headers?, body?})` calls the
  static endpoint of an app the workflow holds and returns a bounded, redacted
  response.

## Capabilities

### New Capabilities

- `agent-debug-tools`: per-run OTel wiring and attribution, and the
  `otel_query`, `db_query` and `http_request` tool contracts.

## Impact

- Slot run variables (`src/server/environment/instances/variables.ts`),
  `InfraService.query` in `src/server/environment/config.ts`, telemetry receiver
  bind options, `src/tui/otel/model/traceStore.ts` (query by resource
  attribute), new agent routes, `src/agent-host/debug-tools.ts`.
- Depends on `make-app-runs-exclusive` and `add-agent-environment-tools`.
