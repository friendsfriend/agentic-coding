## 1. Contextual creation
- [x] 1.1 Confirm navigation and Settings predecessors are implemented; inventory every public workflow type, target capability and existing creation option, including wiki comment submission.
- [x] 1.2 Extract/reuse existing creation form and start flow with immutable configured-project or independent-Wiki context; remove repository/custom-path selectors from contextual forms.
- [x] 1.3 Add application/library Start workflow actions with canonical identity, availability/capability checks, visible checkout choice and server-side revalidation.
- [x] 1.4 Add independent research/wiki starts on Wiki; preserve comment-review submission and prohibit repository-bound launch from that page.

## 2. Handoff and removal
- [x] 2.1 Preserve existing typed start, request reconciliation, Herdr handoff and durable execution ownership; distinguish rejected start from accepted-workflow handoff failure without duplicate creation.
- [x] 2.2 Keep the originating page after launch; remove global/project-local workflow lists, history/reopen routes, active-workflow launchers and their picker/catalog entries.
- [x] 2.3 Delete list-only UI/subscriptions/projections after auditing callers; retain CLI, Herdr, explicit identity, telemetry and recovery consumers and all durable data.
- [x] 2.4 Make final Home exactly Environments, Observability, Wiki and Settings; update home/manager docs and workflow-creation guidance.

## 3. Validation
- [x] 3.1 Test application and library launches for supported types, pinned checkout identity, missing/removed project, permissions and invalid target options.
- [x] 3.2 Test independent research/wiki and comment review with an empty catalog; verify repository-related variants launch only from resource pages.
- [x] 3.3 Test successful Herdr handoff, failed acceptance, uncertain response, duplicate submit and post-acceptance handoff failure; verify no second coordinator or workflow is created.
- [x] 3.4 Verify no list/history/reopen surface survives and no data is deleted; run explicit CLI/recovery regression checks and record type/target parity evidence.
- [x] 3.5 Open the TUI for full launch journeys and inspect footer/`?` catalogs; run relevant tests, type-check, zero-diagnostic lint and strict OpenSpec validation.
