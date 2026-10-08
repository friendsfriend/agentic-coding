# Design

## Context

The server hosts OTLP HTTP and gRPC receivers bound to `127.0.0.1` feeding the
trace store. Instance schemas and infra admin connection data come from change 2.

## Goals / Non-Goals

**Goals:** attribute every span to an instance; bounded, safe read access to
traces, data and APIs.

**Non-Goals:** metrics/log ingestion via OTLP, writes to databases, non-SQL
stores.

## Decisions

- **Container reachability.** Docker Desktop/Podman machine forward
  `host.docker.internal`/`host.containers.internal` to host loopback. On Linux
  engines the receiver must also bind the container bridge gateway; add
  `telemetry.receiver.container_bind` (default auto: bind gateway IP only when
  a Linux engine is detected). The bound address is never `0.0.0.0`.
- **Attribution.** Resource attribute `ac.instance` is the join key; the trace
  store gets an index on it. Spans without it are invisible to agent queries.
- **otel_query output.** Without `traceId`: up to `limit` (default 20) trace
  rows `{traceId, root, durationMs, status, errorCount, startedAt}`. With
  `traceId`: span tree with name, duration, status, key attributes (http.*,
  db.statement truncated to 500 chars) and exception events; bounded to
  `MAX_OUTPUT_CHARS`.
- **db_query.** `Bun.sql`; Postgres `BEGIN READ ONLY; SET LOCAL
  statement_timeout = '10s'; SET LOCAL search_path = <schema>`; MySQL `START
  TRANSACTION READ ONLY` + `USE <db>` + `max_execution_time`. Rollback always.
  Rows default 50, max 200; values truncated to 2 KB. Only infra declaring
  `isolation` is queryable; the `user` instance is not queryable by agents.
- **http_request.** Target restricted to the owner's instance endpoints (agent
  has bash for anything else); response body 64 KB cap; `set-cookie`,
  `authorization` values redacted plus the shared redactor.

## Risks / Trade-offs

- [Binding the receiver to the bridge exposes it to containers] → only local
  bridge network; documented; receivers already validate payloads.
- [Read-only transaction bypass via functions with side effects] → accepted for
  a local dev database; statement timeout bounds damage.
