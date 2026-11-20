# Environment MCP

The source-run entrypoint supports read-only inspection, one shared authenticated
local controller, and stdio bridges for MCP clients. Execution reuses the native
local runtime adapters; this is **not full environment parity or a live-state
migration from the native host**. UI integration remains deferred.

## Read-only inspection

### Reusing the native v2 installation

Native v2 resolves its configuration directory from
`AGENTIC_CODING_V2_CONFIG_DIR`, otherwise
`${XDG_CONFIG_HOME:-~/.config}/agentic-coding-v2` (`src/config.ts`). Its project
definitions live in `environments.json`; its explicit repository allowlist lives
in the adjacent `config.json`. Pass that directory and those repository paths
to MCP rather than making a reduced copy of the definitions. MCP intentionally
does not call `loadConfig`, which also loads agent/provider settings.

The definition reader, catalog limits, pagination offset, launch arguments and
controller repository authorization now accept the native 64-project installation
size, retaining per-page/result bounds. Client credential bindings remain
separately capped at 32; a catalog repository is not a client credential/scope.
Catalog visibility does not grant cross-repository execution authority: each
execution scope is still bound to its configured root/workspace and declared
prerequisites. Definition reuse never adopts native live state.

Verification of the installed configuration on 2026-11-20 used real read-only
stdio MCP: all 41 project IDs and 117 targets were returned in five pages. No
configured commands, engines, clusters or credentials were invoked. The existing
stdio fixture additionally covers a 41-project document above 64 KiB, final-page
access, retained redaction and refusal above the shared 256 KiB cap. Launch parsing
accepts 35 explicit repositories. Full suite before/after: 289 pass, 0 fail,
16.34s / 16.14s; catalog test file 0.301s / 0.258s. These variations are not a
speedup claim or a new budget: the suite still exceeds the 12–15s target. Both
packages' lint/type gates pass. This verifies catalog parity, not live runtime or
OpenCode client integration. Profiles/provider APIs, cluster-management tools
and native task-specific queue recovery are not implicitly exposed as MCP tools.

Install the package dependencies with `bun install --frozen-lockfile`, then run
from `agentic-coding-v2/`:

```sh
bun run mcp --config-dir /absolute/path/to/config --repository /absolute/path/to/repo
```

Repeat `--repository` for each authorized root (1–64). Paths must be absolute;
repository roots are canonicalized at startup. `env_list` returns the canonical
paths to use in subsequent calls. No repository list is inferred from the
working directory, MCP client roots, Pi settings or `config.json`.

This process speaks MCP on stdin/stdout. It does not open a TUI, browser or HTTP
listener. Help and sanitized diagnostics go to stderr. Closing stdin ends the
transport; SIGINT/SIGTERM close it explicitly. There are no owned resources to
release in this mode.

The entrypoint is source-run with Bun; the existing application build/installer
does not yet produce a separate MCP executable. A client launch definition is:

```json
{
  "command": "bun",
  "args": [
    "/absolute/path/to/checkout/agentic-coding-v2/src/mcp/cli.ts",
    "--config-dir",
    "/absolute/path/to/config",
    "--repository",
    "/absolute/path/to/repo"
  ]
}
```

Use the full Bun executable path if it is not on the client's PATH. Put this
definition in the MCP server configuration structure required by your client;
that outer structure differs between clients. No credentials or model provider
configuration are required. No live OpenCode/other-client compatibility test has
been performed; automated checks use the official SDK client over real stdio.

## Tools

### `env_list({repository?, offset?, limit?})`

Reads `CONFIG_DIR/environments.json` through the existing v2 schema. Missing
definitions produce an empty catalog; malformed/unsupported definitions fail
with a sanitized error. Files use the shared native definition limits: 256 KiB,
64 projects / 256 total targets, pages to 10 projects and tool result data to
128 KiB. Catalog definitions are reread for each request; pagination is a current
observation, not a frozen multi-request snapshot. Executable plans use the
controller's startup-captured definitions and require separate approval.

