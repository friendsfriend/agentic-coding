Not for agents. This is only for humans.

Fixes: 

Big ones:
* Agent steered version of the workflow. Basically an orchestrator version of the workflow.
* subagent system for workers
* Make otel work for apps that are launched via the environment as well (Introduce Agent skill for setup)
* Agent skills to create the environments for a fresh app.

Small ones: 
* (Maybe) Give all agents their own tab. Multitab spawning always has issues for some reason
* Improve agent steering based on recent runs (observability first)
* make verifier tabs use quality-v... (use ... glyphe to save space) instead of quality-verifier

Promps (jev):

Part one (triage categories):
 # Task: Classifier-driven verifier-role selection for `core.triage`

   You are implementing a design in the repository at `/home/archgamer/agentic-coding`
   (the `agentic-coding/` Bun/TypeScript package). Work on a feature branch with
   OpenSpec: create the change proposal first, then implement.

   ## Dependency

   This builds on the "model pools / JEV per-step routing" change (design A), which
   replaces the OpenSpec catalog with `openspec`, `openspec-apply`,
   `openspec-propose`, `openspec-fusion`, `openspec-fusion-propose`, adds
   `core.route-plan` / `core.route-apply` system steps, and makes the JEV classifier
   drive routing via a `model.classify` effect. Implement on top of it. If that work
   is not merged yet, the graph ids and classifier-effect pattern below are the
   target; coordinate rather than duplicating the runner.

   ## Read first (required)

   - `AGENTS.md`, `agentic-coding/docs/workflow-architecture.md`
   - `agentic-coding/src/workflow/steps/verification.ts` (`triageCompletion`,
     `verificationCompletion`, `core.verification.roles`, `VERIFIER_ROLES`,
     `TRIAGE_ROLES`)
   - `agentic-coding/src/workflow/definitions/contracts.ts` (`triage` /
     `core.triage-plan`), `definitions/steps.ts`, `definitions/edges.ts`
     (`workflowEdges`, `COMMON_IMPLEMENTATION_STEPS`)
   - `agentic-coding/src/workflow/classifiers.ts`,
     `classifier-runner.ts`, `effect-runner.ts` (`model.classify`),
     `runtime/reducers/effect-result.ts`
   - `agentic-coding/src/workflow/runtime/evidence.ts` (`changedFilesIn`,
     `changedFilesInAsync`)
   - `agent-definitions/instructions/triage.md`
   - External: https://docs.typesafe.ai/primitives/noul.md ,
     https://docs.typesafe.ai/patterns/fan-out.md

   ## Goal

   Split triage's two jobs. Today `core.triage` both selects verifier roles and
   scopes each role to relevant changed files. Make JEV decide **which verifier
   roles run** via independent per-role `noul` questions, and keep the triage agent
   responsible only for **scoping files** to the selected roles. This preserves the
   per-verifier context slimming while making role selection deterministic and
   cheap. Let the classifier decide **all** roles (no forced baseline).

   ## Locked decisions (do not re-litigate)

   1. One `noul` question per eligible role. Include the role when
      `noul >= 0.5`. No forced baseline: `quality-verifier` and `openspec-verifier`
      are classifier-decided too. `test-verifier` is never a question — the engine
      still auto-launches it after the selected verifiers pass.
   2. Eligible roles are `TRIAGE_ROLES` (`VERIFIER_ROLES` minus `test-verifier`),
      minus `openspec-verifier` for the `no-openspec` definition.
   3. **Zero roles is allowed.** A config-only change may select none. Zero means
      skip all domain verifiers and run only the full-suite `test-verifier`, then
      pass. Truly skipping verification and tests is out of scope (a later change).
   4. The triage agent may emit a **subset** of the classifier-selected roles
      (drop a role with no relevant files), but must never add one. Engine validates
      `output.roles` ⊆ classifier selection.
   5. Classifier state = the changed-file manifest plus capped diffs. Reuse
      `changedFilesInAsync` so the state matches exactly what the engine validates
      (`ctx.changedFiles`). Cap total diff bytes (mirror
      `CLASSIFIER_TOTAL_CAP_BYTES`) and per-file diff bytes; on overflow truncate
      deterministically. **Paths are always complete**, even when diffs truncate.
   6. Classifier error / missing key → fail open: run `core.triage` unconstrained
      (current behavior), record `attention`. Verification must never be blocked by
      a classifier outage.
   7. `noul` answers carry no `confidence`; `0.5` is the only gate. Reuse the
      existing System One endpoint/profile (`jev-classifier`,
      `opencode/jev-1.13-free`).

   ## Step and graph changes

   Add a system step `core.triage-route` immediately before `core.triage`, in the
   shared implementation loop (`COMMON_IMPLEMENTATION_STEPS` / `workflowEdges`) so it
   re-runs each verification round:

 ```

 core.implementation → core.triage-route → core.triage → core.verification
                           │
                           └─ empty → core.verification   (bypasses triage)

 ```

   - `core.triage-route`: system, outcomes `["complete", "empty"]`,
     `allowedEffects: ["model.classify"]`, `retryLimit: 3`.
     - `onEnter` enqueues `model.classify` with payload `{ integration: "triage" }`.
     - `onEffectComplete`: selected roles `>= 1` → transition `complete`.
       Zero roles → transition `empty` with output `{ roles: [] }`.
   - Register the new step in the definitions/registry, add the edges
     (`complete` → `core.triage`, `empty` → `core.verification`), and add its
     instruction-asset entry if the registry requires one (system steps with no
     agent may need none).

   ## Classifier protocol

   - New `triage` integration in `classifiers.ts`, using `type: "noul"` questions.
     Question ids map to roles, e.g.:
     - `needs_quality_verifier`
     - `needs_security_verifier`
     - `needs_performance_verifier`
     - `needs_openspec_verifier` (omit for `no-openspec`)
     - `needs_usability_verifier`
     - `needs_concurrency_verifier`
     - `needs_migration_verifier`
     - `needs_test_quality_verifier`
     Each `instructions` is the role's question (correctness gates; trust
     boundaries/secrets/injection; hot paths/latency; OpenSpec conformance;
     UI/UX/accessibility; races/ordering/shared mutable state; persisted
     format/version/upgrade; test adequacy).
   - Extend the runner to parse `noul` answers: `{ type: "noul", noul: number }`.
     (`model.classify` currently parses only `choice`; A already widens it to the
     full answer shape — add the `noul` case if not present.)
   - One request, all eligible roles, in parallel. State assembly: task + plan
     summary + the bounded changed-file corpus.

   ## Routing / reducer

   - `effect-runner.ts` `model.classify`: handle `integration: "triage"` by
     assembling the triage state (not plan artifacts) and invoking the `triage`
     integration.
   - `effect-result.ts`: pass the selected roles into the triage step so
     `core.triage` can constrain scoping. A clean shape is to carry them in the
     arriving step's context/output that `core.triage` reads, analogous to how
     `core.verification` currently receives `output.roles`.
   - `core.triage` behavior: keep `triageCompletion`, but validate the agent's
     emitted `roles` is a subset of the classifier selection, and carry only those
     roles forward to `core.verification`.

   ## Zero-role behavior

   - `core.triage-route` `empty` transitions to `core.verification` with
     `{ roles: [] }`.
   - Change `core.verification.roles`' empty fallback from `["quality-verifier"]`
     to `["test-verifier"]`. Confirm `verificationCompletion` still passes for a
     sole `test-verifier` run.
   - `testRunStarted` semantics remain; do not change the auto-launch-after-pass
     behavior for the non-empty case.

   ## Triage instruction rewrite

   Update `agent-definitions/instructions/triage.md`: the agent no longer chooses
   roles. It receives the locked role set and must (a) scope each role to the
   changed files it must see, (b) never introduce a role outside the set, (c) reuse
   prior PASS evidence as today. Keep the existing output shape and examples; remove
   the role-selection table narrative or reframe it as scope guidance.

   ## Verification (required)

   - `bun run lint`, `bun run type-check`, `bun run build` in `agentic-coding/`
     with zero diagnostics. Never hand-edit `src/workflow/embedded.generated.ts`;
     regenerate with `bun run build`.
   - `bun test test/workflow-source-layer-boundaries.test.ts test/workflow-module-import-cycles.test.ts test/workflow-module-exports.test.ts`
   - Add/update tests:
     - classifier: `noul` parsing and role mapping at the 0.5 boundary.
     - step/registry: `core.triage-route` behavior (complete vs empty), the new
       graph edges, and a zero-role run reaching `core.verification` with
       `test-verifier` only.
     - triage completion: subset accepted, superset rejected, files-outside-scope
       still rejected.
     - state collector: total/per-file diff caps, truncation preserves all paths.
     - fail-open: classifier failure leaves triage unconstrained and records
       `attention`.

   ## Out of scope

   - Skipping verification/tests entirely (a later skip/reduce-stages change).
   - Replacing triage scoping with per-file classifier domain tagging (would drop
     the agent; separate change).
   - Classifier-driven question routing (separate change).
   - Model selection: `core.verification` still uses the model pool from design A
     for whatever roles run. B4 only changes which roles run.
     


