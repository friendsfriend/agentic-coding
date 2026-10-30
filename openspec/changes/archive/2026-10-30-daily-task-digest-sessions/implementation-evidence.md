# Implementation and focused verification evidence

## Scope and implementation

- Named workflowless sessions use the private versioned `pi-durable/sessions.json` metadata registry; native pi-durable remains the only transcript/report history. Explicit creation receipts, exact continuation, OS-user custody, pinned defaults, tombstones and legacy adoption are implemented.
- The sidebar routes named pins to their exact native session, independently of Home and workflow agents. Background recovery uses `select:false`; stale completions do not override newer selection intent.
- Read-only persistent session destinations extend the existing standalone target, strict contract, adapter registry and scheduler admission/receipt protocol. They do not create workflows, per-occurrence worktrees or a parallel scheduler.
- Collection authority is enforced at native selection and direct/nested imported-tool execution. GitLab queries require discovered local project membership and an explicitly pinned integration host. The actual provider-specific `project`/`project_id` argument is checked; alternate-alias/default-project smuggling is denied. Wiz generic dispatch checks reviewed inner methods.
- Typed actual-JSON page adapters normalize Jira event evidence, new Wiz findings and verified Renovate MRs. Deterministic rendering filters/deduplicates evidence, classifies conservatively, suppresses unsafe links and includes explicit coverage, source counts and observed status/severity/exposure. Missing primary-source coverage cannot imply successful empty results.

## Task evidence map

| Tasks | Main implementation and focused evidence |
| --- | --- |
| 1.1–1.2 | `src/pi-durable-registry.ts`, `src/agent-host/pi-durable-session.ts`; registry/state/recovery/lifecycle tests cover legacy adoption, corruption/future versions, unsafe files, interrupted temporary writes, immutable bindings, retry receipts, real native creation/recovery, pinned defaults/config-root propagation and slow concurrent selection. |
| 1.3, 4.2 | `App.tsx`, `sidebar-model.ts`, `PiDurableView.tsx`; rendered `workspaceSidebar.test.tsx` exercises exact named pins and native retained reports, background delivery without Home insertion/focus theft, switching/reopening and original Orchestrator pins. No keybind was added or changed. |
| 2.1, 2.3 | Collection extension/policy, bounded repository discovery and native bridge enforcement; `daily-digest.test.ts` and fake MCP tests cover read-only denials, nested dispatch, remote canonicalization/deduplication, host binding and consumed-argument scope checks. |
| 2.2, 2.4–2.7 | `daily-digest.ts`, `digest-sources.ts`, `digest-report-tool.ts`, `digest-pagination.ts`; source/coverage tests cover real-shaped pages, event identities, nested pagination gaps, first-seen versus updated, verified bot identity, field uncertainty, outages, unsafe links, source omissions and no private body copying. |
| 3.1–3.3 | Strict scheduling contracts/API and session adapter; exact-session routing test covers restart/lost acknowledgement, foreign/replaced/deleted destinations, revoked custody, unavailable models and operator-only mutations. Shared scheduler store/service/admission regressions cover claim/reservation/admission cancellation, fences, busy compaction/restart, occupancy/no-overlap and crash/lost-ack reconciliation. Those primitives are reused, not forked into a new crash matrix. |
| 3.4, 4.3 | Self-contained task/nonactivated proposal, CLI lifecycle and documentation; setup tests validate strict job decoding, explicit defaults and Berlin weekday spring/autumn DST previews and Monday's 24-hour window. |
| 4.1 | The rendered `background native reports` test in `workspaceSidebar.test.tsx` now composes authenticated SchedulingApi → real SchedulingService/Store → workflowlessSessionAdapter → on-disk fake-model DurableHost → paginated loopback MCP/codemode → actual-response normalization/rendering → exact native answer receipt → rendered named sidebar report. It loses activation acknowledgement, restarts host/store, reconciles one retained answer without repeating collection, preserves Home/focus and reopens history. `daily-digest-native.test.ts` additionally covers the native projection boundary. Native IPC is an in-process seam, not a spawned production service. |
| 4.4 | Finishing gates below. Full repository suite remains owned by the workflow test-verifier. |