Returns project and target IDs, runtime/action/profile, optional labels, the
existing default-selection explanation and metadata-only availability. It
does **not** return commands, literal environment mappings or secret-reference
mappings. `nextOffset` indicates another page. Public metadata such as labels
and repository paths is not a place to store credentials.

`inspection-only`, `executionAvailable: false` and `runtimeChecked: false`
distinguish the catalog from startup/health verification. Availability checks
inspect filesystem metadata; they never invoke runtime clients or connect to a
daemon. Catalog entries are definitions, not running environments; the shared
execution mode separately provides scoped `env_status`.

### `env_discover({repository, directory?})`

Uses the existing contained public manifest/build-tool discovery for exactly
one authorized repository and optional relative directory (`.` by default).
Returns bounded, explicitly untrusted suggestions, source evidence, omissions
and limitations. It does not execute scripts, read `.env`/provider files, follow
discovery symlinks, write definitions or establish readiness. In the shared
mode, direct client tool use renews only that client's active scope idle clock;
read-only standalone inspection has no scope or resources to renew.

Unknown tool argument fields are refused. Unauthorized repositories, invalid
catalog data and unavailable/escaping discovery sources fail without returning
raw filesystem errors or configuration contents. This is a local read boundary,
not an OS sandbox against processes running as the same user.

## Boundaries and next milestones

- The MCP adapter has a transport-independent catalog interface. Its first
  backend reuses v2 environment validators/discovery. It still has transitive
  package linkage to existing domain modules, but it does not open a Harness,
  Runtime, model runtime or native state store, or load agent/provider settings.
- The default inspection mode advertises no mutation, approval, stop,
  revocation or quarantine-acknowledgement tools. Several read-only catalog
  processes can coexist because none
  controls processes or reserves resources. Do not extend them into independent
  per-client execution authorities.
- Transactional storage, controller-issued scopes, the immutable journal,
  operator-only approval API and first owned shell action are implemented.
  Shared authenticated serving, stdio bridging, runtime delegation, explicit close
  and idle scope cleanup and scoped diagnostic tools are implemented. Operator
  definition/recovery controls are operator-only; see the parity and cutover checklist below.
- Execution uses one authenticated local controller, optionally reached by
  stdio bridges. An MCP disconnect is not task completion. Task-lifecycle
  integrations remain optional future adapters over explicit scope close.
- Existing runtime ownership, original-live-handle cleanup, issuance fences,
  secret redaction, dependent-first release and uncertain-effect quarantine are
  migration requirements, not guarantees already implemented by this catalog.
- Custom OpenCode tool wrappers, UI plugins and review integration are deferred.
  Environment UI will remain outside the transcript. Future developer review
  should retain the v1 diff/comment flow and investigate a transcript file list.

The tracked plan is
[`mcp-environment-controller`](../openspec/changes/mcp-environment-controller/tasks.md).
No native state, definitions or resources are imported or migrated.

## Controller foundation

`src/environment/persistence.ts` defines the document/owner transaction port.
`native-persistence.ts` keeps current v2 operation on the native Harness with
unchanged stored identities and transaction-local cancellation checks. Manager,
acquisition, idle, revocation, draft and HTTP/SQL issuance consumers no longer
require a Harness for their persistence interface. The old native task host
continues to own execution; this is not a live-state migration.

`src/environment/controller/` adds a standalone backend:

- `ControllerPersistence`: private SQLite documents with full synchronous
  durability, rollback, single-controller locking and serialized access. Supply
  an **existing canonical, user-owned POSIX directory with no group/other
  permissions**, outside authorized repositories. The database is separate from
  native state. An existing `controller.lock` refuses opening, even after a
  crash; an operator must verify the old controller has stopped before explicitly
  removing it. No age/PID-based automatic takeover occurs.
