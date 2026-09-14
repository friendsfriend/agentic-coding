## Context

Depends on `unify-application-lifecycle-and-binary`. The unified frontend is already usable; this change begins backend migration. Workflow application/observation and telemetry modules are root-owned but local, while environment routes run in Go. Existing workflow contracts require capabilities, revisions, pinned definitions and scoped Effect execution.

## Goals / Non-Goals

**Goals:** One authenticated public API and Bun server process for workflow/telemetry, typed frontend client, bounded events/prompts and private Go delegation.

**Non-Goals:** Porting Go services, replacing workflow engine/Effect, merging databases or inventing a message broker.

## Decisions

1. Add `src/server/` as Bun composition/transport root. The same executable runs TUI or server; default TUI spawns/owns server. Bun server owns workflow application scopes, repository coordinators, observations, telemetry receivers/watchers/retention and private Go child. TUI views receive typed data/actions and perform no filesystem/Git/Herdr/database I/O. Local terminal launching/clipboard remain explicit frontend capabilities, not server operations.
2. Retain HTTP/SSE, route existing environment APIs through private Go delegation, and add versioned workflow/read/artifact/config endpoints around current application operations. Freeze request/response/error fixtures before switching callers. Reads remain observational: no initialization, migration or drain merely to render a view. Static route ownership replaces a generic plugin/router framework.
3. Bind public API to loopback by default with per-instance authorization, bounded bodies and explicit method/origin checks; remove wildcard CORS from delegated exposure. Private Go listener also requires instance authorization. Remote attach uses an explicit protected transport/configuration, not automatic unrestricted binding. Never log tokens or expose them in URLs.
4. Preserve agent authentication: CLI resolves managed process ancestry and scoped run capability at the existing local boundary, then sends capability-authenticated commands; backend independently validates run identity, revision and permission. Developer API sessions and agent run tokens are distinct authorities. Same binary can service supported headless CLI commands through a bounded server invocation when no owner runs; preserve environment provenance and prevent competing schema migration. Exact offline operational semantics must be covered by CLI fixtures.
5. Route ephemeral credential requests as scoped interactions tied to an operation and controlling client; allow only that client's authenticated response, cancel/expire on disconnect and never persist secret values or include them in broadcast events. Persisted developer questions continue to use existing workflow question/revision protocol, not transient modal state. Multiple clients cannot claim the same prompt response.
6. Common event envelope includes instance ID, domain, resource/run identity, event sequence and domain revision where available. Bounded ring/replay windows may resynchronize via snapshots when cursor is unavailable. Slow clients cannot block mutation execution; output is persisted before emission and recovered through cursor/range reads. Do not apply telemetry retention or generic retry rules to workflow outbox records. Recover gaps explicitly rather than silently dropping events.
7. Run backend independently of synchronous TUI external-tool execution. Remove `__dashboard-observe` subprocess protocol after API consumers migrate. Native/Promise I/O stays in boundary adapters; registered step behavior stays pure and existing Effect 3.22.2 scope/failure conventions remain.

## Risks / Trade-offs

- HTTP boundary weakens process-local trust → adversarial capability, stale-revision, path-boundary and origin tests before cutover.
- Network error after mutation encourages duplicate execution → preserve command identities and reconciliation; never transparently replay unclassified POST failures.
- Credential disconnect leaks suspended work → bounded timeout and owned abort tests.
- Shared event stream floods clients → separate domain subscriptions/filters, bounded buffers and snapshot recovery; do not stream all raw telemetry by default.

## Migration Plan

Define contracts/authentication and route ownership; move root services; switch one read path, then mutations/prompts, then telemetry; migrate CLI/attach semantics; enforce no-backend-I/O view boundaries. Keep private Go routes stable for later ports. Rollback only at a quiescent boundary with one application owner; schemas/pins are unchanged by transport extraction. Update the older in-process architecture specification explicitly rather than leaving contradictory targets.

## Open Questions

No product choices block this change. Protocol limits and replay windows are implementation constants verified by tests, not new user-facing tuning infrastructure.
