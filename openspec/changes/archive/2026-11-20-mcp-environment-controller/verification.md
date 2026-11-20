# First milestone verification

## Scope

Implemented tasks 1.1–1.5 only: source-run read-only stdio MCP catalog and discovery.
Controller persistence/scopes, execution, operator approval, shared HTTP serving,
runtime migration, specialized tool wrappers and UI integration are not implemented.
No live application host was started, no existing resources/state were adopted,
and no real provider credentials, MCP accounts, engines or clusters were used.

The official SDK client launches the actual new stdio entrypoint against a
disposable directory. This is protocol-boundary coverage, not OpenCode TUI or
live-runtime compatibility certification.

## Gates

- New/changed MCP code, its test and package manifest: Biome passes with zero diagnostics.
- V2 whole-project `bun run type-check`: passes with zero errors.
- V2 `bun run lint`: blocked by 25 errors and 2 informational diagnostics in
  unrelated review/runtime/UI work. Before implementation it reported 24 errors
  and 2 informational diagnostics. A concurrent change to
  `src/server/client/index.ts` appeared after the initial working-tree snapshot
  and is included in the later formatting diagnostics. None of the MCP files
  appears in the final diagnostic set. No existing files were reformatted to
  hide this blocker. The repository-wide zero-diagnostic gate is not satisfied.
- Original `agentic-coding/` package lint (including boundary tests): passes;
  71 boundary tests pass, 0 fail.
- Original `agentic-coding/` whole-project type-check: passes.
- `openspec validate mcp-environment-controller --strict`: passes.

## Complete unfiltered v2 suite and cost

| Run | Tests | Failures | Total runtime |
| --- | ---: | ---: | ---: |
| Before implementation | 274 | 0 | 15.51s |
| After, alongside both packages' lint/type gates | 276 | 0 | 19.57s |
| After, isolated from this session's other heavy commands | 276 | 0 | 14.36s |

The isolated whole-suite run uses Bun's JUnit reporter for profiling without
excluding files, changing timeouts, retrying failures or changing concurrency.
The new test file costs 0.256s, of which the actual stdio scenario is 0.234s and
the pure launch-option rule scenario is below 0.001s. It starts one SDK/CLI
fixture, not a native agent harness or runtime/engine. No repeated native setup
was introduced. The first focused run, including cold imports, took 0.95s.

The aggregate baseline has no saved per-file/per-case timings, so a precise
before/after attribution for existing cases is unavailable. The 19.57s run was
contended by this session's simultaneous legacy boundary tests, both type-checks
and linting; the isolated result is within the existing 12–15s working budget.
Unrelated working-tree changes were also being edited concurrently. These
measurements do not establish a speedup or normalize 19.57s as the new baseline.

Logs/JUnit output were saved under the approved OpenCode temporary directory:
`mcp-environment-baseline.log`, `mcp-environment-final-tests.log`,
`mcp-environment-final-isolated-tests.log`, `mcp-environment-final-junit.xml`,
`mcp-environment-final-lint.log`, `mcp-environment-legacy-lint.log` and
`mcp-environment-legacy-types.log`.

## Next boundary after the first milestone

Task 2.1: extract environment transactional storage and owner lookup from native
Harness/documents. Mutating MCP tools must remain unavailable until scopes,
exact-plan human approvals, issuance fences and original-live-handle cleanup are
implemented. Preserve the concurrent native runtime/review work rather than
rewriting it as part of this milestone. Resolve the existing lint blocker before
claiming the overall change is ready for completion/archive.

# Controller foundation verification (tasks 2.1–2.3)

## Scope and compatibility

- Added the transport/runtime-independent environment document/owner persistence
  port and a native Harness adapter. Existing environment document kinds,
  versions, checkpoint policy and transaction-local owner cancellation checks
  remain unchanged. The native manager, acquisition, revocation, draft and
  HTTP/SQL issuance paths use the port. The native host is still the execution
  owner; it has not been replaced by the standalone controller.