- `ControllerScopes`: durable principal-bound scope IDs and internal owners,
  canonical workspace directory identity, explicit job/interactive idle policy
  and protected operator infrastructure without an agent idle deadline. Currently
  workspaces must be contained in an explicitly authorized repository; external
  worktree admission is not implemented. Explicit close journals/fences the scope,
  joins original-handle cleanup, then marks it closed or inspection-required.
  Automatic sweeps enforce agent idle policy through that same path.
- `ControllerOperations`: content-bound admissions, immutable plan/disclosure
  bytes, digest/revision-fenced decision records, durable issuance and bounded
  completion receipts. The injected plan resolver is trusted domain code, not a
  model-authored command. It must not execute or resolve secret values. An
  operation can be issued only once after exact approval. Completion requires
  the original in-memory permit; identifiers and copied records are not permits.
  Frozen plan/disclosure snapshots are capped at 512 KiB and completion receipts
  at 64,000 bytes; executable plans are refused, never truncated to fit. The
  private document store also has a 4 MiB per-document bound and retains history
  rather than silently pruning it.

Principal binding is an **internal trusted API, not authentication**. An embedding
transport must authenticate the principal/role before binding it and must never
take those fields from model tool arguments. The shared listener supplies this
authentication/binding; operator definitions and recovery acknowledgements use a
separate listener. The shell adapter provides actual original-handle execution,
queueing, redaction and cleanup; the catalog-only CLI does not start it.

Reopening interrupts old active/closing scopes and old pending/approved/issued
operations rather than rearming them. Issued records require inspection; settled
receipts stay historical. This is verified with disposable close/reopen scenarios,
not a live-engine crash test. No native state or saved process IDs are adopted.

## Runtime execution and separate operator approval

`EnvironmentController.open({stateDir, configDir, repositories})` composes the
standalone store/scopes/journal with the existing environment manager. It does
not start an agent harness or load model credentials. Definitions are captured
at controller startup through the bounded v2 validator; restart to discover
definition changes. No command or referenced secret is resolved at startup.

The controller delegates to the existing native adapters, preserving their
current subsets and refusal rules:

| Runtime/feature | Support and verification limit |
| --- | --- |
| `shell` / `systemshell` | Native run/build/test and declared readiness; disposable-process verification |
| `docker` / `podman` | Existing owned-container/build adapter, explicit local socket and original creation receipts; no live-engine verification |
| `compose` | Existing strict subset, captured source, owned network/volume/dependency behavior; not arbitrary Compose CLI compatibility |
| `kubernetes` | Explicit local pod / Deployment / Helm-release plans with prepared cluster references; existing UID/release/frozen-chart guards, no live-cluster verification |
| Agent lifetime | `independent-roots-v1`, `referenced-roots-v1`, `shared-prerequisites-v1`, subject to native restrictions |
| Foreign prerequisite | Declared authorized closure only; original capability creates a private detached worktree at the captured commit after approval |
| Protected infrastructure | Native operator lifetime plans only through trusted operator scopes; model fields cannot grant this authority; operator controls are still being migrated |
| Telemetry | Declared native collection and live scoped `otel_query`; no external backend/metrics or saved receiver adoption |

Root workspaces must be canonical and contained in an authorized Git repository;
arbitrary external worktree admission is still unsupported. The root HEAD is
captured/rechecked before issuance; root uncommitted contents remain mutable,
not an immutable source tree or sandbox. Foreign prerequisites use their separately
captured commit, not later source HEAD/uncommitted changes. Foreign Kubernetes
prerequisites remain refused by native cluster authorization. Unsupported
combinations fail before approval, never silently fall back. Referenced secret
values resolve only after approval. Runtime compatibility is not established by
policy-only tests; use real infrastructure only with separate authorization.

### Human/operator HTTP API

Call `serveEnvironmentOperator(controller.operations)` from the trusted embedding
host. It returns `{url, token, stop}` and listens only on `127.0.0.1`. Deliver its
fresh bearer token only to the operator frontend/operator, **never** to MCP tool
arguments/results, logs, URLs, cookies or agent environment variables. This helper
does not persist tokens; the daemon publishes it in a private file as described
below. No browser opens and no UI is supplied yet.

