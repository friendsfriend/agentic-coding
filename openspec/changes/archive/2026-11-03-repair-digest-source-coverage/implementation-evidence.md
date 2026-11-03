# Implementation evidence: digest source coverage repair

This reports repository implementation and isolated validation, **not deployment, live acceptance or operational application**. No live session, job, schedule, credentials, integration configuration or wiki page was changed. No duplicate operational entities were created. Full-suite verification belongs to the workflow test-verifier.

## Observed connector contracts versus synthetic validation

- Safe read-only Jira search/detail/comment inspections established the configured Markdown transport. Search advertises `nextPageToken`, `startAt`, `maxResults`, `fields` and JQL; returned search rows are candidates, not timestamped events. The observed detail omits requested timestamps, history and source URL. No dedicated history endpoint was established.
- Both empty and nonempty comment pages were inspected. The nonempty page declared 52 comments, showing 1–1; only that page was read, not all comments. Redacted structure (identifier/author/body omitted):

  ```text
  52 comment(s) on <issue-key> (showing 1–1):

  --- Comment 1 ---
  [id:<id>] <author> @ 2025-02-25T15:33:31.270+0100:
  <untrusted body omitted>
  ```

  Parsing preserves supplied ID/time/parent identity, validates counts and pagination, strips bodies and rejects ambiguous embedded headers. It does not reconstruct timestamps, transitions or links.
- GitLab declarations expose project-scoped search/detail/comments/discussions. No actual integration host or verified host-bound bot identity was independently established. Search advertises neither reviewed date filters nor complete activity pagination; full change/review/pipeline history therefore remains a coverage gap. No account-wide MR query was made. Existing host/project authorization is preserved.
- Reviewed Wiz contracts use `first/after/created_after/created_before` for issues, `limit/after/created_at_after/created_at_before` for posture and `limit/after/first_seen_after/first_seen_before` for attack surface. No live Wiz findings were collected. Discovery does not authorize additional methods.
- Azure Monitor/New Relic expose query receipts and 1-based offset/limit NDJSON readers. No production query was issued and no arbitrary provider result file was opened. Actual production selectors/services/provenance remain unverified and unconfigured. Public New Relic NRQL documentation confirmed `if()` in `FACET`; this is syntax evidence, not acceptance against a production account.
- The 428-candidate Jira fixture, cross-project/unassigned candidates, Wiz >40/domain-overlap data, production rows, model responses and native-host/MCP interactions are **synthetic isolated fixtures using observed contract shapes**, not claims that these live datasets were collected.

## Implemented source collection and authority

`digest-source-decoding.ts` decodes reviewed JSON/MCP/Markdown formats. `digest-source-queries.ts` compiles all-accessible Jira discovery, per-method Wiz bounds and all-state GitLab parameters from the trusted nominal due. Jira discovery widens its lower date one day for unknown query timezone and has no late-execution updated upper bound; only real events in the exact half-open preceding 24 hours qualify.

`digest-source-receipts.ts` records actual bridge dispatch attempts, failed attempts, successful pages/items, expected candidate detail/comment/history scopes, Wiz domains and authorized GitLab projects. Recorded counts override model claims; unobserved scopes have zero observed counts and unavailable status. Cursor mismatch/loop, unfinished pages, query-scope mismatch, provider errors, unavailable fields and caps persist. Later model success assertions cannot erase them. Actual history evidence can resolve provisional history gaps; absent history is not fabricated movement. Jira/Wiz/GitLab invocation remains model-directed, but the native final report uses actual receipt events, not reconstructed model events.

Budgets are 1,000 admitted source dispatch attempts per occurrence, 100 pages/10,000 inspected records per scope and 2,000 emitted events. Normalization bounds top-level and nested inspection, including irrelevant/out-of-window records. Dispatch metrics count host tool attempts, not unobservable provider-internal HTTP retries. Wiz overlap is deduplicated by finding/event identity. Ordinary MR creation, actual merge timestamps, timestamped discussion notes and failed head pipeline finish times survive independently of bot attribution. Notes do not establish approvals; updated timestamps do not establish specific transitions or reviews.

## Verifier follow-up (run d16149b9)