- Added private standalone SQLite storage, principal-bound controller scopes,
  captured workspace identity and explicit job/interactive/operator policies.
  Idle durations are recorded, not swept or enforced by a standalone daemon.
  Scope closure only fences new work; it does not assert resource cleanup.
- Added immutable operation admissions/disclosures, content-bound request
  identity, exact-plan digest/revision-fenced decision records, issuance permits
  and conservative reopen handling. The operator decision API is internal,
  not an authenticated public endpoint. Principal binding accepts trusted
  server-side authentication context, not model-authored identities.
- No MCP tools were added: the advertised surface remains `env_list` and
  `env_discover`. No runtime command was dispatched by the new controller.
  Authenticated operator transport, real target-plan resolver binding, Git/ref
  admission checks, original-live-handle runtime dispatch/cleanup, external
  worktree admission and shared MCP transport remain unfinished.

The new disposable SQLite scenario covers scope ownership, operator-role
refusal, immutable plan replay after configuration changes, stale approval,
single issuance, refusal of copied completion permits, transaction rollback,
closure fencing, historical completion results, workspace replacement and
interrupted issued operations after close/reopen. The supplied plan resolver
and completion acknowledgement are fixtures; this establishes no live runtime
compatibility. The unchanged native environment scenarios also run in the full
suite using their existing fixtures. No credentials, real accounts, engines,
clusters or running user applications were accessed.

## Gates

- Whole-project v2 type-check: passes with zero errors.
- Biome over all 21 added/edited controller, persistence and environment/provider
  files plus the new test: passes with zero diagnostics. The runtime wiring was
  changed surgically, preserving pre-existing review/runtime edits.
- Full v2 lint at verification: four formatting errors in concurrent user work:
  `src/server/client/index.ts`, `src/tui/features/sessions/HumanInteractionCard.tsx`,
  `src/tui/features/sessions/Questionnaire.tsx` and `src/tui/shell/App.tsx`.
  No new persistence/controller file appears in those diagnostics. The earlier
  milestone reported 25 errors; these files were being edited/formatted outside
  this change. Do not claim a repository-wide clean lint gate yet.
- OpenSpec strict validation: passes.
- Original `agentic-coding/` package background checks completed successfully:
  whole-project type-check passes, lint has zero diagnostics, and all 71 lint
  boundary tests pass (0 failures, 8.31s).

## Unfiltered suite and performance review

| Run | Tests | Failures | Runtime |
| --- | ---: | ---: | ---: |
| Before controller extraction | 276 | 0 | 14.80s |
| After extraction and controller journal | 277 | 0 | 19.47s |
| Diagnostic repeat, no other heavy command from this session | 277 | 0 | 16.51s |

All three runs save JUnit per-file/per-case timings. No tests were excluded,
timeouts changed, retries added or concurrency settings changed. The repeat is
reported alongside the first result, not substituted for it. The suite remains
above the 12–15s working target; **16.51s is not accepted as a new baseline**.

The new test file took 0.047s on the first after-run (0.028s in the actual case)
and 0.045s on the diagnostic repeat. It creates one disposable SQLite controller,
not an agent harness/HTTP runtime/engine per validation input. There is no
repeated native setup cost introduced by the new scenario.

Largest existing file deltas on the repeat compared with the saved baseline:

| File | Before | Repeat | Delta |
| --- | ---: | ---: | ---: |
| `review-submit.test.ts` | 0.358s | 0.738s | +0.380s |
| `promotion-sources.test.ts` | 0.553s | 0.921s | +0.368s |
| `task-retention.test.ts` | 0.604s | 0.912s | +0.308s |
| `source-base.test.ts` | 0.658s | 0.887s | +0.229s |
| `wiki.test.ts` | 0.304s | 0.497s | +0.192s |
| `batch-conflicts.test.ts` | 0.499s | 0.657s | +0.158s |

