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
- `session`: selected `watchId`, increasing `sequence` and complete native transcript/progress projection.
- `session-unavailable`: selected `watchId`, increasing `sequence` and sanitized observation failure. This does not imply that native work stopped.

Inventory and session publications share the connection-local sequence. Old selection publications cannot replace the current selection.

These are JSON frames, not executable UI descriptors. The client rejects incompatible/malformed server frames, invalid method acknowledgements and non-increasing subscription sequences. The native host/client are paired in one installed release; an incompatible method catalog requires updating them together.

## Implemented commands

| Method | Contract |
| --- | --- |
| `state.read` | Empty input; authoritative derived inventory: tasks, reviews, schedules, profiles, topics, repositories, environments and native session catalog. |
| `state.subscribe` | Empty input; acknowledges subscription. One-second complete inventory refreshes while connected. |
| `session.read` | Native numeric session ID; newest 200 entries in chronological order, model/thinking and reported usage in that returned history window, plus native live/inbox evidence. Truncation is explicit; usage is not a lifetime total. |
| `session.watch` | Connection-only read-only observation control: bounded `watchId` and native numeric session ID, or `id:null` to stop. Replaces the socket's previous watch; publishes complete transcript/progress projections. Same session-catalog fence as reads, never arbitrary conversation adoption. |
| `session.send` | Session ID, bounded content and caller submission identity; returns native submission ID. |
| `session.abort` | Session ID; native abort request acknowledgement, not a guarantee that all owned work has already stopped. |
| `session.compact` | Session ID and optional bounded instructions; returns native compaction task ID. No automatic model call occurs merely from reading a session. |
| `session.configure` | Session ID and existing configured profile ID; changes model/thinking through the native conversation API, without replacing its tools/ownership. |
| `task.read` | Catalog-owned numeric task ID; retained metadata, native status/abort-request/terminal outcome, owner-scoped immutable reviews and retained image metadata. No arbitrary native task/checkpoint or filesystem reads. Projection is non-atomic; metadata is not image-pixel proof. |
| `task.cancel` | Native app-task ID; delegates cancellation and owned-resource release. |
| `review.decide` | Review ID, exact revision, decision and comments; native review/approval fences remain authoritative. |
| `schedule.delete` | Schedule ID and exact revision; deletes future timing transactionally and permanently retires the request identity, preventing delete/recreate ABA against stale revisions. Does not cancel an already admitted occurrence task. Schedule create/update remains orchestrator-only; recreation needs a new ID. |
| `environment.action` | Typed native operator selection (`apps`, action, request identity, optional target/profile/runtime/replicas/workspace/base); admits an operator environment task and preserves its human review. No client-side readiness or ownership grant. |
| `environment.logs` | Configured app ID; native diagnostic logs, not lease takeover. |
| `settings.read` | Fixed native CONFIG_DIR/config.json; bounded editable profiles/default/repositories/provider definitions, file-byte revision, restart-required marker. Missing fields use current runtime definitions. Unknown existing fields and credential values are not projected. |
| `settings.preview` | Exact base revision + complete editable settings object. Strict known fields, static profile/default/path/provider validation, HTTPS except loopback, environment-variable token references only. Returns bounded 10-minute immutable snapshot/digest/ID; no file write. At most 16 in-memory candidates. |
| `settings.apply` | Ephemeral candidate ID + literal `approve:DIGEST`. Exact unexpired confirmation and current byte revision required; fixed file only, cooperative exclusive lock and private atomic replacement. Running host is unchanged; separately authorized restart required. No replay/idempotency claim. |
| `providers.inspect` | Explicit read-only allow-list: repository search/branches/labels/collaborators; changes/issues (list/detail); change files/versions/discussions; jobs (GitHub requires run ID). Exact operation fields, bounded repository/query text, positive numeric IDs; native named provider and token/HTTPS fences retained. No arbitrary route, write, log redirect or automatic outbound call. |
| `providers.read` | Empty input; native provider namespace inventory. No external provider operation. |