- Wiz issue requests compile to `first: 20`, independently of the other methods' `limit: 100`. Policy and receipt validation enforce method-specific limits. The >40 fixture traverses three valid issue pages.
- Jira issue identity and canonical GitLab host/project evidence scope are separate from method-specific read accounting. Search/detail creation/merge duplicates no longer inflate events, workload or recommendations; host/project isolation is retained.
- Comment/discussion receipts that finish before their parent detail wait in a bounded, process-local buffer (1,000,000 serialized bytes per occurrence). Parent context arrival automatically normalizes them once. Unresolved parent context and buffer caps remain explicit incomplete coverage, not generic note creations. Both MR completion orders and Jira enrichment orders have deterministic isolated regressions.
- Low/informational production evidence is Minor; missing severity is Minor and explicitly uncertain. New verified Renovate creations have an explicit marker across update types. CLI help exposes preview, guarded apply and nonactivated job proposal with their required flags.
- Independent literal Monday/DST Jira/Wiz query expectations and altered-scope rejection assertions supplement the paging fixtures. Telemetry initial-query/later-page rejection tests assert attempts/failures, retained groups, continued second-provider collection and sanitized diagnostics.
- Follow-up checks: 48 focused tests across 11 files passed; Biome lint (zero diagnostics, 71 boundary tests), whole-project type-check, normal build, strict OpenSpec validation and whitespace checks passed. These are isolated repository checks, not live-source acceptance.

## Full-suite finding reconciliation (run b5fffbfa)

The test-verifier's full-suite failures were reproduced with focused commands; the implementation worker did not rerun the full suite.

- **Deleted-session race:** activation already rejects the deleted destination without enqueueing/model calls. The failing assertion was a subsequent unconditional `ensureRun` after restart. The test now expects stale-settings recovery denial and independently verifies persisted native revocation still rejects activation without reloading the deleted session. The fail-closed host behavior is unchanged.
- **Sidebar delivery:** native/store reconciliation, single-answer retention, pagination, exact destination and no-focus-steal assertions passed before the viewport assertion failed. A diagnostic frame showed the longer required-source coverage at the transcript tail, with the first finding above the viewport. The fixture now uses terminal PageDown/PageUp input to find the retained report in both fresh-tail and restored-position tabs; it still asserts background scratch delivery does not change the selected report. All 40 sidebar tests pass.
- **Triage recovery:** a `git archive HEAD` snapshot of base `87f32c6` reproduced the same seven failures (5 pass/7 fail in the 12-case focused parameterized group). The archive reused installed dependencies and the generated native SQLite extension; tracked base source/test files were unchanged. Existing recovery intentionally rejects invalid retained arrival context before a new launch. The seven stale test expectations now assert rejection at repair time, unchanged persisted snapshot and no launch effects instead of assuming admission then testing rejection only at handoff. No workflow runtime behavior was changed.
- Validation: 46 tests across five focused workflow/scheduling/digest files and all 40 sidebar tests passed (86 total); lint, type-check, build, strict OpenSpec validation and whitespace checks passed. The complete configured suite remains the test-verifier's gate, not a claimed result of this worker run. Reproduction/base/final logs are in this run's `.herdr-workflow/digest-source-analysis/runs/b5fffbfa-*.log` files.

## Environment-isolation fixture reconciliation (run fde9e1af)

The subsequent test-verifier suite reported one remaining failure in `agent-host-env-isolation.test.ts`; its prior scheduling, triage and sidebar failures were absent. This worker reproduced the environment test in isolation: the first submit failed with `Run no longer owns this conversation` before the second run was created. Inspection showed that the fixture opened host run `run-a-id` with `HERDR_RUN_ID=run-a` (and similarly for B), so the session-window identity and submitted run differed. This was an invalid fixture identity, not evidence that two independently owned conversations lost ownership through concurrent submission.

The fixture now uses the same canonical ID for each run's environment, ensure, submit and transcript read. Its real bash-tool assertions still require each run to see its own ID and never the other's; an additional assertion requires distinct native conversation IDs. It waits for A to settle idle before replacing the shared faux provider's responses, and shuts down the in-memory host/removes its temporary directory in `finally`. No host ownership/admission guard or runtime code was changed, no test was skipped, and no live model/provider was called.

Validation: 25 focused tests passed across environment isolation, faux-provider host execution, native ownership, session-window attribution and scheduled-session races. `bun run lint` passed with zero diagnostics and 71 boundary tests; whole-project type-check and normal build passed. Strict OpenSpec validation and whitespace checks passed. Logs are `.herdr-workflow/digest-source-analysis/runs/fde9e1af-{env-before,env-after,focused,lint,type-check,build,validation}.log`. The worker did not run the full suite or change any live operational binding/configuration; full-suite verification and operator-only post-merge application remain separate gates.

## Narrow production capability

`digest-settings.ts` validates trusted, nonsecret operator selectors: one entry/provider, explicit production environment, reviewed environment attribute, exact literal services and provenance. Arbitrary query/endpoint/path/credential fields, injection strings, ambiguous providers and known QA/dev/test/staging values are rejected. Missing settings do not trigger account-wide discovery.

`digest-log-sources.ts` compiles only Azure `AppExceptions` and New Relic `TransactionError` service/signature aggregates for the trusted nominal window. Azure's outer API timespan widens for lateness, not its KQL predicate. New Relic null/empty error classes enter an unclassified bucket with an explicit context gap instead of disappearing through null facets. Counts describe captured source events, not unique incidents or customer impact; retention/sampling is not independently verified.