All requests require `Authorization: Bearer <operator-token>`. Foreign Host and
Origin are refused; cookies and query credentials do not authenticate. Responses
are no-store. There are at most eight in-flight requests; decision bodies are
limited to 4 KiB and five seconds.

- `GET /operator/operations?offset=0&limit=20`: bounded public summaries; no plan
  command text, HTTP body or SQL text. Only these single-valued query parameters
  are supported. Environment, HTTP and SQL requests use the same review journal.
- `GET /operator/operations/<id>`: explicitly inspect the exact immutable plan
  bytes, digest, revision and historical state. Treat contents as untrusted data.
- `POST /operator/operations/<id>/decision`: JSON `{requestId, digest, revision,
  decision: "approved" | "rejected"}`. Unknown fields, stale bindings and changed
  retries fail. An identical decision retry returns its current historical
  receipt, never new execution authority. Approval alone never runs a command.

### Scoped MCP tools

An embedding host authenticates the client, creates/selects a scope through
`controller.scopes.bind(authenticatedPrincipal)`, and supplies
`controller.bind(authenticatedPrincipal, scope.id)` as the optional second argument
to `createEnvironmentMcpServer(catalog, boundController)`. **Do not create a new
controller per client.** All clients must share the same resource authority.
The shared daemon performs this binding from operator-owned startup definitions.
The inspection mode without `--serve`/`--connect` still exposes only the catalog.

The bound server additionally advertises:

- `environment_action({action: "run" | "build" | "test", apps, requestId,
  target?, profile?, runtime?, replicas?, lifetime?, timeoutSec?})`: freezes a plan and returns
  `awaiting-approval`, not startup success. Reuse the same request ID only for
  the same intent. `target` accepts a configured ID or exact selection label.
  Kubernetes remains explicit; `replicas` is 1–16 and native target rules still
  apply. Public lifetime choices are the three agent modes above, never operator
  markers/lifetimes.
- `environment_action({action: "execute", operationId})`: after separate operator
  approval, rechecks scope/workspace/HEAD, journals issuance, starts the owned
  action and returns `issued`. It does not wait for readiness/completion. Replays
  return the existing receipt and never dispatch a second copy.
- `environment_action({action: "stop", requestId, apps?})`: stops only this bound
  scope's original live handles and pending acquisition/startup work. An identical
  retry is a historical receipt; it cannot cancel a newer generation. Cleanup
  uncertainty is not success and needs operator inspection.
- `environment_action({action: "close", requestId, revision})`: permanently fences
  this scope, interrupts pending unissued plans, and joins original cleanup.
  Obtain the scope revision from `env_status`. Replays are historical only.
- `env_result({operationId})`: immediate durable operation observation, not an
  implicit wait or polling loop. A `completed` operation means the attempt settled;
  parse its retained `result` JSON for `running`, `completed`, `failed` or `unknown`
  and real per-run exit/readiness evidence.
- `env_status({app?})`: bounded metadata for this scope only. It never restores
  resource authority from historical state. It returns the latest 20 matching
  observations with `historyWindow` counts. Receipts/status retain at most two
  provider status rows plus bounded endpoint/output/error excerpts; window and
  omission metadata distinguish absent evidence from excluded evidence. Complete
  resource IDs and URLs are never sliced to fit the budget.

## Parity and lifecycle boundaries

