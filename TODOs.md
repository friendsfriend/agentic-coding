Not for agents. This is only for humans.

Fixes: 
* Luvus:
    * Spawning a new tab always focuses it. Check if that can be disabled
    * Review modals flash the diff files (seems like it is reloading constantly)

Big ones:
* Agent steered version of the workflow. Basically an orchestrator version of the workflow.
* subagent system for workers
* Make otel work for apps that are launched via the environment as well (Introduce Agent skill for setup)
* Agent skills to create the environments for a fresh app.

Small ones: 
* (Maybe) Give all agents their own tab. Multitab spawning always has issues for some reason
* Improve agent steering based on recent runs (observability first)
* Jev based compaction?
* Use jev to block bash commands that should be blocked

Promps (jev):

Escalation on verfier failure
 # Task: Effort escalation on implementation failure and verification fix

   You are implementing a design in the repository at `/home/archgamer/agentic-coding`
   (the `agentic-coding/` Bun/TypeScript package). Work on a feature branch with
   OpenSpec: create the change proposal first, then implement.

   ## Dependency

   This builds on **design A** (model pools / JEV routing): preset
   `pools[<stepId>] = [{ label, profile, criteria?, default? }]`, a `model.classify`
   effect, and `applyClassifierRouting` in `runtime/reducers/effect-result.ts` that
   rewrites a pinned route to a pool-selected profile. Implement on top of A.

   The repo may also contain B4's `triage` and B5's `gate` classifier integrations,
   which also use `model.classify`. Keep them working; the reducer change must be
   additive.

   ## Read first (required)

   - `AGENTS.md`, `agentic-coding/docs/workflow-architecture.md`
   - `agentic-coding/src/workflow/steps/implementation.ts`,
     `steps/verification.ts` (`verificationCompletion`)
   - `agentic-coding/src/workflow/classifiers.ts`, `classifier-runner.ts`,
     `effect-runner.ts` (`model.classify`)
   - `agentic-coding/src/workflow/runtime/reducers/effect-result.ts`
     (`applyClassifierRouting`), `runtime/reducers/agent-handoff.ts`
     (`loopMaxAttempts` lookup), `runtime/kernel.ts` (`transition` loop accounting)
   - `agentic-coding/src/workflow/profiles.ts` (`pools`, `RoutingPreset`,
     `resolveProfile`)
   - External: https://docs.typesafe.ai/primitives/noul.md

   ## Goal

   When an implementation attempt **fails**, or verification asks for a **fix**,
   classify whether the next attempt should use a stronger model and, if so, escalate
   exactly one tier within the `core.implementation` pool before re-running. This is
   the only mid-step classification: it happens on the retry paths, not at a system
   step.

   ## Locked decisions (do not re-litigate)

   1. Granularity is the **attempt** (one agent run). The engine does not model
      intra-session turns; do not attempt that.
   2. Triggers are **`failed`** and **`verification-fix`** only. `blocked` does
      **not** trigger escalation; it self-loops on the same tier as today.
   3. Escalate **exactly one tier per decision**, cumulative across retries. Pool
      array order is **cheapest → strongest** (index 0 weakest, last strongest).
   4. Classifier error / missing key → **no escalation**, retry the same tier, record
      `attention`. Never escalate as a fallback.
   5. Ask on **every** failure (the classifier sees the attempt count).
   6. Document in the pool editor that array order is escalation order.

   ## Mechanics: in-step deferral (no new loop step)

   Do **not** insert an `effort-gate` step. The engine's `loop`/`maxAttempts`
   accounting is built for self-edges (`kernel.ts`), and an indirect loop breaks
   attempt numbering and the `loopMaxAttempts` lookup in `agent-handoff.ts`. Instead
   defer inside the existing steps:

   - `core.implementation` on outcome `failed`: `onAgentComplete` returns
     `{ deferTransition: true, effects: [{ kind: "model.classify", ... }] }` instead
     of transitioning. Add `model.classify` to `core.implementation`'s
     `allowedEffects`.
   - `core.verification` when `verificationCompletion` would transition `fix` (not
     `limit`): return `{ step: { appendResults }, deferTransition: true, effects: [classify] }`.
     Leave the `limit` path transitioning directly. Add `model.classify` to
     `core.verification`'s `allowedEffects`.
   - Effect payload:
     `{ integration: "effort", trigger: "implementation-failed" | "verification-fix",
        outcome: "failed" | "fix", attempt: <number>, failure: <bounded string> }`
     with an idempotency key unique per workflow/step/attempt/trigger.
   - `effect-result.ts` runs the escalation rewrite **before** the step's
     `onEffectComplete`. Add `onEffectComplete` to both behaviors:
     - `core.implementation`: on `model.classify` complete with an `effort` payload,
       transition `{ outcome: payload.outcome }` (the `failed` self-loop).
     - `core.verification`: on the same, transition `{ outcome: "fix" }`.
   - `failure` is a bounded summary from the agent output (cap ~8KB) carried in the
     payload; do not rely on the failed run's output artifact existing.

   ## Classifier protocol

   - New `effort` integration in `classifiers.ts`, one `noul`:
     `should_upgrade`: "Given the failure and the progress so far, should the next
     attempt use a stronger model?" `>= 0.5` → escalate.
   - State assembly in the runner (`integration: "effort"`): bounded failure text +
     the task + plan summary + a changed-file/diff summary + the attempt number +
     the current tier + the `core.implementation` pool. Reuse A's bounded caps and
     state helpers.
   - The handler returns `{ integration: "effort", upgrade: boolean }`.

   ## Escalation rule

   In `applyClassifierRouting` (now a dispatcher on `data.integration`: `routing`,
   `triage`, `gate`, `effort`; only `routing` and `effort` rewrite `snapshot.routing`):

   1. Resolve the selected preset and `pools["core.implementation"]`.
   2. Find the current tier: prefer a persisted chosen pool label (recommended to add
      in A); otherwise match the pinned `core.implementation` route's profile to the
      pool. If no match, start at index 0.
   3. Advance to the **next entry whose profile differs** from the current one. If
      none exists (already at the strongest), no-op and record.
   4. `resolveProfile(next.profile, agents)`, rewrite the route
      (`stepId: "core.implementation"`, `role: "worker"`), and `preflightProfile`
      against the step's requirements.
   5. On any failure, leave the route unchanged and record `attention`.

   ## Audit

   Record every escalation (from-tier → to-tier, trigger, `noul`, attempt), emit a
   notification and a telemetry event, and surface it in `status`/the dashboard. No
   silent cost increase.

   ## Verification (required)

   - `bun run lint`, `bun run type-check`, `bun run build` in `agentic-coding/` with
     zero diagnostics. Never hand-edit `src/workflow/embedded.generated.ts`;
     regenerate with `bun run build`.
   - `bun test test/workflow-source-layer-boundaries.test.ts test/workflow-module-import-cycles.test.ts test/workflow-module-exports.test.ts`
   - Add/update tests:
     - `failed` defers, runs the effort classify, then takes the `failed` self-loop;
       the loop limit still reaches `attention-required`.
     - `verification-fix` defers and resumes `fix`; the `limit` path does **not**
       defer.
     - `blocked` is unchanged (no `model.classify`).
     - escalation advances exactly one tier; repeated failures climb cumulatively;
       the top tier is a no-op; missing pool → no-op.
     - classifier error → route unchanged and `attention` recorded.
     - reducer dispatcher keeps `routing`/`triage`/`gate` behavior intact.
     - audit event emitted on escalation.

   ## Out of scope

   - Intra-session turns / persistent interactive implementation sessions.
   - "Change approach" guidance (only a stronger model is selected).
   - Escalating planning or verification model tiers.
   - Gating (`core.archive` remains ungated, verification/triage/review gates are B5).



