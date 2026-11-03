## Context

The primary change is `repair-digest-source-coverage`. One coordinated change is necessary: repairing only the prompt or rendering would leave the collection execution gate and existing persisted job unable to collect the required evidence. No follow-up proposals are needed.

Read evidence: `digest-sources.ts` recognizes JSON object/array shapes only; `digest-report-tool.ts` calls JSON.parse and rejects text; `daily-digest.ts` excludes all GitLab activity except creation with verifiedRenovate and recognizes only jira/wiz/gitlab; `collection-policy.ts` has no production telemetry reads; `daily-digest-setup.ts` likewise omits logs and requests only new Renovate MRs. `session-command.ts` offers creation and proposal but no existing-session collection-binding update. The registry rejects retrying creation with changed settings. `pi-tool-bridge.ts` checks collection policy at execution for both tool call surfaces; preserve that boundary.

The reported live occurrence db19a6bf-8411-40af-b238-32eb5d3efb2a returned Wiz only: 428 Jira candidates in Markdown were rejected, GitLab binding was absent and no MR calls occurred, logs were absent and Wiz stopped at 40. These are input observations, not independently reproduced live-account results. The human-reviewed, nonstale wiki concept `projects/agentic-coding/daily-task-digest-sessions` confirms existing custody, scheduling and read-only invariants; its creation-only GitLab description must be updated later by the wiki owner.

Actual exposed connector declarations were inspected: Jira search accepts JQL/maxResults/nextPageToken/startAt/fields; issue detail accepts issueKey only; comment reads accept issueKey/maxResults/startAt. There is no advertised dedicated issue-history reader on this surface. GitLab has project-scoped search, detail, comments and discussions; the search declaration does not promise a pagination parameter. Azure Monitor queries return an NDJSON file receipt and a separate offset/limit reader; New Relic does the same and documents a SELECT row ceiling. A provider output file is not an invitation to enable arbitrary filesystem reads.

Wiz metadata discovery (no finding reads) confirms `list_issues` uses `first` (documented 1–20), `after`, `created_after`/`created_before`; posture uses `limit`, `after`, `created_at_after`/`created_at_before`; attack surface uses `limit`, `after`, `first_seen_after`/`first_seen_before`. All use pageInfo.endCursor continuation. Discovery schemas establish inputs, not response completeness. Full local production selectors, integration host provenance and real Markdown details/history shapes have not been independently established in this planning run.

## Goals / Non-Goals

**Goals:** faithful supported-format adaptation; actual per-source bounded collection; visible missing detail/history/pages; useful grouped analysis; explicit production provenance; narrow execution permissions; supported existing-session/job update after merge.

**Non-Goals:** replacing the scheduler/native transcript store; arbitrary provider client or shell access; account-wide GitLab enumeration; remediation, approvals or source writes; credentials in artifacts; live job/session/config changes by workers; duplicate sessions/schedules; live model calls in tests; treating deployment or manual live acceptance as completed here.

## Decisions

### 1. Explicit connector adapters and cumulative coverage

Retain pure TypeScript normalization/rendering and the host execution boundary. Add source-specific decoding for actual returned JSON, MCP text/structured envelopes and recognized Markdown Jira sections/tables. Accept raw returned text rather than requiring the model to reserialize or reconstruct records. Decode only evidenced fields; ambiguous Markdown, missing times or unknown structures become bounded diagnostics, not silent empty arrays or invented history. Keep candidate discovery separate from timestamped event extraction. Search all accessible Jira projects including unassigned work; retrieve each candidate's available detail/comments/history with actual supported parameters. Missing dedicated history capability is an explicit limitation, not permission to invent an endpoint.

Introduce per-source/scope collection accounting for attempted reads, page/item counts, expected scopes, continuation state, missing fields and completion reason. A completed later detail page can resolve a provisional missing-history marker; an omitted page cannot. Follow real cursors/tokens/offsets until exhausted. Repeated cursors, absent continuation, unsupported search pagination, provider/file truncation, timeout and policy denial produce partial/unavailable, not success. Keep existing per-page bounds (1,000 rows, 4,000 nested entries, 2,000 emitted events) and add explicit cumulative budgets (default 100 pages and 10,000 inspected records per source/scope, 2,000 final evidence events overall); stop before exceeding and disclose the precise cap. Larger populations remain partial rather than silently dropping the tail. Split query time ranges only when supported and deduplicate resulting evidence. Never hard-stop at 40 findings and call it complete.

