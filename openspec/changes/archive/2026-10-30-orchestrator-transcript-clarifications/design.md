## Context

The current `runtime/reducers/agent-question.ts` chooses `targetRole: orchestrator` solely from `metadata.startedBy`. Its timer auto-forwards to the developer. `runtime/dialogue.ts` permits the operator to answer routed records directly; `reducers/developer-action.ts` uses generic answer/forward actions and resumes the blocked asker through the normal lifecycle. `server/auth.ts` derives one instance-wide orchestrator capability, not a conversation-scoped identity. `server/orchestrator-policy.ts` permits question actions but reserves human reviews.

`agent-host/orchestrator-session.ts` maintains a persistent host/run/conversation identity and `/new` selects a new conversation. The shell monitor submits random-request-id follow-ups to the currently active session and drops failed deliveries. That is suitable for advisory events, not durable question custody. `tui/dash/App.tsx` auto-opens `DeveloperQuestionModal` and takes keymap focus on pending records, including login handoffs. The published question and home specifications still describe modal/forward behavior and contain historical inconsistencies; this change replaces clarification behavior explicitly rather than relying on those inconsistencies.

Consulted wiki concepts: orchestrator-workflow-monitoring and workflow-event-subscriptions (human-reviewed, non-stale). They confirm that event subscriptions are observation, not response authority, and best-effort delivery must not become the decision ledger.

## Goals / Non-Goals

**Goals:** Ordinary transcript clarification for every workflow origin; explicit appropriate-session attachment; interruption-free grounded answers; explicit confirmation of developer-derived answers; durable, bounded identity/provenance/delivery; safe recovery and exactly-once lifecycle consequences.

**Non-Goals:** Changes to review authority, login/MFA UX, agent-to-agent consultation, model/provider policy, native codemode/imported tools, server admission, launch/generation/ownership fencing, schema7 version, deployment, services, QA AVA, commits or publication. One primary change implements the whole requested behavior in testable increments; no deferred-scope drafts.

## Decisions

### 1. Explicit clarification custody, not broader workflow ownership

Persist an additive workflow clarification attachment identifying the host, conversation/session and attachment epoch. Orchestrator starts attach to the authenticated calling conversation. UI starts offer an explicit attachment choice to a known appropriate conversation; absent choice leaves the workflow unassigned. Existing start attribution remains immutable. Provide a developer-authorized attachment/re-attachment operation through the normal workflow UI and a corresponding ordinary transcript intent (for example, ask to attach a named workflow); the orchestrator cannot seize an unattached workflow by observing it. Show unassigned/unavailable pending state and an explicit attachment action in workflow status/detail and Home. No automatic association with whichever session happens to be active.

The server derives session identity from authenticated host context/session-bound capability, not a caller-supplied session string or the instance-wide orchestrator token alone. Fence every question mutation against attachment epoch, workflow revision, question/group and asking run/step identity. Attachment grants clarification-only custody, not recovery rights to developer-started workflows, review powers or cross-session authority. Reattachment invalidates outstanding candidate/confirmation and delivery claims while retaining history. `/new` never inherits the old conversation's custody implicitly. Reject missing/forged/stale session identity.

Alternative rejected: `startedBy` or subscription scope as ownership; both omit UI starts and widen authority across conversations.

### 2. One canonical dialogue record with separate routing, discussion and delivery state

Extend validated bounded canonical dialogue/attachment records, compatible with schema7. Keep existing question/group ids, item order, asking run/step/role, options and exact multiline custom values. Persist custody epoch, routed/discussing/awaiting-confirmation state, candidate version and exact structured response set, proposal transcript reference, confirmation reference, answer origin (grounded orchestrator versus confirmed developer), supporting source references, and delivery receipt/identity. Delivery and discussion state are not workflow run states. Preserve existing count/content bounds, secret masking and non-content telemetry.

Legacy clarification records lacking attachment/provenance remain visible and unassigned until explicit attachment; never infer a home from start attribution or current active session. Previously answered records retain their historical attribution; do not fabricate provenance. Login records retain their existing specialized path. Decoder defaults and projections support existing schema7 stores without destructive migration or generated-file edits.

Alternative rejected: transcript-only records or a second answer ledger, because reconnect and workflow assignment must share one canonical accepted decision.

### 3. Two intentional answer paths, no passive chat-to-answer matching

An internal authenticated operation accepts a grounded answer only with supporting references to the agreed task/design or recorded developer decisions and a bounded rationale. The orchestrator must inspect those sources, answer only what they support and discuss uncertainty instead of inventing scope. Source existence/identity and custody are checked; semantic grounding is an agent responsibility tested with fake providers, not a classifier approval grant. Persist and render it as an orchestrator answer, never as a new developer instruction. It needs no developer confirmation and emits no question popup or attention demand.