On the first after-run the largest case increases were the pre-existing review
submission (+0.666s), viewpoints (+0.413s), HTTPS diagnostic (+0.318s) and native
skill admission (+0.240s) scenarios. The spread and run-to-run variation extend
beyond the new controller fixture, including unchanged native-host scenarios.
Unrelated review/runtime files were being edited concurrently. These observations
limit attribution: they do not prove either that the persistence adapter caused
the remaining slowdown or that it has no performance impact. Keep the saved
profile for a controlled follow-up rather than silently relaxing the budget.

Artifacts in the approved OpenCode temporary directory:
`mcp-storage-before.log` / `.xml`, `mcp-storage-after.log` / `.xml`,
`mcp-storage-after-isolated.log` / `.xml`, and `mcp-storage-final-lint.log`.

## Next boundary

Task 3.1: provide the authenticated operator-only approval interface. The internal
role-bound decision service is ready for that adapter, but it does not itself
authenticate a caller. Do not expose mutation tools before the approved owned
shell run/build/test and live-handle cleanup path is implemented. Resolve or
explicitly account for the unrelated full-lint blocker and remaining suite-cost
attribution before calling the overall change complete.

# First owned shell milestone (tasks 3.1–3.3)

## Implemented boundary

- Added a separate loopback-only bearer-authenticated operator HTTP adapter for
  bounded operation listing, exact frozen-plan inspection and digest/revision-
  fenced approval/rejection. Cookie/query credentials, foreign Host/Origin,
  unknown decision fields and stale decisions are refused. Approval does not
  dispatch; no approval/revocation tool is registered with MCP. No UI/browser
  launch or credential persistence is introduced.
- Added `EnvironmentController`, composing the existing manager/queues/shell
  adapter with standalone persistence and scope ownership. Bounded definition
  reading is shared with the catalog adapter, not duplicated. Admission captures
  source HEAD; execution rechecks it and workspace/owner before durable issuance.
  Referenced values resolve only after approval. Output uses the existing shell
  redactor; unsuccessful build/test exits remain failed results.
- Explicitly bound embedded MCP servers can register `environment_action`,
  `env_result` and `env_status`. The host must authenticate and fix the principal/
  scope before registration. Execute returns an issued receipt while owned work
  finishes asynchronously. The default source-run stdio CLI still advertises
  only catalog/discovery; shared authenticated MCP serving/bridge is stage 4.
- Stop validates request identity before aborting work and replays successful
  receipts as history without cancelling newer generations. Only original
  manager handles can clean up; workspace replacement/scope closing does not
  prevent same-host cleanup. Historical result/stop receipts do not restore
  resource authority. Close aborts and joins owned cleanup before closing storage.

The subset is POSIX shell/systemshell in canonical repository-contained Git
workspaces, including existing same-workspace coupled dependency behavior.
Other runtimes, dependency workspaces, optional lifetime modes and telemetry are
refused. Uncommitted files remain mutable; HEAD checks are not an atomic source
snapshot or an OS sandbox. Automated scope expiry/closure, broader diagnostics,
recovery acknowledgements and specialized UI remain unfinished.

## Verification scope

One new representative disposable scenario uses a private Git repository and
SQLite store, the official MCP SDK in-memory client/server, a real ephemeral
operator HTTP listener and a tiny disposable shell child. It combines successful
run readiness, actual exit-code-3 test failure, authenticated human rejection,
startup cancellation, source HEAD drift, cross-scope result/stop refusal,
redaction, idempotent execution/stop and historical receipts after reopen.
It also verifies that no process starts at admission or approval, that secret
references need not resolve before approval, and that agent-authored owner fields
cannot widen scope. Startup cancellation waits on an actual filesystem event;
it never waits out the target's readiness timeout.

No real application, credential/account, provider model, MCP account, container
engine or cluster was used. This is a real disposable shell/protocol boundary
test, not live infrastructure/OpenCode UI compatibility verification. Existing
native fixture suites continue to exercise their original boundaries.