---------------------

Phase gating depending on the changes
# Task: Configurable stage gates (plan approval, triage+verification, developer review, wiki)

   You are implementing a design in the repository at `/home/archgamer/agentic-coding`
   (the `agentic-coding/` Bun/TypeScript package). Work on a feature branch with
   OpenSpec: create the change proposal first, then implement.

   ## Dependency

   This builds on two earlier changes:
   - **A** — model pools / JEV routing: catalog ids `openspec`, `openspec-apply`,
     `openspec-propose`, `openspec-fusion`, `openspec-fusion-propose`; system steps
     `core.route-plan` / `core.route-apply`; classifier-driven routing via a
     `model.classify` effect; preset `pools`.
   - **B4** — verifier-role selection: a system step `core.triage-route` before
     `core.triage` that runs per-role `noul` questions, with outcomes `complete`,
     `empty` (zero roles → test-verifier only), and a changed-file classifier-state
     collector.

   Implement on top of both. Reuse their `model.classify` phase pattern, state
   collector, threshold, and fail-open behavior.

   ## Read first (required)

   - `AGENTS.md`, `agentic-coding/docs/workflow-architecture.md`
   - `agentic-coding/src/workflow/definitions/edges.ts` (`workflowEdges`,
     `COMMON_IMPLEMENTATION_STEPS`), `definitions/graphs/{openspec,fusion}.ts`
   - `agentic-coding/src/workflow/steps/lifecycle.ts` (`core.plan-approval`,
     `core.developer-review`), `steps/verification.ts`
   - `agentic-coding/src/workflow/classifiers.ts`, `classifier-runner.ts`,
     `effect-runner.ts` (`model.classify`), `runtime/reducers/effect-result.ts`
   - `agentic-coding/src/workflow/profiles.ts` (`PresetConfig`, `RoutingPreset`),
     `src/tui/settings/agentPresets.ts`, `AgentPresetsView.tsx`
   - External: https://docs.typesafe.ai/primitives/noul.md
   - A's and B4's OpenSpec changes.

   ## Goal

   Add a unified, configurable "stage gates" mechanism. A classifier decides whether
   a stage is needed; when skipped, the engine routes around it. Four gates, each a
   system step with one classifier decision:

   | Gate policy | Guards | Decision step | Decision state |
   |---|---|---|---|
   | `planApproval` | `core.plan-approval` | `core.plan-gate` (after plan, before approval) | plan artifacts |
   | `verification` | `core.triage` + `core.verification` | `core.triage-route` (B4, after implementation) | changed files + diffs |
   | `developerReview` | `core.developer-review` | `core.review-gate` (after verification) | diffs + verification results |
   | `wiki` | `core.wiki` + `core.wiki-approval` | `core.wiki-gate` (after review/approved) | plan + changed files |

   **Triage and verification are one gate and cannot be separated.** There is no
   separate `triage` policy and no "verification without triage" path. `core.archive`
   is **never gated** — archiving is mandatory for OpenSpec to complete.

   ## Locked decisions (do not re-litigate)

   1. Config lives on the preset as `gates`, with a global `agents.gates` fallback,
      then `always`:
      ```json
      "gates": {
        "planApproval":    "always" | "auto",
        "verification":    "always" | "auto",
        "developerReview": "always" | "auto",
        "wiki":            "always" | "auto"
      }
 ```

    always is the default for every stage: the gate step short-circuits locally
    (forced run, no API call). auto lets the classifier skip.
 2. Threshold is 0.5 on the noul probability; run when >= 0.5, skip
    below. noul has no confidence.
 3. Skip-both safeguard: full verification+review skip is only possible when
    both verification and developerReview are auto. This falls out of the
    graph — triage-route's skip-verification always routes through
    core.review-gate, which only skips when its own policy is auto.
 4. Review and wiki use two separate decision steps/calls; do not combine them.
 5. Classifier error / missing key → forced run + attention (never skip).

 Steps and edges

 New system steps, each outcomes as below, allowedEffects: ["model.classify"],
 retryLimit: 3:

 ```
   plan → plan-gate ─ run  → plan-approval ─ approve → route-apply   (full/fusion)
                     └ skip → plan-approval's approve target          (propose flows: completed)

   implementation → triage-route ─ complete          → triage → verification
                                 ├ empty             → verification        (test-verifier only)
                                 └ skip-verification → review-gate

   verification pass → review-gate ─ run  → developer-review
                                    └ skip → wiki-gate        (or approved when no wikiGate)

   developer-review approve → wiki-gate
   wiki-gate ─ run  → wiki → wiki-approval → archive → delivery
             └ skip → archive (or delivery when no archive)
 ```

 - core.plan-gate: outcomes ["run", "skip"]; only present in definitions that
   have core.plan-approval. skip mirrors core.plan-approval's approve target.
 - core.triage-route (extend B4): outcomes ["complete", "empty", "skip-verification"]. Drop any scope-direct path.
 - core.review-gate: outcomes ["run", "skip"]; skip → core.wiki-gate when
   the wiki gate exists, else the archive/delivery target.
 - core.wiki-gate: outcomes ["run", "skip"]; only present when wikiGate;
   skip → core.archive (or core.delivery when the definition has no archive).
 - Change core.verification pass edge from core.developer-review to
   core.review-gate.
 - Change core.developer-review approve target from approved to
   core.wiki-gate when the wiki gate exists, else the archive/delivery target.
 - Add all edges in workflowEdges (and the graph builders for plan-gate),
   where the approved/archive/delivery targets are known.

 Classifier protocol

 - Integration gate, payload { integration: "gate", stage } where stage is
   planApproval | developerReview | wiki; one noul per call:
     - planApproval: "Should a developer review and approve this plan before implementation?"
     - developerReview: "Should a developer review this change before it is archived and delivered?"
     - wiki: "Does this change require a wiki documentation update?"
 - Integration triage at core.triage-route (B4): the existing role nouls plus
   one needs_verification noul:
   "Does this change require independent verification before it is archived?"
 - The runner reads the gate policy from the selected preset; always returns
   forced run without an HTTP request. State assembly per stage: plan artifacts
   for planApproval; changed files + capped diffs for verification; diffs +
   verification results for developerReview; plan + changed-file summary for
   wiki.

 triage-route routing

 - needs_verification false → skip-verification (skips both triage and
   verification).
 - true and roles >= 1 → complete → core.triage → core.verification.
 - true and roles == 0 → empty → core.verification (test-verifier only; this
   is a reduction, not a skip).
 - Tagged default roles (B4) still apply when the roles question is involved.

 Audit and observability

 - Record each gate's decision (stage, noul, policy) on the snapshot context.
 - On an actual skip, emit a notification.show and a telemetry event naming the
   skipped stage and value, and surface skipped stages in status/the dashboard.
   A skipped test suite or human review must never be silent.

 Settings UI

 Add a "Stage gates" section to the preset editor: one select per stage
 (always / auto) using the existing text/select Form primitives. Do not add
 a new field kind.

 Verification (required)

 - bun run lint, bun run type-check, bun run build in agentic-coding/ with
   zero diagnostics. Never hand-edit src/workflow/embedded.generated.ts;
   regenerate with bun run build.
 - bun test test/workflow-source-layer-boundaries.test.ts test/workflow-module-import-cycles.test.ts test/workflow-module-exports.test.ts
 - Add/update tests:
     - gate policy matrix: always sends no question and routes run; auto uses
       the noul threshold.
     - triage-route: complete / empty / skip-verification with the
       needs_verification gate, including zero-role reduction vs full skip.
     - skip-both safeguard: verification auto-skip with developerReview: always
       still enters core.developer-review.
     - review-gate and wiki-gate skip/run routing, including the no-wikiGate and
       no-archive variants.
     - plan-gate skip routing in full and propose flows.
     - fail-open: classifier failure forces run and records attention.
     - audit: a skip emits the notification/telemetry and appears in status.
     - that core.archive has no gate and is always reachable.
 - Docs: workflow-architecture.md step list, README, settings-inventory.md.

 Out of scope

 - Gating core.archive (mandatory).
 - Per-turn effort escalation.
 - Classifier-driven question routing (peer vs developer).
 - Any per-step model selection: still design A's pools.


------------------------------

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
