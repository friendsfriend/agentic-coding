## 1. Contracts and recovery eligibility

- [x] 1.1 Resolve direct contract/context/test dependencies of the inspected server operations, repair reducer and host tools; follow workflow architecture and Effect conventions. Keep edits independent of unmerged host/scheduling work and preserve unrelated WIP.
- [x] 1.2 Add typed preview/execution and bounded instruction/audit contracts with server-derived principal, current revision and preview identity; reject blank/oversized inputs and retain backwards compatibility for old persisted records.
- [x] 1.3 Implement shared pure eligibility and consequence projection consumed by status, preview and transactional execution. Include blocked/failed same-step retry and at least one existing supported structural integrity repair, refusal diagnostics, affected tasks/runs/effects and truncation counts.
- [x] 1.4 Apply the developer-approved current-step-only policy: reject all cross-step commands (legacy operators included), refuse non-agent review/system re-entry, preserve evidence and arrival context/mode, and retain later reviews as ordinary graph transitions. Do not invent artifact-bound human approval validity from classifier gate decisions.

## 2. Durable safe dispatch

- [x] 2.1 Extend the existing repair/retry mechanics to atomically associate masked corrective context and orchestrator attribution with the replacement attempt, preserve failures/history and record effects, tasks and review consequences. Do not invent a separate lifecycle or migration.
- [x] 2.2 Route persisted context into the replacement worker's real assignment using the existing context pipeline; scope it to the intended attempt/roles and prove it survives store close/reopen before launch.
- [x] 2.3 Refuse live worker/debug-run and leased launch/prompt replacements; implement or verify transaction/claim/publication fences against races, preserve cleanup semantics and use existing stable outbox keys for at-most-one replacement.
- [x] 2.4 Request normal execution only after accepted commit; stale/repeated requests must not create additional attempts/effects. Surface remaining blockers without automatic repair loops.

## 3. Authorized server and orchestrator surface

- [x] 3.1 Expose read-only revision-bound repair preview and guarded execution through server operations and typed routes. Allow only the necessary preview/repair routes in orchestrator policy; enforce canonical visible target plus startedBy orchestrator ownership on the server and derive actor from authentication.
- [x] 3.2 Ensure direct repair routes cannot bypass gate/target/revision/active-run guards; preserve existing authenticated developer access without widening worker or ordinary client permissions.
- [x] 3.3 Add workflow_recovery_preview and workflow_recover host tools and expose exact eligibility, required inputs and limitations in compact/full workflow_status while retaining efficient unchanged polling. Keep legacy action behavior distinct.
- [x] 3.4 Update home orchestrator guidance and workflow recovery documentation for bounded operational clarification, own-workflow scope, required inspection, human forwarding, reviews, and prohibited file/config/credential/storage workarounds. Regenerate embedded assets via build only if affected; never hand-edit generated output.

## 4. Focused proof and finish gates

- [x] 4.1 Create deterministic fixtures with temporary HOME, AGENTIC_CODING_CONFIG_DIR, PI_CODING_AGENT_DIR, HERDR_WIKI_DIR and stores set before imports. Use fake host/model adapters; never touch live workflows, real MCP/model services, credentials or application lifecycle.
- [x] 4.2 Prove end-to-end status → preview → execution through orchestrator tool/server authentication on the blocked implementation/no-question/no-actions fixture. Assert correct fresh step, actual corrective assignment, durable attribution/context after restart, preserved blocked history and execution request without human resume/paste.
- [x] 4.3 Prove supported structural integrity preview/execution across the same boundary, including affected-record consequences, retained evidence/history and normal effect dispatch.
- [x] 4.4 Add negative tests for stale/mismatched previews, invalid bounds/targets/unsupported repair, four human review names and skip-ahead/producer rewinds regardless of artifact content, duplicate/concurrent dispatch, active worker/debug/leased-effect races and unauthorized clients/roles/non-owned/hidden targets. Changed-artifact approval revalidation is out of scope because every cross-step repair is refused (developer decision).
- [x] 4.5 Run focused regression checks for own-question answer/forward, pause/resume, retry-effect and switch-preset; assert tool schema/descriptions and compact/full status agree with server behavior.
- [x] 4.6 Run the changed server/host/runtime/assignment test files with isolated environment, then package bun run lint (zero diagnostics) and bun run type-check (zero errors). Run package bun run build once and validate OpenSpec strictly. Do not prescribe/run the full repository suite here: workflow test-verifier owns the configured complete suite after implementation and selected verifier checks.
