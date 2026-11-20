## Context

V2's environment subsystem already provides strict configuration, target selection, ownership-fenced adapters and immutable operator approvals. Its manager and persistence currently depend on Pi's native Harness/documents. The working tree also contains concurrent review/runtime edits and a separate Code Mode integration change. This change must neither replace those edits nor load a second agent runtime.

## Goals / Non-Goals

**Goals:** Make environment tools portable through MCP, preserve existing domain rules, and progressively replace the native task dependency with controller-owned scopes. Keep human decisions distinct from model requests and transport permissions.

**Non-Goals:** A new coding harness, automatic live-resource adoption, new runtime support, immediate full parity, OpenCode UI/plugins, transcript renderers, or moving developer review into MCP in this first change. No automatic MCP client installation or authentication.

## Decisions

### 1. Ship a read-only vertical slice before execution

Add a dedicated stdio entrypoint under `src/mcp/`, using the official TypeScript SDK and a small transport-independent catalog interface. Tools initially expose `env_list` and `env_discover` only. No action/approval/stop tools are advertised. This is a standalone catalog process, not yet a standalone resource controller. Reuse v2 catalog/discovery rules through an adapter rather than duplicate schemas or shell out to the existing host.

The operator supplies `--config-dir` and an explicit repeatable `--repository` allowlist. Do not load Pi profiles, skills, provider configuration, `.env`, credentials or native state. The adapter may transitively import existing domain modules; importing those modules is not opening a harness. Eliminating that package linkage is later extraction work.

Catalog output is paged, with bounded public summaries rather than full executable target definitions. Discovery uses the existing bounded manifest reader and exact authorized roots. Responses explicitly distinguish inspection from runtime health or approval. Errors never echo filesystem exceptions or configuration contents. Only MCP protocol bytes go to stdout; CLI errors go to stderr.

### 2. Separate transport from authority

MCP server registration consumes a narrow controller interface. It does not accept a generic URL, arbitrary HTTP proxy path, shell command or model-selected owner identity. Future execution tools operate on authenticated controller-issued scope bindings, not IDs that confer authority by themselves.

The eventual shared controller uses authenticated loopback Streamable HTTP, with an optional stdio bridge for clients. Do not start independent resource managers per client. Read-only catalog processes can coexist because they reserve, launch and stop nothing.

### 3. Extract the controller incrementally

First isolate transactional environment persistence and explicit owner lookup from Harness. Then implement durable execution scopes, content-bound idempotent operation admission, immutable plan approval records, issuance fences, queues and conservative restart reconciliation. Keep runtime adapter behavior and live-handle cleanup authority unchanged.

The persistence port uses singleton JSON document identities plus transaction-local `ownerActive`/`ownerInfo`. A native adapter preserves the existing document kinds, versions, checkpoint policy and task-cancellation checks. The manager, acquisition, revocation and HTTP/SQL issuance paths use that port; native workflow/task orchestration remains in its existing adapters.

The standalone backend is a separate SQLite store in an existing canonical user-owned private POSIX directory outside authorized repository roots. It uses `BEGIN IMMEDIATE`, full synchronous durability, serialized transaction callbacks, rollback and version/application identity checks. One original directory lock fences controller instances. Locks are never reclaimed automatically by age or saved PID; an uncertain close retains its lock. This does not claim an OS sandbox or protection against a hostile same-user directory namespace writer.

Scopes bind a trusted transport-authenticated principal to a controller-issued random scope ID, monotonically allocated internal owner, captured workspace directory identity, explicit job/interactive/operator mode and idle policy. The binding API is internal: it does not authenticate caller-authored principal objects. External worktrees require a future explicit workspace authorization path; this milestone accepts only canonical workspaces contained in an authorized repository. On accepted restart, old active/closing scopes become interrupted. There is no implicit reattachment or restored process authority.

The internal operation journal captures the scope/lifecycle and existing environment approval disclosure as immutable bytes before approval. Request identity is content-bound after normalization. Replays return historical records without resolving today's configuration or resurrecting a scope. Issuance requires a current active owner, exact approved plan digest/revision and the current host generation. A fresh in-memory permit is returned only after durable issuance; copied or previous-host permits cannot record completion. Old issued operations become inspection-required interrupted records; old pending approvals also stop rather than rearming. The operator decision backend exists separately, but an authenticated operator endpoint and actual runtime dispatch remain gated on stage 3.

