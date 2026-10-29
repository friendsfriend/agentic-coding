## 1. Isolated reproduction and lifecycle inventory

- [x] 1.1 Establish fake-provider/process fixtures with isolated HOME, AGENTIC_CODING_CONFIG_DIR, PI_CODING_AGENT_DIR, HERDR_WIKI_DIR and temporary stores; no live user config, credentials, applications or paid models. Preserve existing baseline behavior and add-agent-scheduling isolation.
- [x] 1.2 Trace authoritative dispatch/run generation-step-attempt, outbox creation/claim/lease/renewal, host ensure/submit/ack, publication/handoff, retry, repair/repin/preset-switch/closure and late results in the touched modules and direct callers. Record invariant owners and each design crash window in focused test descriptions/docs, without broad engine refactoring.
- [x] 1.3 Reproduce surviving busy host with a distinct fresh launcher lacking private capability and independently reproduce failed launch → retired attempt → stale retry. Capture bounded fixture diagnostics; do not generalize these results to all historical failures or investigate preset lookup without a connected reproduction.
- [x] 1.4 Verify supported existing host storage/admission fencing primitives before implementing reconciliation. If durable fencing requires schema-version change or new authority, stop for developer design review; retain STORE_SCHEMA_VERSION=6 and current event conventions otherwise.

## 2. Ordinary host admission

- [x] 2.1 Decouple ordinary PiDurableAdapter launch from requireRetryAuthority and make retry-target registration optional after ensure/submit. Audit normal prompt/observe/stop paths and AgentHandle typing for accidental dependence on privileged recovery authority.
- [x] 2.2 Preserve private inherited capability and exact conversation/ownership checks for parked-task recovery, single-host ownership and busy-host refusal. Ensure ordinary dispatch never triggers recovery-authority restart; concurrent launch/recovery cannot interrupt unrelated work.
- [x] 2.3 Add distinct-process surviving-host, capability-loss and several simultaneous/sequential verifier admissions while another agent works; assert one conversation/request per assignment, host identity unchanged, no capability leakage and repeated full cycles.

## 3. Shared effect eligibility and retirement

- [x] 3.1 Implement pure kind-specific lifecycle eligibility in runtime/effect-eligibility.ts. Cover workflow generation, active membership, step/attempt/run status, allowed effects and explicit consult/debug/cancel/stop exceptions; preserve valid non-agent effect retry semantics.
- [x] 3.2 Use shared decisions in status/action/tool exposure, transactional retry validation and claims. Recheck revision/CAS inside the transaction; stale direct calls must leave revision, counters, attention, effect and audit-success state unchanged with actionable typed diagnostics.
- [x] 3.3 Centralize scoped retirement of obsolete unclaimed pending/retry/failed effects across step/attempt replacement, repair, preset switch, handoff and closure; eliminate broad unrelated expiry. Preserve errors/outcomes/evidence, active-claim cancellation/stop barriers and repin semantics.
- [x] 3.4 Add table-driven missing/expired/wrong-step/wrong-attempt/generation/superseded cases and same-step versus cross-step replacement tests. Assert exposure/backend parity, original failure retention and consult/debug/stop/cleanup regressions.

## 4. Fenced supported reconciliation

- [x] 4.1 After developer approval of design section 4, extend existing recovery contract/schema and preview/execute paths with reconcile-launch. Preserve server-derived authorization: developer manual multi-target Repair versus owned-workflow orchestrator current-agent-step only; prohibit worker privileges and human decision bypass.
- [x] 4.2 Build bounded read-only preview using allowlisted recoverable launch-reference defects, exact affected identities, owner/lease expiry and fresh authenticated host observation. Bind revision, generation/step/attempt, claim renewal and admission/fence identity into preview; retain existing reason/instruction bounds and redaction.
- [x] 4.3 Implement expired-claim CAS and durable remote-admission fencing through existing host/control/storage boundaries. Renewed/live claims block, failed observation remains unknown, delayed old admissions/publications are refused. Never hold a workflow DB transaction across host I/O, export capabilities or clear leases in bulk.
- [x] 4.4 Reconcile matching admitted work in place or re-drive verified absent fenced work through ordinary durable claiming. Transactionally recheck preview/revision/identity/authority, retire only enumerated obsolete records, strictly validate final state and persist bounded audit; request execution only after commit. Fresh replacement requires separate proven-safe same-step retry semantics.
- [x] 4.5 Reproduce the observed obsolete attempt N launch plus current pending attempt N+1 launch lease through supported API fixture: live lease refuses with owner guidance; expired fenced lease safely reconciles; history/evidence/worktree remain intact and multiple subsequent agent cycles progress normally.
- [x] 4.6 Add deterministic fake-clock interleavings for lease expiry/renewal, dead versus live busy owner, retry/repair/late completion races and restart with obsolete/current records. Inject crashes before/after ensure and submit and before ack/publication/recovery commit. Assert stale requests have zero workflow mutation, no duplicate prompt/agent and at most one replacement.

## 5. Status, authority regressions and guidance

- [x] 5.1 Project queued, claimed/launching, admitted, actual working, failed and recovery-refused states accurately in API/orchestrator/dashboard. Keep unknown execution unknown; show bounded redacted owner/status/expiry and supported next action, not execution-requested as proof of running.
- [x] 5.2 Cover direct-route/tool/UI authorization parity, hidden/non-owned workflow refusal, pending questions/human gate waits, debug collection/cancellation and completed-work barriers. Preserve developer multi-target cross-step Repair target list and orchestrator same-step restriction.
- [x] 5.3 Preserve f0e6965 nested codemode event.result versus direct event.entry handling; add/extend integration coverage when launch observation encounters these events, verifying success never triggers false fail-fast or aborts a rebound conversation.
- [x] 5.4 Update workflow architecture/recovery documentation to remove stale all-cross-step-refused guidance and describe reviewed reconciliation, refusal and no-live-operation limits. Report wiki knowledge gaps for the dedicated wiki step. If controls/keybinds change, update owning shared catalog and verify isolated TUI footer and ? help.

## 6. Focused validation and delivery evidence

- [x] 6.1 Run focused tests for the changed host adapter/client/authentication/ownership/retry-mediator and codemode/fail-fast paths plus the new lifecycle/recovery/race fixtures. Use repository environment targets when configured; consult env_list before starting anything. Record commands/results and unsupported platform/manual checks honestly. Do not prescribe or run the complete repository suite as a worker task; the workflow-owned test-verifier owns it.
- [x] 6.2 Run agentic-coding package bun run lint with zero diagnostics and bun run type-check with zero errors after implementation; use Biome formatting/import organization, not eslint/prettier. Do not hand-edit embedded.generated.ts.
- [x] 6.3 Run openspec validate durable-agent-launch-lifecycle --strict; review only intended diff and record acceptance-matrix coverage, no paid/live operations, preserved schema version and human gates. Keep squash delivery preference; developer retains approval, deployment and any later live recovery decisions.
