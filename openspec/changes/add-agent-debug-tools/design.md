# Design

## Context

The server hosts OTLP HTTP and gRPC receivers bound to `127.0.0.1`, feeding the
trace store. Apps run once at a time; each grant of an app slot is a distinct
run with a fresh grant id. Infra definitions have no connection metadata today.

## Goals / Non-Goals

**Goals:** attribute every span to a workflow run; bounded, safe read access to
traces, data and APIs.

**Non-Goals:** metrics/log ingestion over OTLP, database writes, non-SQL stores,
per-run data isolation (data stays shared as decided).

## Decisions

- **Attribution by grant id.** `ac.run` changes with every grant, so spans
  from a previous holder of the same app are excluded even though host and
  port are identical. The trace store indexes `ac.owner` and `ac.run`.
- **Container reachability.** Docker Desktop and Podman machine forward
  `host.docker.internal`/`host.containers.internal` to host loopback. On Linux
  engines the receiver must also bind the container bridge gateway: add
  `telemetry.receiver.container_bind` (default auto: bind the gateway IP only
  when a Linux engine is detected). The receiver never binds `0.0.0.0`.
- **otel_query output.** Without `traceId`: up to `limit` (default 20) rows
  `{traceId, root, durationMs, status, errorCount, startedAt, app}`. With
  `traceId`: a span tree with name, duration, status, key attributes (`http.*`,
  `db.statement` truncated to 500 chars) and exception events, bounded to
  `MAX_OUTPUT_CHARS`.
- **db_query.** An infra definition declares `query: {kind: "postgres" |
  "mysql", host, port, database, userEnv, passwordEnv}`; the credentials come
  from the config `.env` and never appear in output. It runs through
  `Bun.sql`:
  - Postgres: `BEGIN READ ONLY; SET LOCAL statement_timeout = '10s'` and an
    optional `SET LOCAL search_path = <schema>`.
  - MySQL: `START TRANSACTION READ ONLY`, `max_execution_time`, optional
    `USE`.
  - Always rolled back.
  - Rows: default 50, max 200; values truncated to 2 KB.
  - Allowed only while the workflow holds an app whose target requires that
    infra.
- **http_request.** The target is restricted to static endpoints of apps the
  workflow holds (agents have bash for anything else). The response body is
  capped at 64 KB. `set-cookie` and `authorization` values are redacted, and
  the shared redactor also applies.

## Risks / Trade-offs

- [Binding the receiver to the bridge exposes it to containers] → local bridge
  network only; documented. The receivers already validate payloads.
- [Shared data across branches makes query results confusing] → accepted;
  `db_query` output names the current schema and database.