The home session is available. App-owned skill conversations are discoverable from their execution checkpoint; new skill tasks retain their native conversation ID in catalog metadata so completed transcripts remain readable. Terminal children are not writable. Older already-terminal tasks without retained IDs are not migrated or guessed. Arbitrary harness conversation IDs are not a client navigation capability. Native ownership admission, not a saved sidebar/viewpoint, governs new owned work.

## Ordering, limits and consistency

- At most eight native-client connections, counting closing connections until their watch/setup cleanup completes, and sixteen in-flight requests per connection. One selected native session watch per socket.
- Requests run sequentially within a connection. There is no cross-connection command order.
- Frames are bounded to 1,000,000 bytes. Oversized frames/backpressure close with code 1009; excess connection capacity closes with 1013. Complete inventories are not silently truncated to fit. A large retained catalog can therefore make this initial snapshot interface unavailable; pagination is not implemented yet.
- Inventory polling is shared, non-overlapping, and runs only while there are native clients. It is not a durable subscription log.
- Transcript progress is event-driven through native `watchEvents`, not one-second polling. Commit batches and native overflow snapshots invalidate the complete projection; bursts coalesce for 100 ms with one read in flight. Registration precedes the initial projection so intervening commits schedule another read.
- Transcript history is read before live/inbox state. These reads are **non-atomic**: native terminal commits append the final assistant message and clear its partial together, so this order avoids final-plus-stale-partial duplication, but a crossing commit can temporarily omit content until the next projection. Usage still describes only the retained window.
- Inventory is assembled from native projections/services, **not one atomic whole-system transaction**. Sequence orders publication on one connection, not native commits globally. UI mutations must still provide current identities/revisions.
- There is no replay cursor or partial-resume guarantee. Reconnect obtains a fresh inventory and reattaches only the selected read-only watch. Retained transcript/inventory may remain cached, but partial progress is hidden as unknown while disconnected/resynchronizing, and commands are unavailable until reconnection. An unavailable observation is not native idle/completion evidence.

## Uncertainty, retries and lifecycle

Transport correlation IDs are not durable idempotency keys. Duplicate in-flight IDs are refused; they are not retained as a durable replay ledger. The client never automatically replays a command. A socket loss/send failure or 15-second response timeout rejects pending requests as `CommandUncertain`: the mutation may already have committed. A timeout does not cancel server work.

Native session submission identities deduplicate according to pi-durable's submission contract. That upstream contract does **not** compare changed message bytes when an existing input identity is reused; callers must not reuse an identity with different content. Environment admission retains its existing content-bound durable request identity. Review and schedule writes retain exact revision fences. Abort, configure, compact and cancellation do not gain additional replay guarantees from this transport.

Reconnect uses bounded exponential delay (1–30 seconds); explicit `/reconnect` requests the same synchronization path. New requests get new correlation IDs, but no old mutation is reissued. The functional disconnect test holds a native mutation in flight, reconnects the same client, observes its uncertain outcome and proves that only one native mutation occurred. The deletion scenario also reopens persistent native storage and proves that the retired schedule ID cannot be recreated.

Closing a connection discards queued work that has not started and retires its watch/timer. Already-running work may finish. Host shutdown stops polling, closes clients and waits for running request chains and watch/setup cleanup before stopping the listener/runtime. Stopping observation does not abort native work. TUI renderer/client/signal handlers are cleaned up on exit; no legacy window launcher is involved.

## Task and resource presentation

Task details refresh on selection, reconnect, relevant inventory changes or explicit `/refresh`; stale in-flight detail results cannot replace a newer selection. Disconnected detail is cached/unknown, not fresh activity. `/task ID` opens a catalog-owned task. Task/review headers prepare an **unsent** revision-fenced decision/cancellation command and refuse to replace an existing draft. Only explicit prompt submission invokes native mutation methods; saved expansion/selection cannot submit or grant approval.