## Gates and measurements

- V2 whole-project type-check passes with zero errors.
- Full V2 lint now passes with zero diagnostics (815 files at the measured run).
  The earlier unrelated UI formatting blockers were resolved concurrently; this
  change did not rewrite those UI files.
- Focused catalog/controller/execution scenarios pass: 4 tests, 0 failures.
- OpenSpec strict validation passes.
- Saved pre-batch unfiltered baseline: **279 pass, 0 fail, 16.79s**. The baseline
  was already above the 12–15s working target. The test count differs from the
  previous batch because unrelated tests were edited concurrently; the baseline
  is retained, not rewritten to the earlier 277 count.
- Final unfiltered run: **280 pass, 0 fail, 19.04s**. The new execution file
  costs **0.391s**. The remaining +1.87s relative to the 16.79s baseline is spread
  across existing scenarios: shell URL readiness +0.309s, promotion sources
  +0.244s, definition source check +0.237s, promotion uncertainty +0.210s,
  review submission +0.208s and draft staging +0.187s. No repeated native setup
  was introduced by the single new boundary scenario. Concurrent unrelated edits
  and run-to-run I/O variation limit attribution; do not normalize 19.04s as an
  accepted baseline or claim the existing suite-cost issue is resolved.
- Original-package background gates also passed: type-check has zero errors,
  lint has zero diagnostics, and 71 boundary tests pass (0 fail, 13.37s).

Temporary artifacts use the `mcp-execution-before`, `mcp-execution-after` and
`mcp-execution-final-lint` prefixes in the approved OpenCode temporary directory.

## Next boundary

Task 4.1: shared authenticated loopback MCP serving. The programmatic controller
and separate operator API are ready, but do not expose principal/role/scope
creation as arbitrary model fields or launch independent controllers per client.
Keep the default stdio command read-only until the shared transport and explicit
bridge binding are implemented.

# Shared transport and scope lifecycle (tasks 4.1–4.3)

## Implemented boundary

- Added authenticated numeric-loopback MCP HTTP serving with fixed token-to-
  principal/scope bindings, Host/Origin checks, 64 KiB/five-second POST limits,
  bounded in-flight/subscription counts, no-store responses and explicit draining.
  SDK per-request server instances all share the same controller. Agent and
  operator credentials cannot authenticate on the other interface.
- Added a tools-only source-run stdio bridge. It reads an explicitly named
  credential environment reference, refuses remote/credential-bearing URLs and
  redirects, forwards the known tool schemas/results and cancellation, and closes
  only its transports on EOF. It does not start a resource controller, create a
  scope or retry calls. The already pinned SDK client is now a production
  dependency; the lockfile was regenerated with install scripts disabled.
- Added a foreground `--serve` CLI with bounded operator-owned client definitions
  and a fresh private operator access file. It refuses to overwrite an existing
  file and removes only its original unchanged file at shutdown. The operator
  capability never appears in URLs, stdout, diagnostics or agent credentials.
- Added revision/content-bound explicit scope closure and once-per-minute idle
  cleanup through the existing manager's original live handles. Live startup
  authority is fenced on the transaction line; persistence failure never unfences
  it. Pending unissued plans are interrupted, in-flight work is protected from
  idle expiry, operator infrastructure has no agent idle deadline, and activity
  sequence checks refuse raced expiry. Disconnect does not close a scope.
  Cleanup uncertainty stays interrupted/inspection-required. Sweep errors are
  latched in status rather than treated as successful expiry.

## Verification scope

The existing execution boundary scenario was extended from SDK in-memory
transport to authenticated HTTP plus an actual source-run stdio bridge, retaining
one Git/SQLite/shell fixture rather than repeating native setup per refusal. Two
credentials share one controller; foreign-scope reads/stops fail and bridge
disconnect leaves the original app running. The same scenario verifies explicit
close, activity/in-flight protection, actual idle cleanup using a supplied clock
instant (no deadline wait), protected operator scope and historical close/stop
receipts. A small direct rule test covers clock rollback and expiry policy.

