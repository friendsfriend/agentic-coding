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
| `session.context` | Explicit catalog-owned native session ID only; complete committed native context head (or null), raw active entries, position-aligned contributions after native edits/exclusions, and ordered derived model messages. Separately observed configured model/thinking and local catalogue limits are not an atomic revision, token occupancy or the complete provider request. Ownership is rechecked after assembly. Projections over 400,000 UTF-8 bytes refuse whole rather than trimming/reindexing; this bounds the emitted projection, not the SDK's internal context read. No polling, model call, queued-input placement, context adoption, mutation, credential discovery or standalone identity conversion. |
| `session.history` | Catalog-owned native session ID and optional opaque continuation; 50 raw fork-aware retained entries in chronological order, next cursor or null. Host-private registry (64 cursors, 10-minute expiry); successful continuation retires its used reference. A read that needs room evicts expired references first, then the soonest-expiring live ones, so an observation that needs no prior cursor is never refused for registry capacity; an evicted continuation fails closed on its next use and is never replayed. Native ownership rechecked before/after read. Arbitrary client cursor/filter adoption is refused. No model calls, compaction or usage-total claim. |
| `session.watch` | Connection-only read-only observation control: bounded `watchId` and native numeric session ID, or `id:null` to stop. Replaces the socket's previous watch; publishes complete transcript/progress projections. Same session-catalog fence as reads, never arbitrary conversation adoption. |
| `session.send` | Session ID, bounded content and caller submission identity; returns native submission ID. |
| `session.abort` | Session ID; native abort request acknowledgement, not a guarantee that all owned work has already stopped. |
| `session.compact` | Session ID and optional bounded instructions; returns native compaction task ID. No automatic model call occurs merely from reading a session. |
| `session.configure` | Session ID and existing configured profile ID; changes model/thinking through the native conversation API, without replacing its tools/ownership. |
| `task.read` | Catalog-owned numeric task ID; retained metadata, native status/abort-request/terminal outcome, owner-scoped immutable reviews and retained image metadata. No arbitrary native task/checkpoint or filesystem reads. Projection is non-atomic; metadata is not image-pixel proof. |
| `evidence.read` | Exact catalog-owned task ID + digest and optional integer byte `offset`; up to 384,000 bytes as base64 with `offset`, `totalBytes`, `nextOffset`. The entire retained file (at most 10 MB) is descriptor-fenced and digest/signature checked before any window is returned. Images remain single-window reads; oversized image display refuses. No arbitrary path/URL; Windows refused. |
| `task.cancel` | Native app-task ID; delegates cancellation and owned-resource release. |
| `review.decide` | Review ID, exact revision, decision and comments; native review/approval fences remain authoritative. |
| `schedule.delete` | Schedule ID and exact revision; deletes future timing transactionally and permanently retires the request identity, preventing delete/recreate ABA against stale revisions. Does not cancel an already admitted occurrence task. Schedule create/update remains orchestrator-only; recreation needs a new ID. |
| `environment.action` | Typed native operator selection (`apps`, action, request identity, optional target/profile/runtime/replicas/workspace/base); admits an operator environment task and preserves its human review. No client-side readiness or ownership grant. |
| `environment.inspect` | Explicit closed discovery/draft/tree/preflight/promotion/attempt/log/telemetry/HTTP-journal/SQL-journal reads. Strict selectors; native live-run/diagnostic scope fences remain authoritative. No navigation probe or lease restoration. |
| `environment.preview/apply` | Closed staged authoring/base/source/remove/preflight/promotion/cleanup/revoke/release intention. Inert exact JSON snapshot (96 KiB, 16 candidates, 10-minute expiry); manual approve:DIGEST. Candidate consumed before native invocation, even when native validation/effects fail. Outer UI confirmation never replaces native approvals or inspection/revision fences. No retry/restart/deployment/adoption grant. |
| `environment.logs` | Configured app ID; native diagnostic logs, not lease takeover. |
| `skills.read` | Loaded native skill metadata only: ID, system/user origin, bounded description, content digest and read-only policy flag. Maximum 128; duplicates/invalid metadata refuse. No filesystem reload or arbitrary path. |
| `skill.read` | Exact loaded ID + revision; returns at most 64,000 characters of loaded content after digest verification. Unknown/stale/tampered/oversized content and extra input fields refuse; no task admission. |
| `settings.read` | Fixed native CONFIG_DIR/config.json; bounded editable profiles/default/repositories/provider definitions, file-byte revision, restart-required marker. Missing fields use current runtime definitions. Unknown existing fields and credential values are not projected. |
| `settings.preview` | Exact base revision + complete editable settings object. Strict known fields, static profile/default/path/provider validation, HTTPS except loopback, environment-variable token references only. Returns bounded 10-minute immutable snapshot/digest/ID; no file write. At most 16 in-memory candidates. |
| `settings.apply` | Ephemeral candidate ID + literal `approve:DIGEST`. Exact unexpired confirmation and current byte revision required; fixed file only, cooperative exclusive lock and private atomic replacement. Running host is unchanged; separately authorized restart required. No replay/idempotency claim. |
| `providers.inspect` | Explicit read-only allow-list: repository search/branches/labels/collaborators; changes/issues (list/detail); change files/versions/discussions; jobs (GitHub requires run ID). Exact operation fields, bounded repository/query text, positive numeric IDs; native named provider and token/HTTPS fences retained. No arbitrary route, write, log redirect or automatic outbound call. |
| `providers.preview/apply` | Closed native write intention; immutable destination/operation/payload/request snapshot, 16 candidates/10-minute expiry, manual `approve:DIGEST`. Durable uncertain intent before one SDK dispatch; consumed/retained identities never redispatch. Acknowledgement is not remote completion. |
| `providers.actions/receipt` | Native journal reads by configured provider/exact request ID; up to 256 retained attempts. Large list result bodies are clipped at 1,024 bytes; exact receipt reads return at most 32,000 bytes without remote calls. Original destination metadata retained. |
| `viewpoints.read/save/remove` | Private UI-only pins (32 maximum), closed navigation DTO without drafts/detail/credentials/actions. Exact revisions and globally increasing sequence fence edits/deletion and recreation ABA. |
| `providers.read` | Empty input; native provider namespace inventory. No external provider operation. |
| `wiki.list/read` | Private native document metadata/explicit page and comment reads, never arbitrary paths. At most 64 pages, 32,000 characters each, and 128 comments. |
| `wiki.preview/apply` | Strict complete page input, exact base revision (0 for creation), immutable 10-minute candidate (16 maximum), manually typed `approve:DIGEST`; transactional page revision fence. Candidates are ephemeral, consumed on successful apply and never viewpoint authority. No filesystem/config write. |
| `wiki.comment` | Exact page revision, bounded comment, explicit profile/repository/Git base and stable request identity. Pins page snapshot/canonical repository/commit before admission. Only the system read-only wiki-comment skill; no user-selected policy/skill. Native comment intent and task identity survive reopen; exact retries return the same task, changed intent refuses. A pending record needs an explicit identical retry, never automatic startup admission. |

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