---------------------------------

Question routing
# Task: Unified, classifier-routed agent questions

   You are implementing a design in the repository at `/home/archgamer/agentic-coding`
   (the `agentic-coding/` Bun/TypeScript package). Work on a feature branch with
   OpenSpec: create the change proposal first, then implement.

   ## Dependency

   This builds on **design A**'s classifier runner (multi-question System One
   requests, `choice`/`noul` parsing, probabilities and confidence). It does not
   need B4/B5/B8. It replaces the existing agent question surface.

   ## Read first (required)

   - `AGENTS.md`, `agentic-coding/docs/workflow-architecture.md`
   - `agentic-coding/src/workflow/runtime/reducers/agent-question.ts` (`agentQuestion`),
     `runtime/reducers/agent-consult.ts` (`agentAsk`, `agentAnswer`,
     `completedRoleRun`)
   - `agentic-coding/src/workflow/runtime/dialogue.ts` (`questionRun`, bounds,
     expiry)
   - `agentic-coding/src/workflow/cli/commands/dispatch-actions.ts`
     (`runAgentAsk`, the developer-question handler), `cli/schema.ts`, `cli/run.ts`
   - `agent-definitions/extensions/developer-question.ts` (registers
     `developer_question` and `agent_ask`)
   - `agent-definitions/instructions/workflow-agent-protocol.md` (question guidance)
   - `agentic-coding/src/workflow/classifiers.ts`, `classifier-runner.ts`
   - External: https://docs.typesafe.ai/primitives/{choice,noul}.md

   ## Goal

   Replace the two agent tools (`developer_question` and `agent_ask`) with a single
   `question` tool and a single `workflow question` CLI command. The command
   classifies each question and routes it either to an available completed peer
   agent (by role) or to the developer. Routing is opt-in.

   ## Locked decisions (do not re-litigate)

   1. **One tool, one command.** Remove `developer_question` and `agent_ask`; add a
      single `question` tool and a single `workflow question` command. Reuse the
      existing `agent.question` (developer) and `agent.ask` (peer) reducers
      internally; do not invent new dialogue storage.
   2. **Classification is synchronous, in the question command.** Do not use a
      durable `model.classify` effect. The question is interactive and fails safe to
      the developer.
   3. **`questionRouting: "off" | "auto"`, default `off`.** When `off`, every
      question routes to the developer (no peer routing). When `auto`, classify.
   4. Two-part decision in one request:
      - `requires_developer_authority` (`noul`): "Does answering this require
        developer authority, an irreversible decision, permissions, or information
        no peer has?" High → developer.
      - `target` (`choice` over available peer roles + `developer`) with criteria
        describing each role's remit.
   5. Route to the chosen peer only when authority is low, the target is a peer,
      that peer is still available, and `confidence >= 0.5`. Otherwise → developer.
   6. **Peer failure → re-route to the developer.** If the chosen peer vanished or
      its prompt cannot be delivered, fall back to the developer instead of failing
      or expiring.
   7. **Full question text** is sent to the classifier; no redaction. Default `off`
      is the privacy mitigation. Document that enabling routing sends question
      content to the JEV endpoint.

   ## Available peers

   Enumerate at routing time with the existing `completedRoleRun` rule: run status
   `completed`, a live `handle`, a step different from the asker's, and not the
   asker. Only those roles appear in the `choice` criteria and are eligible. If none
   are available, skip the classifier and go straight to the developer.

   ## State and criteria

   State: the full question description, context, and options; the asker's role and
   step; the task/change summary; and the available peer roles. Criteria describe
   each role's remit, e.g. planner → approved approach/scope; worker →
   implementation details; verifier → findings/evidence; researcher → gathered
   facts; wiki → documentation coverage; developer → authority/ambiguity/decisions.

   ## Execution

   - Both paths reuse the existing reducers and wait/expiry/nonce logic. After
     dispatching a peer `agent.ask`, drain effects to deliver the durable peer
     prompt before waiting (as `runAgentAsk` does today).
   - Add routing metadata to the dialogue record: `routedTo` (role or `"developer"`),
     `routedBy: "classifier" | "policy"`, and `confidence`. Keep it within the
     existing dialogue byte/record bounds.

   ## Classifier integration

   Add a `question-routing` integration. The existing `ClassifierIntegration` type
   assumes a routing `target`; generalize it minimally (make `target` optional, or
   add a sibling decision shape) so a decision-only integration can register. Reuse
   A's runner for the two-question request and answer parsing.

   ## Audit

   Emit a telemetry event per routed question (target, confidence, authority) and
   surface auto-routed peer questions in the dashboard so the developer keeps
   visibility. No silent peer routing.

   ## Agent-facing docs

   Update `workflow-agent-protocol.md`: remove the two-tool guidance and the
   "prefer a completed peer" line; state that the agent asks one `question` tool and
   the engine routes it. The peer-answer guidance (`## Peer question from ...`)
   stays.

   ## Verification (required)

   - `bun run lint`, `bun run type-check`, `bun run build` in `agentic-coding/` with
     zero diagnostics. Never hand-edit `src/workflow/embedded.generated.ts`;
     regenerate with `bun run build`.
   - `bun test test/workflow-source-layer-boundaries.test.ts test/workflow-module-import-cycles.test.ts test/workflow-module-exports.test.ts`
   - Add/update tests:
     - `off` → developer always, even when peers are available.
     - authority high / no peers / low confidence → developer.
     - a valid peer choice → `agent.ask` with that role, prompt drained, answer
       returned.
     - chosen peer vanishes → developer fallback.
     - classifier error/timeout → developer, never blocked.
     - routing metadata recorded and within dialogue bounds.
     - the two old tools are no longer registered; one `question` tool is.

   ## Out of scope

   - Intra-session turns and workflow steering.
   - Peer-to-peer multi-hop questions.
   - Redaction or data-loss prevention for question content (full text is sent).
   - Changing `agent.answer` or the developer answer path.