## Baseline finishing gates (prior implementation run)

Executed from `agentic-coding/`, using explicit focused files/name filters, not the complete repository suite:

- `bun run lint`: zero diagnostics; its six required architecture/boundary test files passed (71 tests).
- `bun run type-check`: zero errors.
- Focused session/digest/scheduler/native regressions: 113 tests across 17 files, zero failures.
- Focused existing native bridge/default/read-only/orchestrator regressions: 3 passed.
- Focused existing stage-login credential-boundary regressions: 2 passed.
- Rendered sidebar/native-report/preserved-Home acceptance: 4 passed.
- `bun run build`: succeeded. Embedded instructions and bundled Playwright metadata were regenerated only through build, with no tracked generated-file diff.
- `openspec validate daily-task-digest-sessions --strict`: valid.
- `git diff --check`: clean.

No matching environment build/test app target is configured for this package (`agentic-coding` was not listed), so focused package commands were used in this managed checkout. The workflow run's validation log records the commands' output.

## Verifier fix pass

All eight reported findings (eight verifier outputs, quality and migration had no findings) were addressed:

| Finding | Fix and deterministic evidence |
| --- | --- |
| USABILITY-001 | Retry-stable discriminated default names, immutable ID prefixes in pins and selected transcript header; rendered acceptance creates/reopens two actual `/new` sessions and distinguishes/reopens duplicate explicit names. |
| CONCURRENCY-001 | Scheduled activation joins the existing conversation mutation queue, rechecks owner and closing fence inside it; shutdown's stop joins the same queue. `scheduling-session-races.test.ts` holds the existing stop boundary during abort and shutdown to prove activation cannot pass cleanup; abort then yields a retained successful answer. Existing ordinary abort/submit tests remain regression coverage. |
| CONCURRENCY-002 | Supported deletion persists native revocation in the activation queue before metadata tombstone/acknowledgement. The race test deletes after adapter open/bind and before activation, proves no model call/input and visible rejection, and proves revocation survives native restart. |
| SEC-001 | Current protected old/new job authorization is repeated inside the committing synchronous mutation; referenced validated revision is pinned across asynchronous validation. Five deferred-validation cases cover create/update, old/new protected references and operator revision conflicts without schedule mutation. |
| PERF-001 | Cumulative nested inspection and emitted-event budgets stop traversal/allocation during normalization; oversized in-window, out-of-window and comment getter-counter fixtures assert limits and explicit truncation diagnostics. |
| PERF-002 | Repository/base validation uses a five-second no-shell execFile adapter with SIGKILL and close/reap on timeout/cancellation, mapped to retryable infrastructure. Real isolated sleeping-child fixtures assert bounded settlement and that the child no longer exists. |
| SPEC-001 | Task 4.1 now has the single composed scheduler-to-rendered-sidebar acceptance described above, including fake pagination and native/store restart/lost acknowledgement. |
| TEST-001 | Independent normalized security-label-plus-advisory, label-only/advisory-only, major/minor/patch Renovate and medium Wiz cases assert exact importance AND presence/absence in every rendered category. |

The integrated fixture also exposed and fixed preservation of typed infrastructure failures at the session client boundary (rather than downgrading lost acknowledgement to unavailable destination). Existing wake-up restart regressions additionally proved that serialization must use the durable conversation key even before a live RunRecord is loaded; activation now revalidates the persisted association and any loaded owner without recreating a run.

### Current-run finishing gates

- 133 focused session/digest/scheduler/abort regressions across 20 files passed (720 assertions).
- Four rendered named-session/background-report/duplicate-name/Home-preservation tests passed (67 assertions), including the composed API/scheduler/native/MCP/restart/UI fixture and two `/new` sessions.
- Three existing native bridge/read-only/orchestrator regressions passed (33 assertions).
- Nine existing login success/handoff/privacy regressions passed (27 assertions).
- `bun run lint`: zero diagnostics; its 71 required architecture/boundary tests passed.
- `bun run type-check`: zero errors.
- `bun run build`: succeeded; generated artifacts were regenerated by build only.
- `openspec validate daily-task-digest-sessions --strict`: valid; `git diff --check`: clean.
- The complete suite was not run or delegated; it remains verifier-owned. Current environment tool discovery returned an invalid capability, so finishing used the package's required focused shell commands (no app was started).