Requests remain ordered per connection except authenticated `standalone.abort`: cancellation must be able to interrupt an awaited standalone send/compaction rather than wait behind it. This narrow exception retains strict input validation, duplicate/in-flight limits and dispatch ownership checks; it cannot interrupt a foreign or adopted handle. Interrupted attempts remain uncertain and consumed even if a backend later reports success. Abort acknowledgement does not establish remote termination; settled dispatches reject late aborts.

Closing a connection discards queued work that has not started and retires its watch/timer. Already-running work may finish. Host shutdown stops polling, closes clients and waits for running request chains, cancellation interrupts and watch/setup cleanup before stopping the listener/runtime. Stopping observation does not abort native work. TUI renderer/client/signal handlers are cleaned up on exit; no legacy window launcher is involved.

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

## Conversation profile UI

`/view profiles` displays running-host profile definitions and catalog-owned conversations, not pending file settings. Select a target, then prepare `/inspect-model ID` (read only) or `/model-for ID PROFILE` (explicit submission required). Inspection retains only ID/model/thinking/local receive time and labels cached/non-atomic observations. Switch preparation protects drafts, requires a writable current catalog target and safely representable profile ID; submission rechecks host profile/catalog membership and uses the existing native `session.configure` ownership fence. Original `/model PROFILE` still configures the selected transcript conversation.

Availability is only the existing registry/auth hint, not generation/connectivity proof. There is no discovery/credential/provider probe added by this panel. Terminal targets can be inspected/opened but are not offered switching. Restored missing targets are explicit, and restored selection/cache/drafts never execute configuration. Switch acknowledgements do not authorize restart, default/file/task-metadata edits, cancellation, mutation replay or replacing an in-flight generation.

## Loaded skill browser

