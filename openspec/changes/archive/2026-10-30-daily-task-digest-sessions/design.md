## Context

The existing scheduler has calendar timing, durable occurrences, revision/fence checks, late policies and job-level no-overlap. `contracts/scheduling.ts` supports wake-up, standalone and workflow targets. `server/scheduling/standalone.ts` creates an occurrence-specific host/worktree; `wake-up.ts` addresses pinned conversations. `agent-host/scheduled-admission.ts` reserves native documents and submits `schedule:<occurrenceId>` with native receipt deduplication. Reuse these, not a second scheduler.

`pi-durable-state.ts` persists one active name in session.json. `tui/pi-durable/session.ts` ensures a shared coding-session host and creates/opens a conversation; reopening currently follows shell cwd/model. `PiDurableView.tsx` already renders native history through AgentSessionView and the existing projection cache. The workspace sidebar has one static Pi Durable page; the separate agent sidebar projects workflow runs only. Home and workflow agents must remain independent.

## Goals / Non-Goals

**Goals:** Multiple named workflowless sessions with durable exact identity; a dedicated Daily task digest history; read-only evidence-based cross-source collection; scheduled delivery without focus changes or per-occurrence writable approval; safe source and host failures.

**Non-Goals:** A digest workflow, Home orchestration, live schedule activation or live account-wide collection during implementation, writable automation, additional transcript stores, GitLab-wide project discovery, deployments, host kills, schema downgrades or unrelated cleanup. Normal human plan/code reviews remain.

## Decisions

### Session identity and presentation

Extend the existing pi-durable metadata boundary to a versioned registry with stable opaque session id, display name, exact runtime/store host identity, run/conversation binding, repository and policy/model defaults. Display names are not authority or identity. Persist active selection independently of destination binding. Preserve existing native conversation history and adopt existing session.json/current conversation non-destructively; detect malformed metadata rather than falling back to another conversation.

Create explicitly allocates one conversation and commits its binding before returning a schedulable handle. Continue/reopen requires that exact binding and authenticated owner, using recovery rather than create-if-missing. Resolve concurrent creates by operation identity; retry must not allocate another session. Deletion tombstones the identity and makes linked jobs visibly unavailable; it never creates a replacement. Distinct workspace sidebar session entries reuse PiDurableView with an explicit identity; workflow agent rows are unchanged. Updating a report refreshes history/unread state but never changes active selection or Home. Session metadata does not duplicate transcripts. Reopening must not overwrite pinned scheduled policy/cwd/model from the current shell.

### Scheduled collection target

Extend the standalone target contract with an explicit persistent workflowless-session destination (discriminated and strictly decoded), rather than abusing Home wake-up or the current active session. Use the existing adapter registry/service and native admission transaction/request receipt protocol; factor shared pinned-host recovery from wake-up/standalone as appropriate. Retain the old standalone per-occurrence behavior when no persistent destination is specified. New collection target carries repository, baseBranch, configured model, thinking if set, read-only permission and reviewPolicy none, plus exact destination identity and authenticated custody. Verify repository/base ref and configured model at setup/admission; never invent their values.

Recover only the registered coding-session host with stripped operator capabilities. Admission and recovery verify store identity, conversation identity, ownership, target revision and generation fences. A foreign owner, tombstone, replaced store or revoked tool authorization fails closed visibly. Busy-host barriers remain authoritative: defer through existing reconciliation while busy, preserving late/no-overlap semantics; do not queue around a barrier, abort unrelated work or silently change hosts. Cancellation before admission prevents submission; admitted work follows existing explicit cancellation semantics and records truthful history. Stale activation cannot publish a report.

One occurrence has one native request id and one report association referencing the exact native answer entry, not the latest reply. Recover reservation/submission/answer after a crash before attempting new work. The native transcript is the report history; scheduler result projection references it idempotently. Persist associations before acknowledging completion, reconcile missing acknowledgements, and never append a separate duplicate report on retry.

Jev's strategy judgment had confidence 0.02 and is not usable. Direct inspection supports the above reuse decision, independently judged here; a parallel scheduler/store also violates the agreed scope.

### Least-authority source collection

Add a dedicated collection tool profile for these workflowless sessions, not default coding or orchestrator authority. Enforce read-only at execution and codemode dispatch boundaries, including discovered nested MCP tools; hiding tool names or prompt instructions alone is insufficient. No arbitrary shell/write tools, workflow remediation, merge/approval/deploy, source edits or credential management. Local repository enumeration is a constrained read-only adapter, not model shell execution. Preserve native bridge/review/login behavior for other profiles. Credentials remain inside configured integrations; missing access yields variable/reference names or setup instructions only. External descriptions and report text cannot widen the allowlist.