Generic MCP callers get explicit stop, controller-enforced idle/lease policy and operator recovery. Disconnect is not task completion. Optional harness adapters can later bind terminal job events to explicit scope closure. Session idle must not imply completion of descendants or release of operator infrastructure.

### 4. Human approval is a separate operator surface

Before enabling actions, provide an authenticated operator-only path to inspect/approve/reject the exact frozen plan and revision. Generic MCP permission prompts and elicitation are not substitutes. Never register approval, revocation or quarantine acknowledgement as model tools. UI remains separate from the transcript and can later be rendered by an OpenCode plugin or standalone client.

The first operator adapter is a separate `127.0.0.1` HTTP listener with a fresh process-local bearer token returned only to its embedding host, never in URLs, cookies, MCP results or logs. It enforces Host/Origin checks, no-store/security headers, eight in-flight requests, 4 KiB decision bodies and a five-second body deadline. Its endpoints list bounded operation summaries, inspect one exact frozen plan and submit an idempotent digest/revision-fenced decision. Approval does not dispatch. No UI, browser launch or public listener is added.

### 5. First owned shell execution

`EnvironmentController` composes the existing environment manager with standalone persistence and scope-bound admissions. The manager accepts an already validated project catalog so bounded definition reading is shared with the MCP inspection adapter. It retains existing acquisition queues, conflict checks, secret resolution/redaction, process-group handles and cleanup receipts; there is no second shell orchestration engine. A compatibility owner descriptor maps the controller scope onto the manager's existing task-shaped domain input without creating a native task or model conversation.

The first executable subset supports shell/systemshell in an existing canonical repository-contained workspace. Unsupported runtimes, dependency workspaces, optional lifetime modes and telemetry fail before approval rather than silently falling back. Plans bind the Git HEAD observed at admission and recheck it before issuance. Uncommitted files remain mutable; neither directory identity nor HEAD is a source snapshot or OS sandbox. Referenced secret values resolve only inside approved execution. Run resources remain held by the scope until explicit stop or controller shutdown; standalone scope expiry/closure is stage 4.3, not already implemented.

An embedding host can explicitly register `environment_action`, `env_result` and `env_status` for a pre-authenticated, fixed scope. The default source-run stdio entrypoint remains read-only until stage 4 supplies the shared authenticated transport/bridge. `environment_action` admits run/build/test, separately executes an approved operation ID, or stops owned resources. Admission and operator approval alone never start a command. Execute returns after durable issuance; actual completion is recorded asynchronously. Reads are immediate observations, not polling or implicit waits. The internal `wait` helper joins the owned execution promise for embedding/tests, not pending human approval.

Results distinguish settled execution from success: nonzero build/test exits are failed data, readiness follows the declared probe, and ambiguous cleanup interrupts the operation with inspection required. Stop identity is checked before any abort; historical stop receipts never cancel a newer generation. Cleanup uses only the manager's original live handles and remains possible after workspace replacement or scope closing on the same host. Close aborts owned work, joins original-handle cleanup and then closes persistence. No restart restores a process handle or resends an issued operation.

### 6. Shared transport, bridge and lifecycle

The shared MCP listener is numeric loopback only. Operator-provisioned bearer keys map to fixed agent principals/scopes at listener startup; request metadata and model arguments never select authority. Each key gets a cheap per-request SDK server factory over the same controller. Both modern per-request HTTP and stateless legacy MCP are served by the official SDK. Host/Origin checks, 64 KiB/five-second POST bounds, bounded in-flight requests/subscriptions and no-store headers apply. MCP and operator credentials are distinct and never interchangeable. This is local bearer authentication, not an OAuth authorization server or remote deployment.

The stdio `--connect` mode is a tools-only SDK bridge with a credential read from an explicit environment reference. It accepts only the numeric loopback `/mcp` endpoint without URL credentials/query/fragment, refuses redirects, snapshots the known environment tool catalog, forwards cancellation and sanitizes transport errors without retrying calls. Closing stdin closes bridge transports only, never the shared scope or resources. The SDK client is a production dependency for this mode, pinned at the existing version.