`/view skills` reads the bounded current host catalog. `/skill ID@DIGEST` is an explicit, revision-fenced instruction read from loaded configuration, never an arbitrary filesystem path. System/user origin is provenance, not authority; the readOnly flag forces read-only policy at native admission, while other skills still require an explicit policy and independent shell review. Descriptions are bounded previews, not full instruction proof. Loaded content remains the host's startup snapshot even if source files change on disk; refresh is not reload.

Instructions render inert as cached code text, not executable Markdown commands/URLs, and are never stored in viewpoints. Preparation protects existing drafts. Orchestrator-discussion preparation navigates only after checking the source draft is empty and stages a request to discuss goal/acceptance/topic/profile/repository/base/policy, explicitly forbidding admission until agreement. It does not send a message, start a task, create a schedule, execute a shell command or grant permissions. Content/selection is not restored as authority, and reconnect does not replay reads/mutations. Wiki storage/comment-skill binding is implemented separately. Native flat user-skill file authoring is available through the separate authenticated `skill-file.read/preview/apply` contract below, never through loaded-instruction reads.

## Not yet claimed

Native evidence pixels, bounded owned-work/session trees, structured local settings drafts, wiki/comment binding, command suggestions/action focus/history and durable navigation-only pins are implemented. Native provider intention controls require explicit immutable approval; exact reviewed SHA is required for review approval, and GitHub own-unapproval verifies the configured username against the authenticated account. No merge/arbitrary routes. Other writes are exact-target intentions, not remote version CAS. Native SDK PUT/rerun/204 handling is corrected; public HTTP route names/web assets are retained and dispatch-token echoes are redacted.

The native environment workbench provides explicit operation selection, field guides and memory-only JSON drafts shared across its environment/observability views. Operation/body changes invalidate confirmations. Resource changes/disconnect clear observation/candidate/focus state; draft bytes remain only in client memory, never pins/history authority. Reads are explicit; applying a manually confirmed immutable intention can perform native filesystem/operator effects. Failed/uncertain intentions are not redispatched. Live SQL/HTTP execution remains only the owning workspace-write task’s separately approved diagnostic path, not an operator UI lease takeover. Structured records use bounded expandable data trees; presentation clipping is explicit, never a completeness/authority claim. Retained transcript history is an independent explicit browser bounded to 500 local entries: an older page that would exceed that bound is refused whole, so no cached entry is dropped and the scan stops until the reader clears the cache explicitly. It is not a replacement of the live watch or adoption of another conversation.

The keybinding catalog supplies original-stack registrations, local editor/prompt key behavior, contextual special-key footer and full help, rather than panel-body shortcut cheatsheets. No renderer/helper/navigation-matrix tests were added; the authenticated native fixture verifies inert staging, exact confirmation, one application, unchanged task inventory and retained-history/foreign-cursor refusal without any external engine or provider call.

## Native user skill file authoring

`skill-file.read {name}` explicitly observes the fixed canonical `CONFIG_DIR/skills/<slug>/SKILL.md` destination (or missing file), returning its byte revision, directory identities and bounded valid UTF-8 content. Configuration directory must already exist; this read never creates it. Only lower-case flat non-system slugs are admitted; loaded nested sources retain native-only source identity and are refused rather than duplicated or adopted. Windows, symlink/hard-link/nonregular and oversized sources refuse.

`skill-file.preview {name,baseRevision,content}` validates exact-name/non-empty-description frontmatter and seals the complete destination/content/directory/base snapshot. It performs no writes, reloads or task admission. Sixteen ephemeral candidates expire after ten minutes. `skill-file.apply {id,approval}` requires manual literal `approve:DIGEST`; the candidate is consumed before its single filesystem attempt, even on failure. Current byte revision and existing directory identities are rechecked under a cooperative exclusive lock; new skill directories and temporary bytes are private, replacement is atomic and directories are synced. A retained interrupted lock is never stolen. External non-cooperating writers can still race the final check; no filesystem CAS/hostile-writer safety guarantee is claimed. Failed/uncertain attempts require explicit disk inspection before a new intention; partial directory creation or replacement may have happened.

The editor protects local text against reads/templates, invalidates confirmation on edits/resource selection/disconnect, retains draft bytes only in memory across page navigation, and clears observation/confirmation on remount. No source/candidate enters pins/input history. Saving never modifies the immutable loaded catalog, running tasks/policies or providers, and never restarts the host. Restart is separately authorized. Retained image bytes now admit PNG/JPEG/WebP/GIF with matching signatures; size/digest/owner/descriptor and terminal decode bounds remain unchanged.