Environment overviews show configured targets, observed runs/readiness/owners, idle/cleanup diagnostics and waiters. Run/build/test/log headers prepare commands only; no environment is probed, restarted or adopted by display. Schedule overview shows exact timing/invocation, admitted task, errors and retained history, with revision-fenced deletion preparation only. IDs that cannot be represented as one prompt token do not gain prepared action shortcuts. Full diagnostics/action controls remain incomplete.

## Provider inspection and diagnostic journals

`providers.read` now returns validated native provider summaries (name/type/configured origin/username/token presence only). The TUI registry refresh is selection/reconnect/manual-refresh driven and stale completions are fenced. Registry presence is not authentication or reachability proof.

`/provider NAME OPERATION ...` explicitly submits `providers.inspect`; `/help` lists supported arguments. Preparation only stages an unsent command with editable placeholders. Result identity is checked against the submitted provider/operation, then retained as cached UI data with local receipt time. Navigation/reconnect/viewpoint restore never repeats upstream reads. Returned URLs remain inert text. Unknown providers, missing tokens, invalid numeric IDs, unsupported operations and extra fields refuse through the existing sanitized gateway error boundary. Writes and signed job-log redirect reads are not exposed by this method.

Observability presents the existing native `httpOperations`, `queryOperations`, `waits` and `referenceGraphs` journals with filter/selection, scoped identities, exact diagnostic records and catalog-fenced owner links. These observations cannot restore execution, lease or rollback authority, and empty records do not prove inactivity. No remote logs/spans/database probes run by opening this view. Async command completion now preserves drafts edited while the request is pending.

## Writable settings lifecycle

The settings UI has an ephemeral JSON editor for the four editable native fields, rather than the previous unavailable/read-only placeholder. `/settings-preview` submits its edited JSON against the observed file revision; the UI displays the exact normalized snapshot and digest. `/settings-apply ID approve:DIGEST` requires a fresh displayed candidate and manually typed confirmation. Preparation inserts a digest **placeholder**, never approval. `/settings-reset` explicitly discards editor changes in favor of the observed document; `/refresh` reads current disk state without overwriting edited JSON.

Editor contents/documents/candidates are client memory only, never placed in viewpoint detail. Saving/restoring a settings-apply draft is refused. Edits, navigation (including same-page restore), refresh and disconnect discard client candidate confirmation. Reconnect cannot replay save or restore approval. Failed/uncertain apply must be followed by a file-revision read, not automatic retry.

Native save preserves unknown existing JSON field values privately; its approval digest covers the exact projected `{baseRevision, settings}` snapshot, binding the opaque old file via its byte digest, not displaying a potentially secret-bearing whole-file snapshot. Files are bounded to 256 KiB, reject symlink/hard-link/non-regular targets, and use private fsynced temporary replacement plus directory sync. The lock coordinates this API's writers; unrelated external writers do not honor it, so this is **not** a cross-process compare-and-swap guarantee. Revision is checked immediately before replacement. A lock retained after interruption is refused, never auto-stolen or deleted as stale. A failure after replacement may mean the file changed; refresh before a new confirmation.

No live configuration, session/model, repository authority, providers, lease or environment changes are applied by save. No model/provider/engine validation call or restart is performed. Saving profiles makes them explicit in the v2 file rather than continuing fallback inheritance. User skills, environment definitions, credentials/state and arbitrary files are not editable through this contract. Windows file editing is explicitly refused until its filesystem safety is verified. Invalid UTF-8 files also refuse rather than normalizing opaque values. Crash/racing-external-writer proof and richer field-specific settings controls remain unclaimed.

## Not yet claimed

Full selected transcript/tool presentation, all environment diagnostics/actions, external OpenCode/Pi adapters, complete native descendant trees, evidence viewers, wiki storage/comment-skill bindings and writable configuration editing are not completed by this increment. Capabilities are published only for implemented native methods. Viewpoints are memory-only, data-only client navigation; durable draft retention is not implemented.