The `--serve` CLI owns one controller and both listeners. A bounded operator-owned client definition file supplies 1–32 unique IDs, canonical workspace/repository choices, job/interactive modes, idle policies and named credential environment references. No principal or scope is inferred from a client connection. A fresh operator credential is published only in a newly created mode-0600 `operator-access.json` under the private state directory. Existing access files are never overwritten; normal shutdown removes only the original unchanged file. A crash or replacement requires operator inspection, not age/PID-based takeover. Client keys are not stored in that file. No model/provider credential or existing native state is read or migrated.

Explicit scope close journals its content-bound intent, fences the scope and pending unissued plans, then aborts and joins original manager cleanup before marking the scope closed. Interrupted cleanup remains quarantined. Idle cleanup uses the same path, once per minute: actual client environment use renews an in-memory host-bound activity sequence, in-flight execution/acquisition/startup is protected, and operator infrastructure never expires automatically. Expiry rechecks the activity sequence on the transaction line to avoid closing a concurrently renewed scope. Operator inspection does not renew agent activity; disconnect does not close a scope. Clock rollback is not evidence of expiry. Sweep errors remain visible in scope status. Closed/interrupted scopes and close receipts cannot revive saved handles on restart.

### 7. Runtime and prerequisite policy

The shell-only controller gate is replaced by one transport-independent plan policy over existing native rules. Shell/systemshell, owned Docker/Podman, the strict Compose subset and explicit Kubernetes pod/Deployment/Helm targets all dispatch through the existing manager. Kubernetes connection references are captured before approval with `prepareCluster`, not resolved from a default context at dispatch; Helm retains the original chart capture and freeze/recheck behavior. Explicit replica selection and agent independent/referenced/shared lifetime choices are part of the content-bound intent. Protected infrastructure lifetimes are available only to trusted operator scopes; model tools cannot select them or supply operator markers. Native validators continue to reject unsupported combinations.

Declared foreign prerequisites use the manager's original `DependencyWorkspaces` capability registry. The journal accepts only plans that `belongsToOwner` authorizes for the root scope; it does not treat an arbitrary foreign directory as a workspace. Foreign descriptors pin source/common-directory identity and commit and materialize a new private detached worktree only after approval/reservation. A later source HEAD or uncommitted-file change does not replace that captured commit. Root HEAD remains independently pinned/rechecked. Foreign Kubernetes prerequisites remain refused by the native repository-scoped cluster authorization rule.

Execution outcome classification is a pure rule: bounded queue receipts are not running apps, nonzero exits are not successful verification, and unsettled/uncertain resource observations remain inspection-required. If a run exits after startup but before the receipt read, the result reflects the exit rather than inventing a live environment. Runtime status/endpoint/log excerpts are separately JSON-byte-bounded without cutting resource IDs or URLs; omissions are reported. This bounds multi-app/replica receipts independently of Unicode or control-character expansion.

Verification covers adapter readiness/ownership at the data rule and one functional foreign-worktree/shared-reference scenario with disposable shell processes. A prototype Docker/Compose executable-fixture scenario passed but cost over four seconds; it was converted rather than normalizing that repeated CLI/engine setup cost. Docker/Compose/Kubernetes/Helm dispatch compatibility is not automatically certified by these tests and remains manual review/live verification only when separately authorized. No real engine, cluster or credential is used.

### 8. Scoped diagnostics and shared approval journal

Logs and opt-in native telemetry delegate to the existing manager with an explicit bound owner (and optional exact telemetry run). Log source selection, literal matching, timing/byte windows, replica/service refusal and redaction remain native rules. Telemetry still requires the original live ready receiver and current prerequisite generations; historical captures do not recreate a receiver or restore credentials.

HTTP and SQL use the same controller admission/decision/issuance state machine as environment actions, not a second review store. New operation kinds freeze normalized intent and the native prepared descriptor, including exact run/requiring-app/prerequisite generations and referenced credentials/public CA identity. Normalized HTTP headers make object/key order irrelevant while changed work under one request ID is refused. Shared disclosures are extracted without changing native tool review text. Operator lists omit HTTP bodies and SQL text; exact inspection exposes the reviewed snapshot. No HTTP or database request occurs at admission or approval. A separate `environment_action execute` request consumes approved current-host issuance once, then calls the native request method with its original issuance ID/input and cancellation signal.