Alternative rejected: prompt-only JSON instructions or generic Markdown scraping without a recognized schema. Both conceal missing provenance and pagination.

### 2. Broaden GitLab activity, not authorization

Continue deriving projects from pinned roots and actual approved remotes. Keep canonical host+namespace+project identity and explicit integration host binding; the same path on another host is not authorized. Query creation and updated candidates within each authorized project, then inspect available detail/discussion/review/merge/pipeline evidence for timestamped activity in the nominal window. Include ordinary MR creation, substantive changes, reviews, merges and failures when supported. An updated_at alone remains an unverified candidate, not an asserted review or failure. Unsupported activity endpoints are coverage gaps.

Highlight newly created verified Renovate MRs as a subset, not the only permitted report content. Use actual authoritative author/bot metadata or an explicitly verified configured bot identity tied to that host; usernames/titles/branches alone do not prove bot identity. Unknown bot verification must not hide otherwise evidenced ordinary MR activity. Preserve conservative security/update-type classification. Review new read methods individually against real schemas, including their consumed project argument; never authorize foreign/default projects via ignored aliases or nested codemode.

Alternative rejected: broad GitLab host/account scans or treating any username containing Renovate as verified.

### 3. Production logs through narrow trusted query adapters

Add a typed production-log evidence variant and required coverage entries for Azure Monitor and New Relic. Represent provider, verified environment selector provenance, service, signature, count, severity, first/last occurrence, queried window, evidence references and bounded examples. Counts from sampled/capped rows must be labeled lower bounds; provider aggregates and examples have separate completeness. Avoid cross-provider count summation unless identity overlap can actually be established.

Use a trusted collection configuration describing verified production selectors and their nonsecret configuration/evidence reference. Do not hard-code guessed app names, wildcard production heuristics or QA selectors. If configuration does not establish production scope, return unavailable with setup guidance and issue no broad query. Runtime collection cannot change selectors based on source text or model claims. Worker may inspect safely available source configuration/evidence, never dump credentials; unknown deployment-specific values remain an operator precondition, not a blocker to implementing fail-closed behavior.

Expose narrow digest log reads with compiled, bounded KQL/NRQL read templates: explicit start/end, approved tables/events, verified production/service filters, aggregate signatures/counts and small sanitized samples. Do not simply add arbitrary query strings to directReads. Reject union/widening/injection and mutation commands; bound bytes, rows, calls and time. Handle query receipt plus NDJSON paging internally, or constrain any imported result-reader call to exact receipts issued to the same conversation/provider/occurrence. No user-supplied path, cross-session receipt or generic read tool may authorize filesystem access. Propagate provider ceilings and continuation gaps. Keep I/O in host adapters rather than pure evidence functions.

Alternative rejected: prompt-only production filters or unrestricted Azure/New Relic query/file-reader allowlisting; both undermine production isolation and collection custody.

### 4. Analysis-first deterministic report and explicit coverage verdict

Extend evidence/tool schemas together; preserve original event identity/time/link and selector provenance. Render a concise cross-source summary and prioritized next actions before detailed categories, with visible jira/gitlab/wiz/azure-monitor/new-relic coverage. Each conclusion references evidence and distinguishes observed failures, unknowns and inferred impact. No claim of causal cross-source linkage without supporting identity; correlate only with evidence or label a hypothesis.

Group Wiz by evidenced rule/problem, resource/exposure and severity; group logs by provider/service/environment/error signature with first/last time and count. A group has one useful recommendation plus member identities/links; missing grouping fields must not merge unrelated risks. Bound visible examples and disclose omitted members with counts and a bounded identity appendix; exhaustion of total output/evidence bounds downgrades coverage. Do not repeat generic per-row advice. Retain Important/Relevant/Minor and conservative classification; logs prioritize observed failure severity/frequency without claiming customer impact from an exception alone. Invalid/credential-bearing links remain sanitized and missing links disclosed.