One additional lightweight CLI boundary scenario starts an empty-catalog daemon
in a private disposable directory with a private HOME and fake token. It checks
real HTTP/SDK access, distinct operator authentication, mode-0600 access data,
credential-free diagnostics/stdout and clean SIGTERM file/lock release. It does
not start an application, engine, model or native agent host. No fixture is
repeated for argument-validation permutations; those use direct parser tests.
The access-file replacement/namespace-race guard is code-reviewed, not claimed
as protection against a hostile same-user filesystem writer or as a live-engine
crash certification. No user credentials/accounts or running apps were used.

## Gates

- V2 whole-project type-check: zero errors.
- Full V2 lint: zero diagnostics (822 files at the measured run).
- Focused catalog/controller/execution/daemon scenarios: 6 pass, 0 fail.
- OpenSpec strict validation: passes.
- Final complete-suite measurement: **283 pass, 0 fail, 15.84s**, compared with
  the preceding **280 pass, 0 fail, 19.04s**. The increase is one direct idle-rule
  case, one CLI boundary case and one concurrently added `human-rules` case.
  The original 12–15s target remains unchanged; 15.84s is slightly above it and
  is not silently accepted as a new budget. The faster total does not establish
  an implementation speedup given concurrent edits and I/O/load variation.
- JUnit costs: the extended HTTP/bridge/execution scenario file is **0.736s**
  (was 0.391s); the new empty-catalog CLI boundary is **0.526s**. The controller
  file including the pure idle rule is 0.029s (was 0.042s), and inspection/parser
  tests are 0.269s (was 0.387s). Thus the extra transport/lifecycle boundary work
  has explicit measured cost, not repeated native fixtures per validation input.
  Largest other positive existing-file deltas are draft-source tool +0.193s,
  log timing +0.081s, batch conflicts +0.023s and repeated start +0.020s;
  remaining existing-file timing reductions dominate the aggregate change.
- Original-package background checks completed: whole-project type-check and
  lint pass, including **71 boundary tests, 0 fail, 11.21s**.

Artifacts use the `mcp-transport-after` and `mcp-transport-final-lint` prefixes in
the approved OpenCode temporary directory. Setup/invocation/limits are documented
in `agentic-coding-v2/MCP.md`; no user MCP configuration was installed or changed.

## Remaining work

Tasks 5.1–5.4 remain: broader runtime/dependency parity, scoped diagnostics,
operator-only definitions/recovery controls and final parity/cutover documentation.
Do not claim full parity, production/live-engine compatibility or automatic
native-state migration. Client bindings are not automatically per-model-session
or subagent tasks; finer harness lifecycle adapters remain separate work.

# Runtime and dependency delegation (task 5.1)

## Implemented boundary

- Replaced the shell-only guard with a shared controller plan policy over native
  runtime/lifetime/ownership rules. Existing Docker/Podman, strict Compose,
  Kubernetes pod/Deployment and Helm-release adapters are selected through the
  same manager; no second engine/cluster orchestration implementation was added.
- Kubernetes plans capture explicit cluster connection references before human
  review. Helm chart captures, UID/release receipts, native source drift checks,
  telemetry startup/cleanup and unsupported-combination refusals remain native
  behavior. Public inputs now carry explicit runtime, replica and agent lifetime
  selection, plus exact configured target labels. Protected infrastructure
  lifetimes remain trusted-operator-only; their administrative controls are
  still part of task 5.3.
- Journal ownership accepts the manager's original owner-bound prerequisite
  workspaces, not arbitrary foreign paths. Foreign source commit/common-directory
  identity is captured at admission, while worktree realization stays after
  approval/reservation. Root HEAD pinning remains separate. Foreign Kubernetes
  prerequisites keep the existing repository-authorization refusal.
