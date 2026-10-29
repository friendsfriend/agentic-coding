## ADDED Requirements

### Requirement: Ordinary admission independent of recovery authority
Ordinary authorized dispatch SHALL reuse the existing private authenticated host channel without requiring process-local privileged parked-task recovery authority. Missing retry-target registration SHALL NOT invalidate an otherwise successful ordinary launch. Explicit recovery SHALL retain capability, conversation and ownership checks. The system MUST NOT export capabilities, weaken authentication, steal ownership, restart a busy host or introduce a parallel launch queue.

#### Scenario: Surviving busy host and a new process
- **WHEN** a launcher exits while its detached host works and a fresh authorized process lacking its private capability launches several verifier runs
- **THEN** the same host admits distinct runs without restart, interruption or recovery capability disclosure

#### Scenario: Ordinary launch races explicit recovery
- **WHEN** ordinary admission and privileged recovery overlap on a busy host
- **THEN** ordinary work progresses and recovery either succeeds under its own exact authority or refuses safely without interrupting unrelated work

### Requirement: Independent mandatory server verification
Managed initial admission SHALL require the host to independently discover and authenticate a compatible background workflow server and verify the exact current unexpired claim before ensure and initial submit. The server SHALL derive run/role/generation, paths/profile and deterministic request identity from committed workflow state. Caller-supplied paths, epochs, permits or URLs SHALL NOT grant authority. Unavailable/auth/version failures SHALL preserve intent with bounded refusal; no offline fallback or implicit server start is permitted.

#### Scenario: Server unavailable or caller identity spoofed
- **WHEN** a managed caller lacks a verifiable current claim or the server cannot be authenticated/reached
- **THEN** no native initial turn is admitted and the durable workflow intent remains intact

#### Scenario: Caller changes admission fields
- **WHEN** a valid claimant sends arbitrary paths, role name or request identity
- **THEN** admission uses only the independently verified server-derived identity and request

### Requirement: Shared lifecycle eligibility
A single pure lifecycle eligibility decision SHALL govern retry exposure and transactional retry/claim enforcement. Ordinary run-addressed effects MUST reference an existing active run of the workflow's current generation, step and attempt and active-run membership, with a legal effect kind. Missing, expired, wrong-step, wrong-attempt and superseded references MUST NOT be revived. Consult prompts, debug side runs, cancelled launches, stops and cleanup SHALL use explicit kind-specific lifecycle rules rather than broad exemptions. Other valid effect retries SHALL retain their bounded retry-budget semantics.

#### Scenario: Invalid reference matrix
- **WHEN** a failed launch refers to a missing, expired, wrong-step, wrong-attempt or superseded run
- **THEN** UI/API/tool status omits retry and a direct retry rejects atomically with bounded actionable diagnostic and no revision, status, counter or attention mutation

#### Scenario: Intentional lifecycle work
- **WHEN** addressed consult, delegated debug or cancellation/stop work remains valid beyond its originating step
- **THEN** its precise lifecycle rules allow required completion or cleanup without enabling an ordinary obsolete launch

### Requirement: Scoped retirement
Attempt/step replacement, repair, preset switch, handoff and closure SHALL retire obsolete unclaimed effects, including relevant failed launches, using exact workflow/run/generation/step/attempt identity. Retirement SHALL preserve original failure and terminal outcome history and SHALL NOT expire unrelated consult/debug/cleanup work or erase actively owned claims. Claimed launch cancellation SHALL retain its stop/publication barriers until safely settled. Repin SHALL NOT revive obsolete work.

#### Scenario: Failed launch then replacement
- **WHEN** a launch fails and same-step retry, cross-step developer repair or preset switch replaces its attempt
- **THEN** the old unclaimed launch is retired and cannot be offered or directly revived, while relevant errors, evidence and outcomes remain recorded

#### Scenario: Unrelated cleanup and claimed work
- **WHEN** replacement encounters independent stop/cleanup work or a claimed launch
- **THEN** unrelated lifecycle work survives and claimed work is fenced/cancelled through its supported barrier rather than blanket expiry

### Requirement: Fenced idempotent admission and publication
The system SHALL use existing outbox claim/renewal, host run/conversation identity and deterministic request deduplication to ensure at most one admission/turn for one assignment. Expired ownership SHALL fence both late remote admission and late result publication. Lease expiry or pending run status alone MUST NOT prove absence of remote execution. Failed observations SHALL remain unknown. Reconciliation SHALL preserve matching admitted work in place instead of creating duplicates.

#### Scenario: Crash before host admission
- **WHEN** a claimant stalls before remote admission and its lease expires while reconciliation proceeds
- **THEN** its stale admission is fenced and only the authorized current claim can admit work

#### Scenario: Crash after admission before acknowledgement
- **WHEN** host ensure or submit succeeds but the launcher crashes before acknowledgement or outbox publication
- **THEN** retry/reconciliation finds the same conversation and request, admits no duplicate turn and publishes only under current ownership

#### Scenario: Renewal and late completion
- **WHEN** renewal races repair, stale retry or late completion
- **THEN** a live renewed owner blocks replacement, stale tokens cannot publish and at most one authorized replacement/admission is committed

### Requirement: Stop barriers survive native restart
An accepted managed stop SHALL durably fence both run and owned role before native cancellation. Restart SHALL settle unfinished accepted stop commits before native tasks resume. Late cleanup SHALL NOT abort a successor's conversation.

#### Scenario: Crash after stopping commit
- **WHEN** a host crashes after accepting a stop but before native abort or stopped acknowledgement
- **THEN** startup completes that same stop before native resume and preserves the durable stopped fence

### Requirement: Truthful lifecycle visibility
Status and attention SHALL distinguish queued admission, claim/launch progress, host admission, actual model/tool work, launch failure and recovery refusal using authoritative records and observations. Pending, active labels and execution-requested acknowledgements SHALL NOT be represented as proof of model execution. Diagnostics SHALL be bounded/redacted and offer only server-executable actions, identifying a blocking owner/status and supported next action without exposing capabilities, credentials or claim tokens.

#### Scenario: Acknowledged but not executing
- **WHEN** execution was requested or queued but no actual execution observation exists
- **THEN** API/dashboard/tool views report admission/progress or unknown execution rather than claiming the agent is working

#### Scenario: Recovery refused by a live claim
- **WHEN** a valid live owner-held lease prevents recovery
- **THEN** status names the bounded owner/state/expiry and supported wait-or-owner-settle action without offering unsafe retry or replacement

### Requirement: Repeatable isolated lifecycle evidence
Focused tests SHALL exercise sequential and simultaneous multi-agent cycles with fake providers, isolated HOME, AGENTIC_CODING_CONFIG_DIR, PI_CODING_AGENT_DIR, HERDR_WIKI_DIR and temporary stores. They SHALL preserve nested codemode event.result versus direct event.entry success handling and developer multi-target Repair. Tests MUST NOT use live credentials/stores, paid models, live applications or force-kill existing hosts.

#### Scenario: Complete cycles after stuck-state recovery
- **WHEN** isolated fixtures reproduce obsolete launch plus current pending leased launch and reconcile through the supported reviewed API after safe expiry/fencing
- **THEN** normal multi-agent progression continues through repeated cycles with exactly one admission/replacement, retained evidence/outcomes and all human gates still enforced

#### Scenario: Nested tool success during launch observation
- **WHEN** direct and nested codemode successes/failures are observed during the lifecycle fixture
- **THEN** event.entry and event.result are interpreted correctly and nested success never causes the restored false fail-fast regression
