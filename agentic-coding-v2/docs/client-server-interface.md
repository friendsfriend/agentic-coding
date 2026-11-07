# TUI client/server interface

Status: version 1 gateway and initial native client implemented. This is a supported subset, not full legacy UI parity. The preceding server split (`e3df0a8`) documented a planned interface; the contracts below describe the subsequent implementation.

## One entrypoint and credentials

The native TUI uses only the authenticated WebSocket `/api/client`, mounted by `src/server/client/index.ts`. Existing HTTP routes/web assets remain unchanged. The client imports protocol types, not Runtime or native storage. Handlers delegate directly to native services.

The CLI starts the native host in both modes. In TUI mode it passes `host.client = {url, token}` directly, in-process, to the native connection. The URL is loopback without credentials, query or fragment; the token goes only in the upgrade's Bearer header. It is never rendered, subscribed, put in viewpoints or persisted. Host/origin/authentication fences are shared with HTTP. Native connection credentials rotate on host restart; the client does not discover a replacement token or transfer authority automatically. The old token-fragment **web** URL remains for compatibility and is printed only in headless mode.

## Envelopes

`src/protocol/index.ts` defines the wire types; `frames.ts` validates server envelopes, snapshot structure and method results before they become client state. JSON request shape:

```json
{"version":1,"id":"correlation-identity","method":"state.read","input":{}}
```

Request envelope keys are allow-listed. Version is exact, request IDs are bounded alphanumeric/colon/underscore/hyphen strings (128 characters), and methods must be in the published catalog. Feature inputs are checked at the handler/native admission boundary, not merely trusted because TypeScript compiled.

Server frames all carry `version:1`:

- `hello`: connection identity and supported `methods`.
- `response`: request `id` and method `value`.
- `error`: nullable request `id`, `code` (`invalid-request`, `refused`, `unavailable`) and sanitized `message`.
- `state`: connection-local increasing `sequence` and complete inventory `value`.

These are JSON frames, not executable UI descriptors. The client rejects incompatible/malformed server frames, invalid method acknowledgements and non-increasing subscription sequences. The native host/client are paired in one installed release; an incompatible method catalog requires updating them together.

## Implemented commands

| Method | Contract |
| --- | --- |
| `state.read` | Empty input; authoritative derived inventory: tasks, reviews, schedules, profiles, topics, repositories, environments and native session catalog. |
| `state.subscribe` | Empty input; acknowledges subscription. One-second complete inventory refreshes while connected. |
| `session.read` | Native numeric session ID; newest 200 entries in chronological order, model/thinking and reported usage in that returned history window. Truncation is explicit; usage is not a lifetime total. |
| `session.send` | Session ID, bounded content and caller submission identity; returns native submission ID. |
| `session.abort` | Session ID; native abort request acknowledgement, not a guarantee that all owned work has already stopped. |
| `session.compact` | Session ID and optional bounded instructions; returns native compaction task ID. No automatic model call occurs merely from reading a session. |
| `session.configure` | Session ID and existing configured profile ID; changes model/thinking through the native conversation API, without replacing its tools/ownership. |
| `task.cancel` | Native app-task ID; delegates cancellation and owned-resource release. |
| `review.decide` | Review ID, exact revision, decision and comments; native review/approval fences remain authoritative. |
| `schedule.delete` | Schedule ID and exact revision; deletes future timing transactionally and permanently retires the request identity, preventing delete/recreate ABA against stale revisions. Does not cancel an already admitted occurrence task. Schedule create/update remains orchestrator-only; recreation needs a new ID. |
| `environment.action` | Typed native operator selection (`apps`, action, request identity, optional target/profile/runtime/replicas/workspace/base); admits an operator environment task and preserves its human review. No client-side readiness or ownership grant. |
| `environment.logs` | Configured app ID; native diagnostic logs, not lease takeover. |
| `providers.read` | Empty input; native provider namespace inventory. No external provider operation. |

The home session is available. App-owned skill conversations are discoverable from their execution checkpoint; new skill tasks retain their native conversation ID in catalog metadata so completed transcripts remain readable. Terminal children are not writable. Older already-terminal tasks without retained IDs are not migrated or guessed. Arbitrary harness conversation IDs are not a client navigation capability. Native ownership admission, not a saved sidebar/viewpoint, governs new owned work.

## Ordering, limits and consistency

- At most eight active native-client connections and sixteen in-flight requests per connection.
- Requests run sequentially within a connection. There is no cross-connection command order.
- Frames are bounded to 1,000,000 bytes. Oversized frames/backpressure close with code 1009; excess connection capacity closes with 1013. Complete inventories are not silently truncated to fit. A large retained catalog can therefore make this initial snapshot interface unavailable; pagination is not implemented yet.
- Inventory polling is shared, non-overlapping, and runs only while there are native clients. It is not a durable subscription log.
- Inventory is assembled from native projections/services, **not one atomic whole-system transaction**. Sequence orders publication on one connection, not native commits globally. UI mutations must still provide current identities/revisions.
- There is no replay cursor or partial-resume guarantee. Reconnect obtains a fresh inventory and subscribes anew. Last displayed inventory may remain cached while disconnected, but client commands are unavailable until reconnection.

## Uncertainty, retries and lifecycle

Transport correlation IDs are not durable idempotency keys. Duplicate in-flight IDs are refused; they are not retained as a durable replay ledger. The client never automatically replays a command. A socket loss/send failure or 15-second response timeout rejects pending requests as `CommandUncertain`: the mutation may already have committed. A timeout does not cancel server work.

Native session submission identities deduplicate according to pi-durable's submission contract. That upstream contract does **not** compare changed message bytes when an existing input identity is reused; callers must not reuse an identity with different content. Environment admission retains its existing content-bound durable request identity. Review and schedule writes retain exact revision fences. Abort, configure, compact and cancellation do not gain additional replay guarantees from this transport.

Reconnect uses bounded exponential delay (1–30 seconds); explicit `/reconnect` requests the same synchronization path. New requests get new correlation IDs, but no old mutation is reissued. The functional disconnect test holds a native mutation in flight, reconnects the same client, observes its uncertain outcome and proves that only one native mutation occurred. The deletion scenario also reopens persistent native storage and proves that the retired schedule ID cannot be recreated.

Closing a connection discards queued work that has not started. Already-running work may finish. Host shutdown stops polling, closes clients and waits for running request chains before stopping the listener/runtime. TUI renderer/client/signal handlers are cleaned up on exit; no legacy window launcher is involved.

## Not yet claimed

Full selected transcript/tool presentation, all environment diagnostics/actions, external OpenCode/Pi adapters, complete native descendant trees, evidence viewers, wiki storage/comment-skill bindings and writable configuration editing are not completed by this increment. Capabilities are published only for implemented native methods. Viewpoints are memory-only, data-only client navigation; durable draft retention is not implemented.