| Capability | Controller surface | Verification/remaining limit |
| --- | --- | --- |
| Catalog/discovery | Read-only stdio, HTTP and bridge | Explicit repository allowlist; no health claim |
| Run/build/test, stop/close | Scoped MCP with separate exact operator approval | Disposable shell exercised; original live handles only |
| Docker/Podman/Compose/Kubernetes/Helm | Existing native adapters behind controller | Native policy retained; live engines/clusters not certified |
| Foreign/shared prerequisites | Captured native dependency workspaces and lifetimes | Disposable shell pinned-commit/last-reference scenario |
| Logs and telemetry | Scoped MCP observations | Bounded/redacted; telemetry needs original live receiver |
| HTTP/SQL diagnostics | Scoped preparation, operator decision, separate execute | Loopback HTTP exercised; SQL guards reused, live PostgreSQL unverified |
| Definitions/promotion | Operator control routes only | Exact publication/replay exercised; native preflight/uncertainty fences retained |
| Recovery/revocation | Operator inspection, original-handle revoke, manual acknowledgement | No saved-handle adoption or automatic cleanup after restart |
| Human UI/review | Not implemented here | Operator HTTP API only; environment UI stays outside transcript |

Bindings are per configured client, **not automatically per OpenCode session or
subagent**. Generic MCP disconnect does not finish a job or release resources.
An orchestration adapter must explicitly close a scope on terminal job events;
idle expiry is a fallback, not proof that descendants finished. Operator-owned
infrastructure is exempt from idle expiry. Protected lifetime scope provisioning
is currently an embedding API, not an agent-selectable daemon option. No remote
auth/OAuth, external workspace authorization, credential rotation in place,
automatic state pruning or live native-host migration is supplied.

## Explicit stopped-host cutover

This is an operator procedure, not an operation performed by this change:

1. Stop admitting work to the old native host. Inventory its held apps,
   prerequisites, forwards, receivers and uncertain cleanup records. Save needed
   receipts/logs without copying credentials into agent context.
2. Stop resources through the old host while it still owns the original handles.
   Stop that host and verify its processes/listeners are gone. Manually inspect
   and clean uncertain leftovers using trusted runtime tooling. A saved PID,
   container name, cluster label or successful signal is not proof of cleanup.
3. Keep old native state as historical evidence. Do not copy its database,
   leases, receipts or process IDs into controller state, and never run both
   authorities over the same resources. Use a new private controller state
   directory outside authorized repositories; review explicit config/repository/
   client definitions and least-privileged secret references.
4. Start `--serve` as documented above/below. Provision distinct agent keys and
   keep the fresh operator access file private. No old approval carries forward.
   Inspect catalog and frozen plans; approve and execute a **new** operation.
   Validate your actual runtime separately before relying on live compatibility.
5. To roll back, first close/stop new scopes through this controller, stop it,
   and inspect uncertain resources. Only then restart the old host with new
   admissions/approvals. Never import new controller handles into the old host.

After a crash, confirm the previous controller is stopped and manually inspect
leftovers before removing only inspected stale lock/access files. Retain the
database. Reopen interrupts old scopes/approvals/issuances rather than rearming
them. Inspect each quarantined run by exact ID and revision; acknowledge only
after manual cleanup is confirmed. Acknowledgement clears the recorded barrier,
not the real resource, and cannot restore a previous host's handles.

### Operator control routes

The daemon's separate operator listener now also accepts `/operator/controls/`
routes using only the private operator bearer credential. Agent MCP credentials
are refused; these routes are not MCP tools. Query parameters are refused.
POST requests require JSON (maximum 512 KiB), with native per-field limits and
exact revision/content/request-ID fences still enforced. Errors are sanitized.

GET routes: `drafts`, `trees`, `preflights`, `promotion-attempts`, `promotions`.
POST routes: `drafts/read`, `drafts/save`, `drafts/capture-base`,
`drafts/save-source`, `drafts/remove-source`, `drafts/preflight`, `drafts/report`,
`drafts/promote`, `drafts/promotion`, `drafts/remove`, `drafts/release-tree`,
`drafts/release-temporary-tree`, `drafts/acknowledge-tree-cleanup`,
`drafts/acknowledge-attempt`. Read/report/promotion selectors take `{id}`; other
bodies use the existing native draft API contract. Staging never writes the live
definition file; promotion retains native exact approval and destination fences.
`POST recovery/acknowledge` takes `{runId, revision}` and only clears an exact
interrupted record after manual inspection; it does not clean up or adopt resources.

