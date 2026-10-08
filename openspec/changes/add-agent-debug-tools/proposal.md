# Proposal

## Why

Logs alone rarely explain a failing request. Agents need the app's traces, the
data it wrote, and direct API calls against their own instance. The shell
already runs an OTLP receiver and trace store, but apps launched through the
environment do not export to it (open TODO), and nothing ties a span to an
instance.

## What Changes

- **OTel wiring per instance:** variables `AC_OTEL_ENDPOINT`,
  `AC_OTEL_PROTOCOL`, `AC_OTEL_SERVICE_NAME`, `AC_OTEL_RESOURCE_ATTRIBUTES`
  (`ac.instance`, `ac.owner`, `ac.app`) resolved per runtime (container → host
  gateway, script → loopback). Script instances also receive the standard
  `OTEL_EXPORTER_OTLP_ENDPOINT`/`OTEL_SERVICE_NAME`/`OTEL_RESOURCE_ATTRIBUTES`
  unless the definition sets them; compose/Helm definitions reference the
  `AC_OTEL_*` variables explicitly (added by `env-setup`).
- `otel_query({app?, since?, status?, name?, traceId?, limit?})` — trace
  summaries or one bounded span tree for the owner's instances.
- `db_query({app, infra, sql, limit?})` — read-only transaction against the
  instance schema with row/time caps.
- `http_request({app, endpoint, method, path, headers?, body?})` — call an
  owner's instance endpoint with bounded, redacted response.

## Capabilities

### New Capabilities

- `agent-debug-tools`: per-instance OTel wiring and the `otel_query`,
  `db_query`, `http_request` tool contracts.

## Impact

- Instance variables (`src/server/environment/instances/variables.ts`),
  telemetry receiver bind options, `src/tui/otel/model/traceStore.ts` query by
  resource attribute, new agent routes, `src/agent-host/debug-tools.ts`.
- Depends on `add-instance-infra-isolation`, `add-agent-environment-tools`.