Full command output: `.herdr-workflow/daily-update-sessions/runs/1f9a9602-2e3a-4f12-bbfe-8287248114cd.validation.log`.

### Full-suite follow-up (run 2cdb6253)

The next eight specialist verifiers returned empty findings. The full-suite verifier reported 16 failing jobs; this supersedes any implication that the full suite was green. No complete-suite rerun was performed by implementation.

Focused per-file executions were compared with an isolated `git archive HEAD` snapshot of accepted baseline `a4dd8e9`, using the same installed dependencies. The snapshot's native SQLite artifacts were generated using its own `bun run build:native` before repeating tests that initially could not load that generated module. Reported failures reproduce on baseline and current state for TEST-001–004 and TEST-006–016: recovery presenters/routes, managed-admission/ownership fixtures, MCP follow-up assertions, workflow repair/archive/fusion/runtime expectations, and prompt budgets. Baseline also has an additional runtime failure, so this is not a claim that every failure count/environmental condition is identical.

TEST-005's proposal modal test passes individually on both states after native artifact setup. Its reported render-shard/load failure remains unattributed; individual success does not resolve it.

Evidence is retained in `.herdr-workflow/daily-update-sessions/runs/2cdb6253-baseline-comparison.log`, `2cdb6253-baseline-repaired-comparison.log`, and `2cdb6253-current-comparison.log`. The earlier snapshot log includes missing-generated-module setup failures; use the repaired comparison for the six repeated files.

No assertions or admission/ownership protections were weakened and no product code was changed in this follow-up. Scope decision `baseline-scope` (group `91ca81e8-9eb3-43ed-b916-f5335649e7c3`) is pending: repair pre-existing workflow/host/prompt failures inside the digest change or keep that maintenance separate. This run is blocked on that decision, not on task size; the full-suite findings remain open.

### Authorized baseline repair (run 58f32447)

The recorded `baseline-scope → repair-baseline` answer authorized narrow repairs in this change. This supersedes the earlier pending-decision blocker; it does not waive the full-suite gate.

| Full-suite finding | Repair and retained regression coverage |
| --- | --- |
| TEST-001 | Register `workflow_recovery_preview` and `workflow_recover` in the workflow transcript presenter family and give them action labels. Existing exhaustive presenter coverage now passes. |
| TEST-002/003/007/008/010 | Host-unit fixtures explicitly enter the existing trusted post-admission boundary rather than send unfenced legacy managed launches. Workflow/run telemetry metadata and all original compaction, session-window, recovery and telemetry assertions remain. Test-only helpers are not IPC capabilities. Real managed-launch tests remain separate and pass, including unfenced launch/submit refusal and stale ownership. |
| TEST-004/006 | Independent fake runs now use matching native and environment run identities, including a separate environment for the independent compaction conversation. Cross-run environment non-leakage assertions and ownership barriers remain intact. |
| TEST-005 | Flush native Alt+Enter task submission and assert the confirmation screen before sending modal confirmation. This removes the asynchronous editor/modal ordering race without dropping either proposal-choice completion assertion. The affected 29-file render shard passes (199 tests). |
| TEST-009 | Native callable-tool updates can abort a provider request after the fake provider consumes its next response. The scripted follow-up tool call was consumed without being committed. A context-driven fake provider scripts the same calls from committed conversation state, and the test waits for the durable second answer rather than transient inter-turn idle. All original discovery/result/error assertions pass for direct, deferred and codemode exposure. |
| TEST-011 | Route discovery in the manifest test now reads explicit grouped literal path guards as well as single guards; ownership/orphan/schema assertions remain unchanged. The shared recovery handler already served both routes. |
| TEST-012/014 | Reducer-only fixture runners complete leased launch/stop effects via the public result command before expecting successor launches. They do not alter the production stop barrier, forge tokens or patch stores to skip admission. Original archive retry and fusion surviving-draft assertions pass. |
| TEST-013 | Assert the live-run repair preview before parking the fixture, then park before repair. Preserve stale revision and action assertions. |
| TEST-015 | Shorten shared protocol and stage/wiki instruction prose while retaining authority, trust, safety, evidence and test-scope rules. All existing family byte budgets and semantic assertions remain unchanged. Regenerate embedded assets only with build. |
| TEST-016 | The existing test title requires stopping expired siblings: now assert the claimed stop payload addresses the exact expired security sibling, instead of incorrectly asserting that no stop exists. |