- Added truthful outcome classification and bounded provider observations. Queue
  receipts without runs are not startup success; exited runs are not reported
  live; failed exits and unsettled effects remain failed/unknown. Receipt excerpts
  have encoded-byte bounds, preserve complete resource IDs/URLs and report
  omissions. Status returns the latest 20 matching observations with counts.

## Verification scope and explicit trade-off

The new direct tests exercise supported adapter prerequisites, owner/refusal
rules, queue/exit outcome classification and encoded receipt limits. One public
controller scenario uses two authorized disposable repositories and three small
shell processes to verify private foreign commit execution, no uncommitted-file
copying/developer-checkout execution, shared generation reuse and last-reference
cleanup. It rejects a foreign root project even though that repository is
authorized for declared prerequisites. There is no native agent harness.

A prototype scenario with the existing Docker/Compose executable fixture passed
but cost **4.36s** including cold imports/CLI setup. It was converted to the
focused shell/dependency scenario rather than retaining repeated engine/CLI
mechanics merely to re-prove the controller's data policy. **Container/Compose
command dispatch/cleanup is no longer asserted automatically by that prototype's
converted scenario**. Kubernetes/Helm runtime execution is also not certified by
policy-only data tests. Those paths are reused/code-reviewed and need separately
authorized compatibility verification; no real engine, cluster, credential or
account was used. No existing suite was deleted or hidden.

## Gates and full-suite cost

- V2 whole-project type-check: zero errors.
- Full V2 lint: zero diagnostics (826 files).
- Focused controller/runtime/transport/daemon tests: 10 pass, 0 fail.
- OpenSpec strict validation: passes.
- Complete unfiltered before: **283 pass, 0 fail, 15.77s**.
- Complete unfiltered after: **287 pass, 0 fail, 16.09s**.
- New file: **0.446s**, including **0.445s** for the foreign/shared-shell scenario;
  the three direct rule cases together cost under 0.001s. No scenario table row
  creates repositories, engines or hosts. The net full-suite increase is 0.316s,
  with normal existing-file variation: mermaid vendor +0.163s, daemon +0.111s,
  promotion sources +0.107s, wiki +0.066s and discovery +0.063s were the largest
  positive existing-file deltas; other existing cases were faster.

The 12–15s working target is unchanged. The baseline already exceeded it, and
16.09s is not normalized as a new budget. All files ran with unchanged timeouts,
no retries/exclusions and no unsafe concurrency. Concurrent unrelated edits and
host I/O/load limit exact attribution. Logs/JUnit profiles use the
`mcp-runtime-before`, `mcp-runtime-after` and `mcp-runtime-final-lint` prefixes in
the approved OpenCode temporary directory. Original-package gate checks ran
separately after the timed suite: lint/type-check pass, including 71 boundary
tests with 0 failures in 12.74s.

## Next boundary

Tasks 5.2–5.4 remain: owner-scoped diagnostic tools with exact HTTP/SQL approvals,
operator-only staged definitions/recovery controls and final parity/cutover
documentation. Do not equate adapter delegation or passing policy tests with
live-engine compatibility or full native UI/lifecycle parity.

# Scoped diagnostics (task 5.2)

## Final operator/cutover batch (5.3–5.4 complete)

Completed operator recovery metadata inspection (200 recent summaries plus exact
retained run lookup) and explicit native whole-owner revocation delegation. The
native original-handle/revision/request-identity fences are unchanged; interrupted
records cannot be revoked by saved identity. Manual acknowledgement still only
clears an exact interrupted record after external inspection, never actual cleanup.
No new operator tools were registered with MCP. The daemon fixture now exercises
wrong promotion approval refusal, exact publication, immutable replay and actual
published bytes, empty recovery inspection and unknown-run revocation refusal.
Native successful live revocation/cleanup is delegated and reviewed, not newly
certified by that empty-run fixture. No live engine/cluster/database was used.