Retained evidence now includes valid UTF-8 logs/scripts/reports/JSON, ZIP trace signatures and WebM/MP4 signatures as well as four image formats. `attach_evidence` is a native task-workspace tool with a 10 MB regular-file/descriptor limit; it never executes, extracts or certifies files. Storage uses private exclusive content-addressed destinations, never overwrites a collision or transfers another task’s identical digest. Explicit byte windows verify the entire retained digest, reject invalid ranges and report continuation/total size. Text display is clipped, inert and may replace UTF-8 characters split across windows; binary display is at most 256 hex bytes. No player, ZIP extraction, path opener or external fetch is provided. Images retain their separate terminal byte/dimension/pixel bounds.

The environment/observability diagnostic composer prepares only memory-local requests in a currently writable native workspace-write task conversation. App, endpoint/infra and path/query are explicit. No new gateway execution method is added: actual `env_http_get` / `db_query` still requires the native owner’s live lease, exact separately reviewed issuance and existing uncertain-replay fences. Drafts are never persisted, submitted, adopted or approved by navigation.

Standalone OpenCode/Pi authority adapters and complete selected-specialized presentation/live diagnostic parity remain incomplete. Capabilities are published only for implemented native methods. Manual terminal acceptance and real external compatibility are not claimed. Durable pins exclude all sensitive drafts; editor/candidate state stays ephemeral. Memory bookmarks cannot save/restore provider confirmation drafts. Native pin restoration never restores candidate/execution authority.

## Client-side context validation and named native tool fields

`session.context` results are now validated where every other native result is: before they become client state. The client refuses a projection whose raw entries no longer pair with their position-aligned contributions, whose model record cannot be reported honestly (non-string provider/model ID, non-boolean catalogue flag, a zero/non-integer context window or output limit), whose thinking value is not a string, or whose whole serialized projection exceeds the same 400,000-character budget the server refuses to exceed. Validation never trims, reindexes or repairs a payload; a refused projection is not a partial observation. `head` stays an opaque object or `null`, so no client code can read a revision out of it.

Tool cards additionally name the supplied fields of the native tool families whose results are structural rather than prose: `request_review` (path/title plus recorded review id, state, digest, revision, comments, timestamp), `attach_image`/`attach_evidence` (kind/path/caption plus retained id, media type, filename), `start_task` (`topic`/`profile`/`baseRef`/`workspaceMode` plus recorded task/state/conversation identifiers), `task_result`/`cancel_task` (requested task plus recorded state/status/reason), `environment_action` and `env_start`/`env_status`/`env_stop` (requested apps/action/target/profile/runtime plus recorded state/holders/run). Named values are clipped at 400 characters with an explicit note that the complete value remains under Arguments/Details/Output, and the section states that these are supplied values for this card only: not current child status, completion, approval, adoption or a linked transcript. Unrecognized tools keep the generic retained-output composition, and no field here confers authority.

The client registers no tool that calls `executeTool()`, so v2 never creates nested tool calls: the retained per-call `NestedCallDoc` family stays empty and is deliberately not read or rendered. Live nested slots remain validated and composed defensively (a slot must name its parent task and call), and the sidebar/transcript never infers a parent from ordering.

## Supplied environment output is text, not history

`environment.logs` used to return `unknown`, so the only method whose result the client
never bounded was also the one whose result the reader pane displayed. It now carries an
explicit `string` output and is validated at the same client boundary as every other
result: a non-string value and a value above the server's own 64000 UTF-16 unit tail are
refused whole rather than truncated or wrapped, and the refusal names the shape it
expected.

The command behind it also stops being an unchecked identity read. `/logs APP` now
requires the environments page, an `APP` identity that the currently supplied
environment observation actually names, and the same post-await fence the other detail
reads use: the originating view, its detail epoch, the connection state and the supplied
identity are re-checked before the text is placed into the detail record, so a reply that
arrives after the reader navigated elsewhere is refused instead of written onto a stale
view. The accompanying notice states what the text is: a bounded tail of supplied output,
not native log history, a complete capture or an acknowledgement.

### Reading-prelude cursor lifecycle

The TUI distinguishes “not requested yet” from a terminal null history cursor. Reads
are explicit (an upward read intent after expanding the local window, or a local page
action), not mount/focus/poll effects. It clears a single-use continuation before awaiting
its reply and stops at 400 retained history entries. A page crossing that bound is
refused whole, not partially adopted. An explicit restart after failure/capacity clears
only the local prelude and starts from the newest native history page. No retry or
watch-continuation claim is implied. Client/conversation/connection changes retire the
read lifecycle. Gateway fixtures verify cursor exhaustion and single consumption;
TUI scroll/layout behavior remains outside those tests.
