# TUI client/server interface

Status: agreed design direction, not an implemented wire contract yet.

## One entrypoint

The native TUI will connect to `/api/client`, an authenticated WebSocket endpoint mounted exclusively by `src/server/client/index.ts`. The existing HTTP interface remains available for the unchanged web UI and existing callers. The client does not use Runtime, native storage or a patchwork of HTTP routes directly.

Use the same gateway for initial snapshots, commands, subscriptions and reconnect synchronization. Server handlers call native services rather than making HTTP requests back into the server or duplicating business logic.

## Contract requirements

The transport-neutral `src/protocol/` contract must define runtime-validated versioned envelopes, supported commands/subscriptions, payload bounds, response/error shapes, resource identity, revision and ordering semantics. Publish actual supported capabilities; never imply that a legacy UI action has a native implementation merely because its presenter was adapted.

Authentication is connection-bound. Preserve loopback host/origin fences; credentials must not appear in URLs, ordinary events, saved viewpoints or documentation examples. Specify how the native client acquires the connection credential before implementation.

Reconnect requires a fresh authoritative snapshot or an explicitly supported resume cursor. A disconnect after sending a mutation is an uncertain result, not permission to retry under a new identity. Specify idempotency/replay guarantees per command: transport request correlation alone does not make a mutation durable or idempotent.

Approval commands retain exact revision/digest and native ownership fences. Restoring a viewpoint can request current data but cannot execute a saved mutation or revive authority.

## Documentation to complete alongside implementation

- Handshake/version negotiation and authentication lifecycle.
- Request/response/event schemas and the command/subscription catalog.
- Snapshot consistency and event ordering/backpressure limits.
- Reconnect, cancellation, uncertain outcomes and retry rules.
- Validation, domain refusal and transport error categories.
- Capability changes and protocol compatibility policy.

No wire schema or delivery guarantee is claimed by this initial document; those will be recorded when implemented and functionally verified.