`MCP.md` now contains the final implemented-surface parity matrix, remaining
session/subagent lifecycle and UI/auth/workspace gaps, plus explicit stopped-host
cutover, rollback and crash/quarantine instructions. This completes the planned
extraction surface, not full UI/live-runtime parity. No cutover was performed;
no config installed, resources adopted, state deleted or commits made.

Validation: both packages' lint and whole-project type-check pass. Original-
package boundaries: 71 pass, 0 fail, 9.97s. Strict OpenSpec validation passes.
Complete unfiltered V2 suite: **289 pass, 0 fail, 17.77s**. Comparison baseline
is the preceding saved batch (289 pass, 0 fail, 17.08s), not a newly captured
pre-edit run. The suite remains above the unchanged 12–15s target; no timeout,
retry, exclusion or concurrency settings changed. Daemon scenario increased from
0.534s to 0.590s (+0.056s) for promotion/replay assertions without new fixture
startup. The largest existing-file changes were source-base +0.605s and
mermaid-vendor +0.180s; repository-access +0.073s, preflight-request-fences +0.070s,
definition-discovery +0.063s and staged-removal +0.062s. Other cases were faster;
unrelated concurrent changes and load limit attribution. This is not a new suite
budget or a claim of performance improvement. Final log/JUnit artifacts use
`mcp-cutover-after` in the approved temporary directory.

## Subsequent operator-control increment (5.3 still open)

Added an explicit native-draft allowlist behind the existing independently
authenticated operator listener and wired it into daemon bootstrap only. It
delegates staging/source/preflight/promotion/tree-cleanup and acknowledgement
operations to native methods; no dynamic method lookup or MCP tool was added.
POST bodies are byte-bounded JSON, query parameters refused, and native revision,
request identity, approval and destination checks remain authoritative. Recovery
acknowledgement delegates the exact interrupted-run/revision guard; it is not
cleanup or live adoption. The daemon fixture now verifies agent-token refusal,
operator staging/read, revision-conflict refusal, absence of live-file writes
while staging and refusal to acknowledge an unknown run.

This increment does not complete 5.3: operator recovery inspection/revocation
and representative promotion-boundary verification remain pending. Task 5.4's
final parity/cutover documentation is also still open. No live infrastructure or
credentials were used. All changes remain uncommitted.

Both packages pass lint and whole-project type-check; original-package boundary
tests: 71 pass, 0 fail, 7.34s. Focused daemon/execution: 2 pass, 0 fail, 1.79s.
Complete unfiltered suite before: 288 pass, 1 fail, 19.82s (existing runtime
worktree test exceeded its unchanged 5s timeout). After: 289 pass, 0 fail, 17.08s.
These are separate batch measurements, not retries hiding the baseline failure.
The 12–15s working target is still exceeded. Daemon fixture cost changed from
0.517s to 0.534s; runtime file changed from 5.112s with timeout to 0.568s, so total
cost difference cannot be attributed to this increment. Concurrent changes and
machine load limit comparisons. No timeout/retry/exclusion/concurrency changes.
Artifacts: `mcp-operator-before` and `mcp-operator-after` log/XML files in the
approved OpenCode temporary directory.

## Implemented boundary

- Added `env_logs`, `otel_query`, `env_http_request`, `db_query` and
  `env_diagnostic_history` to explicitly bound shared/bridged MCP servers. Default
  standalone inspection still exposes only catalog/discovery. The bridge's known
  tool allowlist was extended explicitly, not replaced by arbitrary forwarding.
- Logs and telemetry delegate with the transport's fixed owner. Native literal
  grep/timing/source/byte windows, replica/service refusal, redaction, receiver
  availability and exact generation/prerequisite checks remain authoritative.
- HTTP/SQL share the existing controller admission/approval/issuance state machine
  through one prepared-record path. Kind-tagged snapshots capture normalized
  inputs and the original native descriptor, not a mutable future selection.
  HTTP header normalization is order/case stable. Shared review disclosures were
  extracted verbatim for native tools and controller use. Operator summaries
  withhold HTTP bodies/SQL text; exact authenticated inspection shows the review.