`GET recovery/runs` returns up to 200 recent run summaries with exact revisions,
owner, state and current revocation/acknowledgement eligibility. Use
`POST recovery/inspect {runId}` for an exact retained run outside that window.
`POST recovery/revoke {requestId, runId, revision, reason}` durably revokes the
run's **whole owner**, not just the selected app, and joins original-handle cleanup.
It refuses stale revisions and interrupted/saved-only authority. The native
receipt is content-bound; replay never adopts a resource or grants new authority.
Revocation permanently fences that owner; start a new configured scope to resume.

### Diagnostic tools

The shared/bridged endpoint additionally advertises these tools (never an
approval tool):

- `env_logs({app? | infra?, grep?, since?, tail?, service?, replica?})`: choose
  exactly one app/infra. Reads only this scope's already-redacted retained output.
  Grep is literal, tail is 1–1000 (default 200), and since is a strict ISO instant.
  Native 12 KiB/20-run windows, complete-line withholding, timing availability
  and omission counts remain authoritative. Exact Compose-service/Pod-replica
  reads never fall back to another source. Historical reads do not adopt resources.
- `otel_query({app, run?, mode?, view?, cursor?, traceId?, spanId?, http?, service?,
  rootKind?, limit?, since?, status?, name?, severity?, text?})`: original live
  ready receiver only, with native bounded trace/log tree/filter/cursor behavior.
  `run` optionally fences an exact current generation. Other owners, stopped/
  replaced receivers, unsupported metrics and external backends are refused.
- `env_http_request({requestId, app, endpoint, path?, method?, headers?, body?,
  allowWrite?, followRedirects?, authenticate?})`: prepares a frozen HTTP request
  for separate operator approval. Non-read methods require `allowWrite:true`,
  which is intent, **not approval**. No request is sent at preparation/approval.
  Native declared endpoint, same-origin redirect, verified TLS, configured frozen
  authentication-reference and current generation/prerequisite checks apply.
  Caller Authorization/cookies, arbitrary URLs/owners/connections are refused.
- `db_query({requestId, infra, app?, sql, schema?, limit?})`: prepares exact SQL
  review through this scope's live required PostgreSQL infrastructure. The native
  SELECT/WITH check, row limits, explicit requiring-app selection, verified TLS,
  frozen referenced credentials, read-only prepared transaction, rollback and
  no-resend fences remain mandatory. No caller connection or credentials.
  **READ ONLY is not a sandbox for privileged SQL functions**: review the SQL and
  configure a least-privileged database role.
- `env_diagnostic_history({run, kind: "http" | "sql", operation?, cursor?, limit?})`:
  retained exact-run/owner observations, not live authority. Select an exact
  operation or a cursor page, never both. MCP pages default/max to 50; legacy
  native callers retain their 200 default. Native cursors use the real page
  boundary, so smaller views do not skip undisplayed rows. Exact IDs remain
  readable outside the newest window. Summaries omit approved bodies/SQL/
  credentials; completed exact results are retained already-redacted data.

HTTP/SQL return an operation ID and `awaiting-approval`, using the same
digest/revision-fenced operator interface as environment actions. After approval,
call `environment_action({action:"execute", operationId})`. Dispatch uses the
**original prepared descriptor**, never a re-prepared replacement run. Both the
controller and native issuance journals prevent resend; interrupted calls stay
unknown/inspection-required, not automatically retried. Cancellation is not
rollback of a server-side write, and a completed HTTP diagnostic is not proof of
a successful application outcome—inspect its actual HTTP status/body.

`env_result` includes the operation kind and a retained diagnostic view/history
pointer. A large HTTP body may be explicitly omitted from this controller view
while the independently bounded native journal retains the original result;
presentation-budget loss does not invent uncertain execution. Use the returned
`history` selector with `env_diagnostic_history` to inspect owned retained data.
No historical result restores a request, database connection, receiver or lease.