Both journals remain mandatory: the controller prevents generic operation replay and native HTTP/SQL receipt fences remain directly before network/database I/O and at publication. Dispatch never re-prepares a descriptor to follow a replacement generation. Errors after issuance become unknown/inspection-required; neither cancellation nor READ ONLY is advertised as a rollback or sandbox guarantee. The native SQL driver remains unchanged (verified TLS, frozen referenced least-privileged credentials, single-statement prepared protocol, bounded lossless-number results and acknowledged rollback).

Generic result receipts retain bounded diagnostic views and an exact native history pointer. Omitting an oversized already-redacted body for presentation does not invent uncertain execution; native history retains its independently bounded original result. Historical lists use a native selectable page limit (legacy default 200 unchanged; MCP maximum/default 50) so cursor boundaries stay correct without slicing away unseen rows. Exact-ID/history reads first authorize the scope's own run and never restore live authority. The stdio bridge explicitly permits the five new diagnostic tool names, not arbitrary future/admin tools.

Verification extends the existing disposable controller/HTTP/bridge fixture for one exact-approved loopback write, redaction, no resend, stale-generation refusal, owned log/telemetry access and foreign-scope denial. SQL normalization and the common approval/nonce/issuance journal have direct/fake-prepared tests, with no database stood up merely to re-prove transport plumbing. Live PostgreSQL driver compatibility is not established by those tests; no real database/credentials or infrastructure is used.

## Risks / Trade-offs

Operator definition controls delegate an explicit allowlist to native drafts:
immutable staging/source/base captures, preflight, exact promotion, history and
uncertainty acknowledgements. The separate bearer listener accepts bounded JSON
and no query parameters; it never exposes dynamic manager method lookup to MCP.
Recovery summaries return at most 200 recent runs with exact-ID lookup outside
that window. Revocation delegates the native content-bound whole-owner journal
and requires current original live authority; acknowledgement requires an exact
interrupted revision and represents manual inspection, never actual cleanup.
Daemon verification exercises exact promotion/replay and credential isolation.
Full native preflight/recovery rules remain native tests/code-review guarantees,
not a claim of live engine cleanup verification.

The final parity matrix and stopped-host transition procedure are in `MCP.md`.
Native databases/live handles are never imported. Client scopes are configured
bindings, not inferred session/subagent ownership; terminal job adapters, operator
UI, external workspace authorization and remote authentication remain explicit
future work rather than silently approximated parity.

- [Initial slice is inspection only] → Advertise only supported tools and document that execution/recovery parity remains unfinished.
- [Domain imports retain Pi package linkage] → No Harness/model/provider initialization; replace linkage behind the catalog interface as extraction proceeds.
- [Existing definitions contain public literal values] → Return allowlisted metadata only, not commands, environment values or secret references. Literal credentials remain invalid configuration practice, not something metadata filtering can classify perfectly.
- [Concurrent unrelated changes affect gates] → Preserve before/after baseline and do not rewrite user-owned files to make checks green.
- [Read-only stdio is not a filesystem sandbox] → Canonical explicit repository allowlist and existing contained discovery; approved local code still has normal OS authority.
- [Later shared transport/auth choices are security-sensitive] → Gate mutations on isolated ownership/approval/restart scenarios before connecting live runtimes.

## Migration Plan

1. Add and verify read-only MCP catalog without changing the existing CLI/runtime.
2. Extract environment storage and scopes with disposable fixtures.
3. Add the operator approval boundary and owned shell action vertical slice.
4. Add shared authenticated controller transport and stdio bridge; verify multiple clients cannot cross scopes.
5. Extend existing adapters/diagnostics and add lifecycle integrations before retiring native-host ownership.

Rollback of the first slice is simply removing the MCP client entry. It writes no native state or definitions and starts no apps. Later migration never imports/adopts existing live resources and needs an explicit stopped-host transition.

## Open Questions

- Which operator frontend should host standalone approvals after extraction? The existing v2 environment UI can remain the reference, not a mandatory agent runtime dependency.
- Which task lifecycle integrations are worth retaining beyond generic explicit scope closure and idle cleanup?
- How should external MCP principals be provisioned for a future non-loopback deployment? Remote exposure is out of scope until that is designed.