Instruction compression was manually reviewed against the original assets because the auxiliary semantic classifier's confidence was below its floor. No prompt budget was raised, policy check disabled or production admission/ownership/generation/stop fence loosened.

Final isolated focused checks (fresh HOME/config/pi/wiki roots, fake providers/local synthetic MCP only):
- 15 baseline/native-admission files: **264 passed, zero failures** (`58f32447-focused-final.log`).
- 16 feature/session/scheduler/sidebar files: **103 passed, zero failures**, including all 40 sidebar tests (`58f32447-feature-regressions.log`).
- Exact affected render shard: **199 passed across 29 files, zero failures** (`58f32447-render-shard.log`); this was one focused job, not a full-suite rerun.
- Prompt budget/section checks: **46 passed**; lint: **zero diagnostics** plus **71 required boundary tests**; whole-project type-check: **zero errors**; build, strict OpenSpec and diff checks pass (`58f32447-gates.log`).

Logs are under `.herdr-workflow/daily-update-sessions/runs/`. Counts are per execution group, not a claim of disjoint unique tests. Implementation did not run or delegate the complete suite or devenv suite; their next run remains verifier-owned. All sixteen reported failing jobs have corresponding focused passing coverage, not a claim that the entire suite has passed.

### Stage instruction wording follow-up (run c5c2723e)

The next five specialist outputs returned empty findings. Full-suite verifier `2a81d793` reported **349/350 jobs passed, 5377 executed tests, one failed job**; all previously failing jobs passed. The remaining TEST-001 was an exact-phrase contract in `stage-test-workflow.test.ts` against compressed stage recovery guidance, not a live-source or session failure. The chained devenv suite was not reached.

Restored all three asserted recovery phrases in `stage-test-execute.md`: `try a materially different approach`, `Repair artifact/schema/guard errors`, and `do not bypass product validation`. Safe recovery alternatives, unchanged-retry stopping and scope/evidence protections remain explicit. The paragraph grows by only six bytes; no budget or assertion was changed. Embedded assets were regenerated only through `bun run build`.

Focused validation with isolated HOME/config/pi/wiki roots: **88 tests passed** across stage-test workflow contracts, prompt budgets and protocol semantics. Lint checked 1642 files with zero diagnostics plus **71 boundary tests passed**; whole-project type-check, build, strict OpenSpec and diff checks passed. Command evidence: `.herdr-workflow/daily-update-sessions/runs/c5c2723e-validation.log`. No full-suite/devenv rerun, live collection or schedule activation was performed. The next complete-suite result remains verifier-owned.

## Explicit limits and operational confirmation

Invocation, discovery and external pagination are **model-directed**, using deterministic normalization/rendering helpers; this is not a new account-wide deterministic connector or proof of globally complete live source coverage. Unsupported schemas/domains, missing bot metadata, pagination limitations and integration permissions must remain visible gaps. Actual configured model, repository/base branch, GitLab integration host and source availability require operator validation during supported setup.

No live source collection, live schedule creation, deployment, host restart/kill, commit or push was performed. Host restarts mentioned above are isolated synthetic fixture hosts only. All newly added native acceptance uses fake models/providers and isolated HOME/config/pi/wiki/stores. Before eventual activation, explicitly confirm run-late versus six-hour expire-after, Monday's preceding-24-hour coverage and existing job-level no-overlap/catch-up behavior. Manual live-account/TUI verification and the workflow-owned complete test suite are not claimed here.