No approval, principal, owner, raw shell command, caller connection or arbitrary execution plan is accepted
as a tool argument. No approval/revocation/quarantine tool is registered. Runtime
output is redacted by the existing adapters before bounded receipt retention;
nonzero build/test exits remain failures, not successful verification.

The internal `boundController.wait(id)` joins an execution already owned by this
host; it is available for embedding/tests, not advertised as a model polling tool.
Run resources remain held by their scope until explicit stop, scope close/idle
expiry, or
`controller.close()`. The embedding host must call `close()` before closing its
process; it aborts and joins owned work/cleanup before closing storage.

## Shared daemon and stdio bridge

Create an existing private, canonical, user-owned POSIX state directory outside
every authorized repository (mode 0700, or otherwise no group/other access).
Keep it separate from the previous host's state. Configure `environments.json`
as above. Create an explicit client-definition JSON file, at most 64 KiB:

```json
{
  "version": 1,
  "clients": [
    {
      "id": "editor",
      "repository": "/absolute/canonical/repo",
      "workspace": "/absolute/canonical/repo",
      "mode": "interactive",
      "idleMinutes": 30,
      "tokenEnv": "ENVIRONMENT_EDITOR_TOKEN"
    }
  ]
}
```

There may be 1–32 unique IDs. Mode is `job` or `interactive`; idle minutes are
1–43200. Paths must be canonical, absolute and contained in an authorized root.
Set each named environment reference to a distinct user-generated random token
(a 32-byte hex token works) in both the daemon and that client's environments.
Only URL-safe letters/digits/underscore/hyphen, 32–128 characters, are accepted.
Do not put real token values in repository files or command-line arguments.

Start one foreground daemon from `agentic-coding-v2/`:

```sh
bun run mcp --serve \
  --config-dir /absolute/config \
  --state-dir /absolute/private/state \
  --clients /absolute/client-definitions.json \
  --repository /absolute/canonical/repo \
  --port 4123
```

Repeat `--repository` for additional authorized roots. `--operator-port` is
optional; omitted ports use ephemeral loopback ports. Startup prints endpoint
and private-access-file paths to stderr, never credentials. Nothing is printed
on stdout in daemon mode, and no configured application starts automatically.
New scopes are admitted once from these definitions at startup, not per MCP
request/connection. Configuration/credential changes require restart. This is
local bearer auth, not an OAuth server or remote service.

The daemon creates `STATE_DIR/operator-access.json` exclusively, mode 0600, with
`{url, token}` for the separate human interface. The operator reads it through
their trusted UI/terminal; never share it with agents. Existing files are refused,
not overwritten. Normal SIGINT/SIGTERM shutdown drains listeners, removes only
the original unchanged access file, joins original resource cleanup, then releases
the state lock. After a crash or file replacement, verify the old host is stopped
and inspect resources before explicitly removing stale files/locks. Quarantined
records can be acknowledged through the operator recovery API only after manual
cleanup/inspection; **do not delete the database to force resource reuse**.

Clients supporting HTTP MCP can connect to `http://127.0.0.1:4123/mcp` with their
own bearer header. Operator credentials do not authenticate there, and agent
credentials do not authenticate on the operator API. Host/Origin checks and
64 KiB/five-second POST limits apply. The SDK serves modern per-request HTTP and
stateless legacy traffic over the same endpoint; a transport session is not an
execution scope or resource owner.

For stdio-only clients, use this generic launch definition in the outer MCP
configuration structure required by the client:

```json
{
  "command": "bun",
  "args": [
    "/absolute/checkout/agentic-coding-v2/src/mcp/cli.ts",
    "--connect",
    "http://127.0.0.1:4123/mcp",
    "--token-env",
    "ENVIRONMENT_EDITOR_TOKEN"
  ]
}
```

The bridge reads only that named credential, refuses URL credentials/query/
fragment and redirects, and forwards the known environment tools. It never opens
controller state, creates another controller/scope, or retries calls. Errors are
sanitized; inspect durable receipts before retrying interrupted calls. Closing
stdin closes bridge transports only, never resources or another client's work.