Implement small typed provider/page/evidence adapters and pure window, normalization, deduplication, classification and rendering functions. Use metadata discovery to learn actual tools/schema, with fake provider contracts in tests. Wiz discovery and execution must use MCP through codemode; domain taxonomy discovery was available in planning, but no findings were queried. Cover all discoverable supported finding domains accessible to the account, recording each domain's coverage. If a provider cannot offer a global new-findings view, iterate discovered read-only domains and explicitly report unsupported categories; do not imply tenant-complete coverage from issues alone. Record first-created/first-seen evidence, never updated time as proof of newness.

Jira searches span accessible projects without an assignee restriction. Follow search, changelog and comment pagination; request least fields needed for issue identity/title/link, creation/update, priority/status/assignee and relevant event times. Report actual transitions only from changelog/comment evidence. An updated-only candidate can be reported as an unverified update, not invented movement. Respect field-level denial and visibility gaps.

Discover local repositories from configured workspace roots/catalogs, canonicalize roots and inspect actual remotes without fetching. Deduplicate canonical GitLab origin/project identity, including SSH/HTTPS variants and nested namespaces, preserving separate GitLab hosts. Never guess project paths or expand all GitLab projects. Query only discovered accessible projects for MRs created in the window. Confirm Renovate identity from authenticated author/bot metadata or explicit configured verified identity, never title/branch alone. Missing identity is excluded with a diagnostic. Report inaccessible projects and bounded discovery coverage.

### Window, report and policies

Calendar timing is Monday-Friday 09:00 Europe/Berlin using existing preview/recurrence/DST policy. Use half-open absolute interval [nominalDue - 24 hours, nominalDue), even Monday and DST boundaries. Late execution uses nominal occurrence time, not wall-clock execution; report both nominal and actual execution and the original interval. Do not silently widen to weekend catch-up. Use existing job-level no-overlap; propose expire-after with a 6-hour grace as a setup recommendation, requiring human confirmation of that policy versus run-late before activation. Neither policy is pre-authorized by this plan.

Important: evidenced highest/critical Jira urgency or newly urgent blocking movement; new critical/high Wiz findings with supported severity/exposure/exploit evidence; Renovate security updates only with explicit advisory/security evidence. Relevant: verified status/assignee/priority movement, medium Wiz findings, and verified non-security major dependency updates. Minor: routine new tasks/comments and verified patch/minor dependency updates or low/informational findings. Missing severity/update type never upgrades importance: place in Minor with uncertainty (unless independent evidence meets a higher criterion). Explain category reasons, deduplicate source identities/events, list actionable next steps without performing them, and link each claim to its source. Do not reproduce private raw comments, findings or source dumps.

Every source/domain/project reports success/partial/unavailable, requested scope/window, page counts, truncation/caps, missing fields and bounded nonsecret diagnostics. A failed query is never an empty result. Keep successful sources when another fails; if all fail retain a diagnostic report, not a fabricated empty digest. Persist report occurrence/window/coverage metadata with native answer association.

## Risks / Trade-offs

- Checkout provenance: the managed isolated worktree is clean apart from this proposal, but HEAD reports a4dd8e9 on feature/daily-update-sessions rather than the requested c517ba7/copilot-sol context → preserve the managed worktree and unrelated work; surface this discrepancy at plan review before implementation rather than resetting or replacing the branch.
- Broad provider access and heterogeneous Wiz domains → capability discovery, per-domain coverage and bounded pagination; no false completeness claim.
- Existing read-only coding policy retains bash → dedicated enforced collection profile, including negative nested-codemode authorization tests.
- Session registry/native conversation atomicity gap → operation identity, durable binding state and crash reconciliation tests; never repair by silent recreation.
- Shared host busy state and model/policy mutation → exact-target recovery, serialized native binding, pinned collection settings and barrier regressions.
- No prior durable wiki context was returned by scheduler/sessions search → document lifecycle, security and setup gaps in repository docs for the later wiki role; planning writes no wiki concepts.

## Migration Plan

Use supported versioned metadata migration with isolated legacy fixtures, atomic secure writes and preservation of old conversation ids/history. Inspect current scheduler/native storage version before changing any schema; add a forward non-destructive supported migration only where necessary. Never edit live DBs, downgrade schema versions, change constants to bypass incompatibility or hand-edit embedded.generated.ts. Interrupted migration is safely retryable; unsupported future versions fail with diagnostics. Rollback must preserve new data and reject incompatible readers rather than downgrade storage. No service restart/deploy is part of this work.

## Open Questions

- Delivery-time confirmation: choose expire-after (recommended six hours) versus run-late, acknowledging existing job-level no-overlap and missed-slot history. Do not create the live recurring schedule before that confirmation.
- Concrete repository/model and configured integration identities are resolved by supported setup validation after delivery, never guessed in a checked-in fixture. Missing provider capabilities remain coverage diagnostics, not a reason to run live collection during coding.