Derive a structured coverage verdict from mandatory sources, expected scopes, completion and unresolved gaps. The rendered report prominently says incomplete when any required source/scope is missing, denied, truncated or unavailable; empty is valid only after successful completed collection. Preserve successful evidence during outages and retain an all-failed diagnostic report. Scheduler delivery success continues to mean native delivery/receipt, NOT evidence coverage; report/tool metadata and documentation explicitly separate these dimensions without changing scheduler lifecycle semantics.

Alternative rejected: prose-only caveats after a success headline or a model-written unsourced executive summary.

### 5. Guarded operator migration, preserving destination identity

Add a supported explicit existing-session collection-settings update with preview and apply, restricted to the owning operator/exact collection session. Limit mutable fields to validated collection roots/host binding/verified source settings; do not alter owner/session/native store/conversation identity, model, cwd, active selection or creation-operation identity. Reuse registry atomic locking and compare expected prior settings/revision to reject stale applies. Verify GitLab integration host evidence rather than automatically trusting remote host names. An admitted occurrence retains its captured policy; updated settings apply only to a new admission and must not silently reuse a stale host run context. Preserve existing native admission/revocation fences and fail closed for deleted/replaced/foreign destinations.

Generate a nonactivated migration proposal for an existing job containing the current versioned task and exact target, expected old job revision and the setting diff. Apply job replacement only through existing authenticated operator scheduling update/preview facilities with stale-revision protection; no direct JSON store edits. No new job/schedule/session and no writable execution permission. Keep worker tests entirely isolated. Document operator sequencing: pause/wait for nonterminal occurrence if necessary, preview binding/settings, apply guarded session update, update existing job task, verify preserved schedule/destination, then resume through existing controls. The Home orchestrator applies approved operational changes only after merge/rebuild.

## Risks / Trade-offs

- Connector text formats and optional history/review fields vary → capture redacted structural fixtures before adapter work; unknown formats remain visibly unsupported, never fabricated.
- Production metadata may be unavailable locally → no production reads until operator supplies verified selectors; tests prove production/QA separation with synthetic configurations.
- Large accessible Jira/Wiz populations exceed budgets → explicit per-scope caps and continuation diagnostics; no completeness claim from a bounded sample.
- New source reads broaden a security-sensitive surface → narrow templates/receipt custody, direct+nested denial tests and unchanged destination admission tests.
- Stored task/config does not update merely by rebuilding → guarded operator migration and versioned task proposal are part of delivery.
- Wiki currently describes JSON-only/creation-only behavior → dedicated wiki step should amend the existing concept, not create a duplicate; planning writes no wiki content.

## Migration Plan

Implement and verify in the worktree without touching live configuration. Rebuild generated embedded assets via the existing build command only if required; never hand-edit embedded.generated.ts. After normal reviews and squash delivery, Home/operator rebuilds and previews migration for session `f440fdc0-4e0b-4920-bba3-ca854a6eade7`, job `3d6a2361-09a7-4eff-89ff-d18eb23fd80f`, schedule `214247ce-cde0-49a2-9909-bf63aed70e45`. Preserve weekday 09:00 Europe/Berlin, run-late, preceding nominal 24h including Monday, no-overlap, named native history and background/no-focus-steal behavior. Confirm real integration host and production selectors from configuration/evidence before apply. A post-merge manual occurrence is an operator acceptance action, not a worker test. Rollback uses the same guarded facilities to restore prior collection settings/task revision, without deleting history or creating replacements; unavailable bindings stay fail-closed.

## Open Questions

No unresolved product/permission decision blocks this plan. Deployment facts still to establish before operational application: exact production selectors/provenance for both telemetry providers and authoritative configured GitLab host/bot identity. If unavailable, the implemented digest must report those sources as unavailable; it must not guess. Detail/history/review pagination availability must be recorded from actual connector responses during implementation, with explicit limitations where the integration cannot supply it.