The bridge's private production gate resolves only reviewed provider bindings and privately consumes the exact provider-specific receipt path. Pages use offsets starting at 1, size 200, at most 1,000 groups/provider, with a ten-second abortable deadline/read. Repeated collection is cached per conversation/occurrence/trusted-settings generation. Receipt paths cannot be supplied by a model; paths already claimed by another conversation/occurrence/settings generation are rejected. Generic query/file-reader tools, direct/nested writes, shell and unreviewed dispatcher operations remain denied. Model-authored production events are rejected; reports must match the active native occurrence/window. Provider portals are not fabricated evidence deep links: missing deep links remain partial coverage. Counts become lower bounds at visible ceilings; successful rows survive later failures.

## Bounded analysis and coverage

`renderDailyDigestReport` leads with prioritized, deduplicated next actions, source workload and required-source coverage, then evidence-linked categories. No cross-source causal/customer-impact assertion or cross-provider sum is inferred. Wiz grouping requires known resource scope, exposure and status and preserves domain/severity/title distinctions. Provider/service/signature groups remain separate. Caps: 2,000 final events, ten identities/group, 32,000 detail bytes and 14,000 coverage-detail bytes. Omissions disclose caps and force structured incomplete `reportCoverage`, including total incomplete-scope count and bounded samples. Credentials/control characters/unsafe links are sanitized. Scheduler delivery success remains separate from coverage success; inaccessible sources are never reported as verified empty.

## Exact existing-session/job migration

- Supported `session digest-settings-preview` and `digest-settings-apply --expected-revision` operate only on the exact owned, bound existing collection session through its existing host. No host is spawned. Full-record expected hash, ownership/revocation/native association, current context and idle/admitted-turn guards run within the conversation-keyed serialization shared with reservation/activation/deletion. Atomic metadata replacement preserves execution/creation identity and active selection.
- Recovery overlays persisted trusted settings over stale `run.env`, including a synchronous refresh at context publication after native ownership awaits. Receipt/cache generations change with trusted source settings; delayed old completions cannot pollute the new source scope.
- `digest-job-update-proposal` emits a **nonactivated** version-3 `jobs.update` request with deterministic request ID, expected existing job revision, affected schedule, exact preserved destination/execution settings and actual prior/proposed collection-settings diff. Authentication/approval/application remains with existing operator facilities.
- The docs give pause/drain, export, preview, expected-revision update, calendar/destination verification, resume and fresh-revision rollback procedures. IDs remain session `f440fdc0-4e0b-4920-bba3-ca854a6eade7`, job `3d6a2361-09a7-4eff-89ff-d18eb23fd80f`, schedule `214247ce-cde0-49a2-9909-bf63aed70e45`.
- Weekdays 09:00 `Europe/Berlin`, run-late, preceding nominal 24h including Monday/DST, no-overlap, named native destination, durable native answer receipts and background/no-focus-steal operation are unchanged.

## Validation

Initial implementation focused digest/source/policy/setup/native/registry/scheduling-session run: **49 passed, zero failed across 13 files**. This includes actual-count override, settings-generation invalidation, 428 synthetic cross-project/unassigned candidates, actual-format comment offsets, Wiz pagination/domain overlap, ordinary MR discussion/pipeline evidence, cap disclosure, production private receipt paging, cross-conversation receipt denial, wrong-occurrence rendering denial, guarded updates/admission races/recovery, native delivery/restart and direct/nested mutation denial. All provider/model/store seams are isolated; no live model call was made.

Final gates passed: `bun run lint` (Biome zero diagnostics plus 71 boundary tests), `bun run type-check` (zero errors), `bun test test/scheduling-admission.test.ts` (4 passed, zero failed), `bun run build`, `openspec validate repair-digest-source-coverage --strict`, and `git diff --check`. The normal build regenerated embedded assets; none were hand-edited. These are focused checks plus normal gates, not a full-suite result.

## Remaining operator work and limits

After merge, Home/operator must verify actual GitLab integration host and production environment/services/provenance from trusted configuration, review prior/proposed settings and stored job, and use the documented existing-entity guarded procedure. Implementation did not prove these deployment-specific facts. No settings application or live digest acceptance is claimed. Jira history absent from the exposed connector, complete GitLab activity/pagination, provider deep links and source retention/sampling cannot be invented; reports remain incomplete where these are unavailable. Process-local receipts are not falsely restored after restart: recollect or report unavailable, while already committed native answers retain their original association.

The dedicated wiki step should reconcile the implemented claims above: version-3 compiled plan, execution-owned coverage/counts, narrow configured production capability rather than generic telemetry authority, explicit provider/history/deep-link limits, bounded grouping/structured coverage separate from delivery, and guarded existing-entity migration/rollback. This run made no wiki mutation and does not claim that a wiki page was already updated.