- Admission and human approval perform no HTTP request or database query. Separate
  execution journals generic issuance once and then calls the native request API
  with the frozen descriptor, stable native issuance ID/input and cancellation.
  Both journals remain mandatory. Dispatch never follows a replacement app by
  re-preparing; failed/interrupted issuance is unknown/inspection-required, not
  automatically retried. SQL READ ONLY remains a write fence, not a sandbox for
  privileged functions; its driver/credential/TLS/rollback implementation is
  unchanged.
- Completed receipts include a bounded diagnostic view plus an exact native
  history pointer. Omitting a large already-redacted HTTP body for presentation
  does not invent uncertain execution. Historical tools authorize own run/owner
  before native projection. Native history gained an optional page limit with
  its legacy 200 default unchanged; MCP defaults/maxes to 50, preserving actual
  cursor boundaries rather than slicing away unseen rows.

## Verification scope

The existing controller/HTTP/bridge fixture was extended, not recreated per
refusal. It verifies owned redacted logs, a live empty native telemetry query,
foreign-scope observation denial, a real disposable loopback HTTP operation only
after exact approval, one send despite replay, already-redacted native history,
and refusal of an old descriptor after a new ready app generation replaces it.
The declared endpoint fixture is not socket-to-process ownership certification;
that limitation is explicit in the unchanged native disclosure. No real app,
account, provider, engine, cluster or credential is used.

SQL uses direct production normalization/refusal tests and the existing disposable
scope/journal scenario with a clearly fake prepared request/completion. It checks
kind/identity, SQL-text withholding, immutable replay and approval/one-time
issuance without opening a database. This does **not** certify PostgreSQL driver
compatibility. Native SQL guard/driver code is delegated and code-reviewed, not
replaced with a test simulation or claimed live-tested. Existing native HTTP and
SQL refusal suites remain intact.

The three smaller-page history assertions extend the pure pagination scenario;
no database, runtime or gateway is stood up for a validation/windowing table.
The two new direct cases cover canonical diagnostic input/refusal and encoded
result-budget loss versus uncertain execution.

## Gates and measurements

- V2 whole-project type-check: zero errors.
- Full V2 lint: zero diagnostics.
- Focused diagnostics/history/controller/transport/native-guard tests: 33 pass,
  0 fail.
- OpenSpec strict validation: passes.
- Complete-suite before: **287 pass, 0 fail, 16.78s**. Complete-suite after:
  **289 pass, 0 fail, 16.24s**. The unchanged 12–15s target remains slightly
  exceeded; this is not accepted as a slower budget or claimed as a speedup.
  No timeout, exclusion, retry or concurrency setting was changed.
- JUnit costs: new direct diagnostic cases together cost **0.001s**; the extended
  real HTTP/bridge/execution scenario costs **0.782s** (was 0.738s), scope/journal
  including the SQL fake-prepared path **0.036s** (was 0.077s), and native history
  including smaller-page assertions **0.002s** (unchanged). No repeated native
  fixture/database setup was added per input. The largest existing-file increases
  were promotion sources +0.075s, ownership +0.053s, nested agents +0.052s,
  standalone +0.045s and inspection +0.045s; other existing cases were faster.
  Concurrent unrelated edits and normal I/O/load variation limit attribution.
- Original-package gates ran separately after the timed suite: lint and whole-
  project type-check pass, including **71 boundary tests, 0 fail, 9.99s**.

Logs/JUnit output use `mcp-diagnostics-before`, `mcp-diagnostics-after` and
`mcp-diagnostics-final-lint` prefixes in the approved OpenCode temporary directory.

## Next boundary

Tasks 5.3–5.4 remain: operator-only staged definitions/recovery controls and final
parity/cutover documentation. UI wrappers and live-infrastructure acceptance are
not part of this diagnostics milestone.