If insufficiently grounded, the orchestrator raises the topic naturally in its existing transcript and discusses it over normal turns. It intentionally stages a versioned proposed answer naming the exact question/group and complete response set, summarizes it in ordinary assistant text and asks for confirmation. A later explicit developer confirmation of that exact proposal is mandatory before relay. The trusted host supplies real assistant/developer transcript message references, conversation and ordering; model-supplied text cannot impersonate a developer message. The orchestrator deliberately invokes the confirmation/relay operation with the proposed version and the developer message reference; the server verifies custody, proposal identity/content digest and subsequent developer-message provenance before accepting. There is no global message listener, yes/no regex, popup, special answer form or requirement to type JSON/ids. Ambiguous assent across multiple candidates, partial answers, unrelated chat or requested edits continue discussion; edits create a new candidate requiring a new confirmation. Never reuse one vague confirmation across concurrent questions. Agent prompts must not equate any ordinary user message with approval.

Retire clarification use of unrestricted `answer-question` and popup-style `forward-question`, or route those internal aliases through the exact same guarded operations. Old API/CLI paths must not bypass confirmation or provenance by claiming an answer origin. Cancellation is an intentional authenticated operation, not Escape or navigating away. Peer questions and login Done/Abort retain separate semantics.

Alternative rejected: automatically treating the next user message as the answer, or letting the model declare a developer principal. Natural-language intent is interpreted by the orchestrator, but only a real, scoped, version-bound transcript confirmation can support developer-derived delivery.

### 4. Durable addressed delivery independent of advisory subscriptions

Create a stable delivery identity per question/group and attachment epoch, committed with routing state. Deliver question context to the pinned conversation as ordinary internal follow-up input using a stable host request id; record acknowledgement only after host acceptance. Reconcile unacknowledged deliveries after reconnect/restart; a crash between host acceptance and receipt must replay idempotently. Subscription coalescing, dropping, mode changes and stream gaps cannot lose a question or retarget it. Do not restart services, create replacement conversations or bypass host admission to deliver. In monitor off/notify mode respect no automatic wake; keep pending discoverable and reconcile on explicit session opening/attachment. General workflow-event monitoring remains advisory and does not duplicate clarification prompts.

When the pinned conversation/host is unavailable, retain a pending/unavailable delivery state with retry/attachment affordance. Agent grace expiry still returns pending and the worker follows normal blocked handoff. Clarification timeout records overdue/pending attention, not auto-forward/modal/answer/discard. Explicit cancellation, run/step supersession and terminal workflow closure invalidate delivery and candidate authority; preserve history. Keep login expiry behavior separate. Bound retries/content without silently dropping the canonical pending question.

Alternative rejected: relying on the current active-session monitor, whose random request ids and drop-on-error policy cannot provide safe question delivery.

### 5. Accept once through existing lifecycle

Commit accepted answers and provenance transactionally under current revision/run/attachment fences. Resume via the existing normal blocked-asker rule only, not host launch calls from chat: correct current step, blocked asking role, no active replacement and attention-required workflow. A working run gets its tool result without another launch; a completed/superseded run is not relaunched. Preserve sibling runs, generation checks, admission and durable outbox identities. Repeating an identical delivery request returns the recorded receipt without creating another event/run; conflicting or stale answers reject without rewriting history. Cover the race where an answer arrives before the asking run's blocked handoff, using existing lifecycle reconciliation rather than an extra launcher.

### 6. Remove only clarification presentation

Filter ordinary clarifications out of modal selectors, keymap effects, automatic navigation and question notification/focus paths; retain a passive pending/status indicator and developer-invoked transcript/attachment navigation. Options, custom answers and ordered groups render naturally in discussion and remain structured internally. Keep login/MFA modal behavior, credentials and all plan/developer/findings/wiki review controls intact. Update owning keybind catalogs if attachment/navigation adds a key, and inspect footer plus `?` help with disposable local fixtures. Prompts (worker, planner and orchestrator) describe internal clarification requests accurately without promising a developer popup. Regenerate embedded resources only through the normal build.

## Risks / Trade-offs

- Natural-language confirmation is semantic, not regex-verifiable → require deliberate orchestrator action plus trusted transcript provenance/version binding; fake-provider tests for ambiguity, unrelated chat, changed candidates and prompt injection. Do not claim server validation proves the model's interpretation.
- Session-bound auth adds a necessary boundary beyond today's shared capability → narrowly scope to clarification delivery/answer and test another session using the same instance; never widen launch/recovery authority.
- Lost acknowledgement can repeat transport → stable host request ids and transactional accepted-answer receipt; test both crash windows and real persistence reopen.
- Pending can outlive a session or timer → discoverable status and explicit developer attachment/cancellation, no silent fallback.
- Shared login/question UI → test login Done/Abort and expiry plus each review boundary explicitly.
- Existing wiki modal/forward guidance becomes stale → dedicated wiki step updates existing concepts in place; planner authors no wiki concepts.

## Migration Plan

Implement additive contracts/custody first, guarded answer protocol next, durable delivery then UI/prompt integration. Test each increment with disposable stores and fake hosts/providers. Existing pending schema7 records become visible unassigned clarifications; provide attachment without rewriting old decisions. Validate legacy snapshots and reopen tests. Rollback must not overwrite unfamiliar records or silently reinterpret confirmed decisions; stop use of a failed draft implementation and retain stores for supported repair. No deployment/restart is authorized by this change.

## Open Questions

None requiring a new product decision: explicit attachment and mandatory confirmation of developer-derived answers were supplied in the assignment. Exact internal operation names, additive field layout and UI placement are implementation choices constrained by these contracts, not deferred requirements.