### Scope lifetime

Direct environment-tool use renews only the calling active scope. Operator
inspection does not. A once-per-minute sweep expires inactive job/interactive
scopes through the same durable close/cleanup path; pending execution/acquisition/
startup is protected. Operator infrastructure created through trusted APIs has
no agent idle deadline and requires explicit closure. Clock rollback does not
prove expiry. A transaction-line activity-sequence check refuses a raced expiry.
`env_status` exposes scope state/revision, idle policy and any latched sweep error.
Closed/interrupted scopes do not reactivate on reads or reconnect. A permanently
closed client needs a newly provisioned scope, not reuse of saved process IDs.
Scopes belong to configured client bindings, not automatically to each model
session or subagent. A harness integration can provision finer task ownership
later. Restart provisions fresh scopes; old receipts stay in operator history,
and uncertain resource generations remain blocked rather than adopted.

## Verification

`test/environment-mcp.test.ts` uses a disposable filesystem and the official SDK
client to launch the source entrypoint over stdio. It covers usable catalog and
discovery results, paging, metadata filtering, authorization/traversal refusal,
strict argument schemas, sanitized malformed-definition errors and the absence
of executable tools. A marker command is never executed. No running application,
real provider credential, MCP account, container engine or cluster is used.

Baseline before this change: **274 pass, 0 fail, 15.51s**; whole-project type-check
passed. Lint reported **24 existing errors** in concurrent review/UI changes.
Those files are not changed by the MCP implementation. Final batch measurements
and remaining gate blockers are recorded in the change's verification notes.

The controller foundation is covered by one additional disposable SQLite
scenario in `test/environment-controller.test.ts`: scope ownership and closure,
plan replay, exact approval, one-time issuance, original-permit completion,
rollback and reopen quarantine. Its resolver and completion receipt are fakes;
no configured command is executed. That milestone had 277 passing tests.
Its last measurement was 16.51s versus a 14.80s batch baseline; the new file
took 0.045s. The existing-scenario timing spread, concurrent edits and remaining
lint blockers are documented in the verification notes rather than treated as
a new accepted performance baseline.

`test/environment-execution.test.ts` adds one representative disposable Git/
SQLite/loopback-HTTP/SDK scenario and a tiny owned shell fixture. It checks exact
operator authentication/approval, no startup at admission/approval, single
dispatch, real unsuccessful exit, redaction, cross-scope refusal, cancelled
startup, stop replay safety, HEAD drift and historical receipts after reopen.
It uses no live application, account, model, container engine or cluster. See the
change verification notes for the complete batch result and cost comparison.

That scenario also exercises one real disposable loopback HTTP operation after
exact approval, no request before approval, redaction/history, no resend and
refusal after a replacement app generation starts. The fixture models the native
declared endpoint contract, **not socket-to-process ownership proof**. Owned log
and live empty-telemetry reads succeed; another scope cannot borrow them. SQL
normalization/refusal and the common approval/nonce/issuance journal have direct/
fake-prepared tests without a database. Those tests do not establish live
PostgreSQL driver compatibility; the native driver/transaction code is reused,
not replaced or certified by a fake completion acknowledgement.

`test/controller-runtime.test.ts` checks adapter readiness/ownership, encoded
receipt bounds and truthful queue/exit outcomes directly. Its one functional
scenario verifies captured foreign-worktree contents and shared last-reference
cleanup through actual disposable shell processes, without an agent harness.
A passing prototype Docker/Compose executable-fixture scenario cost over four
seconds and was converted to this narrower boundary. Container/Compose command
dispatch/cleanup and Kubernetes/Helm execution are **not asserted automatically
by that converted scenario**; native adapter code is reused/reviewed, but engine/
cluster compatibility needs separately authorized verification. No existing test
suite was deleted and no slower suite budget was accepted to hide that trade.
