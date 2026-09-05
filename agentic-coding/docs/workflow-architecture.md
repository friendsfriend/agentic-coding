# Workflow architecture

Workflow code follows a one-way flow:

1. `src/workflow/definitions.ts` declares manifests, graph edges, and manifest
   policy.
2. `src/workflow/steps/` owns per-step behavior: agent role knowledge, entry
   guards, arrival semantics, entry effects, developer actions, and
   assignment-rendering overrides.
3. `src/workflow/runtime.ts` applies step-agnostic state-machine mechanics —
   transactions, persistence, the context carry-over resolver, and effect
   delivery — by delegating to the current step's behavior.
4. Effects execute external work. The serial effect runner claims one effect immediately before processing it, renews its token-bound lease while observation or execution is active, and cancels owned work when renewal fails. Expired claims consume attempts; an expired claim at the automatic attempt limit is failed transactionally and puts the workflow in `attention-required`. Explicit operator retry starts a fresh bounded attempt budget without changing the effect identity. Runner versions with this lifecycle must be deployed together; older drainers do not renew leases and can still reproduce the pre-fix expiry behavior.
5. CLI and TUI modules present workflow state.

`runtime.ts`, `definitions.ts`, and `cli.ts` are each now a re-export barrel
over a focused module tree (`runtime/`, `definitions/`, `cli/`) — see
[Module map](#module-map-after-split-workflow-god-modules) below. Every
importer listed above keeps importing the barrel path unchanged; the split is
a pure internal reorganization with no behavior change (digests, exports, and
the full test suite are unmodified oracles for that claim).

## Startup context and execution pins

CLI, dashboard, research, and wiki-comment starts use `src/workflow/startup.ts`.
The startup boundary resolves the selected repository before reading `.pi` project
configuration, so linked worktrees use the canonical repository source and
repository-independent workflows use global configuration. `HERDR_WORKFLOW_CONFIG`
is a full replacement and carries environment provenance.

Fusion routing has one precedence rule: an explicit ordered `--fusion-profiles`
list wins; otherwise the selected preset must provide contiguous `planner-1`
through `planner-N` roles (2–5). The resolved routing is pinned in the workflow
snapshot before effects run.

Non-secret delivery settings are pinned in `metadata.executionSettings`, including
the effective remote, resolved PR executable (or `null`), and config provenance.
Delivery effects never reread ambient cwd configuration. Legacy snapshots remain
readable but expose a revision-bound `preview-settings` then `adopt-settings`
flow when a sensitive delivery effect needs settings. The preview is fingerprinted
and must still match current configuration at acceptance; credentials are never
persisted.

The dashboard model-configuration modal displays the effective source and writes
back to that repository's selected config file, preserving layered-source conflict
checks.

## Step ownership

Step knowledge belongs only in `src/workflow/steps/`. The engine, CLI, and
dashboard read the registered step behavior (`StepDefinition.behavior`)
instead of keeping their own `core.*`/`fusion.*` id tables. Behavior is pure,
engine-internal (excluded from both `stepDigest()` and the definition digest —
editing behavior never produces a pin mismatch), and receives no database
handle; hooks that need to persist something declare it and the engine
performs the write.

`StepBehavior` hooks:

- `roles` / `candidateRoles` — which agent roles are active now / could ever be
  routed for this definition (stage A).
- `validateEvidence({ snapshot })` — entry-guard predicate run before a step's
  `complete` outcome is accepted; throws `WorkflowRuntimeError("entry-guard",
  ...)` to reject.
- `onArrive({ snapshot, edge, outcome, output, prior })` — derives arriving
  step-local state (attempt seeding, `mode`, preserved `results`,
  `selectedRoles`, terminal `status`). `prior` carries the pre-reset
  `{ attempt, results, context }` because `snapshot.step` is already replaced
  with a fresh attempt by the time the hook runs.
- `onEnter({ snapshot, enqueue, hasLiveRun })` — declares entry effects
  (`enqueue(kind, key, payload)`) and which candidate roles to skip launching
  this time (`hasLiveRun(role)` is a precomputed pending/working/validated
  check). Never receives `db`.
- `developerActions({ snapshot })` — the dashboard action list offered while
  this step is current. The engine's `status === "paused"` → `resume`
  short-circuit is the only action logic left outside this hook.
- `assignmentInputs({ snapshot, run })` — step-specific overrides for the
  rendered agent assignment (`taskLine`, `introLines`, `objective`,
  `interaction`, `permissions`, `checks`, `suppressStepInputLine`). Scoped to
  `{ snapshot, run }` only — a branch needing more (pane state, resolved
  profile beyond `readOnly`, adapter details) stays in `effect-runner.ts`.
- `instructionAssetForRole({ role })` — which pinned instruction asset (if
  any) a role-specific variant should read, out of several pinned under one
  step.
- `handoffNote` — replaces the rendered assignment's generic handoff guidance.
- Declared flags: `carriesOutputContext`, `acceptsCommentsContext`,
  `producesWikiVerificationContext` (context carry-over opt-ins, see below),
  `roundScoped` (triage/verification pane and agent-name grouping).

There are two intentional role-resolution moments:

- `candidateRoles` resolves every role a definition can use before routing is
  pinned. It is used to validate profile coverage and build routing.
- `roles` resolves the roles to fan out now from the pinned workflow snapshot.

They are separate because verification selects a subset at runtime, while its
candidate list must include every verifier for routing. Other steps derive both
answers from the same step-owned rule.

## Context carry-over precedence

`step.context` on arrival is resolved by one ordered rule list in
`runtime.ts`'s `resolveArrivalContext`, evaluated in this precedence order
(first match wins the *value*; any match satisfies the gate that a value is
set at all — see the note on the self-loop quirk below):

1. **`wiki-comments` definition override** — if the workflow definition is
   `wiki-comments` and a prior context exists, it is kept verbatim. A
   definition-level check (not a step flag), since it applies regardless of
   which step is arrived at.
2. **Generic loop self-edge** — `edge.loop && edge.to === edge.from` with a
   defined prior context. Structural (based on the edge shape, not step
   identity); no step opts in.
3. **`carriesOutputContext`** — the arriving step declares it carries the
   command's `output` forward as the new context (`core.plan`,
   `core.implementation`, `core.verification`, `core.wiki`,
   `fusion.consolidate`).
4. **`acceptsCommentsContext`** — the arriving step declares it accepts a
   `comments`-outcome context (`core.wiki`, `core.archive`).
5. **`producesWikiVerificationContext`** — the arriving step declares that a
   `complete` outcome produces the wiki verification payload
   (`core.wiki-approval`).

Load-bearing quirk this stage preserved exactly rather than "fixing": the
*value* computation only special-cases rule 1 (keep prior) and rule 5
(compute the wiki verification payload); every other matching rule — including
rule 2, the generic self-loop — falls through to "use `output` if defined,
else keep prior context". A self-loop retry that carries a defined `output`
(for example a `blocked` message) therefore replaces the context instead of
preserving it. `test/workflow-steps.test.ts`'s context carry-over suite pins
this precedence and the self-loop case directly via the exported
`runtimeTest.resolveArrivalContext`.

## Manifest policy and the version-bump rule

`WorkflowManifest.policy` (`registry.ts`) is a declarative replacement for the
engine's former `isWikiWorkflowTarget` / `isResearchWorkflowTarget` /
definition-id checks *at workflow start time*: `targetKind`
(`repository` | `wiki` | `research`), `checkoutRequired`, and
`requiresReadOnlyResearcher`. `WorkflowRegistry.registerWorkflow` validates it
(unknown target kind, or a contradictory combination such as
`requiresReadOnlyResearcher` outside the `research` target) and names the
manifest in the rejection.

**The rule:** adding a field to an existing registered manifest changes its
digest, because `CompiledWorkflowDefinition.digest` is computed over the whole
manifest (`digest({ ...manifest, stepDigests })`), not an allowlist like
`stepDigest()`. A definition version already running in production cannot
gain `policy` without silently stranding every in-flight workflow pinned to
its old digest as `pin-mismatch`. So `policy` is never added to an existing
version — it is registered under a **new** version, following the precedent
`definitionVersionForPolicy` (wikiGate legacy/policy dual registration)
already set:

- Legacy tier: `rounds` (with the historical `6→1`, `1→21` swaps) — no wiki
  gate, no `policy`.
- wikiGate-policy tier: `definitionVersionForPolicy(rounds)` = `rounds + 100`
  — wiki gate, no `policy`.
- **Manifest-policy tier:** `definitionVersionForManifestPolicy(rounds)` =
  `rounds + 200` — wiki gate and `policy`. This is the version
  `startWorkflowInProcess` / `cli.ts`'s `start` command actually use for new
  workflows.

All three tiers stay registered; nothing is removed. `start()` reads policy
through `effectiveManifestPolicy(definition)`, which falls back to the same
per-id table the manifest-policy tier is built from when a resolved
definition has no `policy` block (any legacy or wikiGate-policy version).
This is why a workflow pinned to a pre-manifest-policy version still starts
and dispatches without repair: `policy` is read only inside `start()` — no
other engine function references it — so it cannot affect an already-running
workflow's `transition`/`dispatch`/`validateStepEvidence`/`actions` path.

## Remaining step-identity matches outside `src/workflow/steps/`

Audited per this stage's task 6.1/6.4 by grepping `src/workflow/` and
`src/tui/` for `"core.` / `"fusion.` literals and mapping every match to its
enclosing function. Everything below is either a definition-id check (a
different axis from the `core.*`/`fusion.*` step-id goal), a
security/capability boundary this stage's non-goals explicitly leave alone,
or explicitly deferred to a later stage. **`runtime.ts` still has ten
functions with step-id literals** — this stage's design named only
`transition`, `enterStep`, `validateStepEvidence`, and `actions` as in scope,
so the other ten are recorded here rather than moved, to keep this diff's
blast radius to the named functions:

| Location | What it checks | Why it stays |
| --- | --- | --- |
| `runtime.ts` `start()` (~line 434) | `definition.steps.includes("core.wiki")` (whether to seed `metadata.wikiRoot`) | Start-time setup outside the four named functions; not a `transition`/`enterStep`/`validateStepEvidence`/`actions` branch. |
| `runtime.ts` `migrateLegacy()` (~lines 1082–1093, 1200–1202) | The legacy phase-name → step-id map (`explore` → `core.plan`, etc.) and a `core.verification` round-seed check | One-time import of pre-this-engine snapshot shapes; the map's *keys* are legacy phase names, not step ids, so collapsing it into `StepBehavior` would need a new phase-name-owning hook for a migration path, not step semantics. |
| `runtime.ts` `recordResearchHandoff()` (~line 1530) | `command.stepId !== "core.research"` | Authenticates that a handoff command names the live researcher run; a security boundary, not step business logic. |
| `runtime.ts` `developerAction()` (~lines 1815, 1835, 1849) | `snapshot.currentStep !== "core.research"` gating `close-research`/`research-follow-up` | Duplicates the same rule `developerActions()` already encodes (task 5.3) as the action *availability* rule; this function enforces it a second time as a command-time invariant so a stale/forged `actionId` cannot bypass the check the dashboard already hides. |
| `runtime.ts` `agentHandoff()` (~lines 2055–2195) | `run.stepId === "core.wiki"` / `"core.triage"`, `snapshot.currentStep === "core.triage"` / `"core.verification"` / `"fusion.plan"` / `"core.plan"` / `"fusion.consolidate"` / `"core.implementation"` / `"core.completed"` / `"core.closed"` | The largest concentration outside the four named functions: per-outcome completion handling (evidence validation dispatch, `selectedRoles`/`results` bookkeeping, round-limit routing). This is exactly the kind of per-step completion logic stage B's hooks target, but it was not in this stage's design inventory (see design.md's task 6.1 table) and reworking it means re-deriving `transition`'s sibling function with the same rigor — left for stage C, when `runtime.ts` is split and this function's boundary is reconsidered alongside `transition`/`enterStep`. |
| `runtime.ts` `effectResult()` (~lines 2273–2282) | `snapshot.currentStep === "core.plan"` / `"fusion.consolidate"` / `"core.delivery"` | Effect-completion routing (an `openspec.validate` pass self-completes plan/consolidate; `delivery.commit` chains into `delivery.push`). Same disposition as `agentHandoff()`. |
| `runtime.ts` `createRun()` (~line 2565) | `step.id === "core.research"` (narrows `allowedOutcomes` to exclude `complete`) | A capability-shaping rule (research never hands off `complete`), adjacent to but distinct from `StepBehavior`; not in this stage's inventory. |
| `runtime.ts` `validateEffect()` (~lines 2718–2740) | `snapshot.currentStep === "core.delivery"` / `"core.research"` / `"core.completed"` | Effect-legality exceptions (wiki-verify promoted at delivery/completion, research's workspace-setup-before-entry ordering) — a persistence/outbox invariant, not step business semantics. |
| `runtime.ts` `stopRoundAgents()` (~line 3184) | `snapshot.currentStep === "core.triage"` | Decides which live runs to stop when a verification round closes; tied to `roundScoped` conceptually but not yet reading it. |
| `runtime.ts` `validateFusionRouting()` (~line 3256) | `route.stepId === "fusion.plan"` | Routing-shape validation for the fusion fan-out, called only for the two fusion definition ids — a routing concern, not step business semantics. |
| `effect-runner.ts` `assignmentFor` (`core.triage` changed-files line) | `run.stepId === "core.triage"` | Needs `changedFilesIn`, a `runtime.ts`-resident git-status walker; moving it means either splitting `runtime.ts` (stage C's job) or duplicating a non-trivial recursive helper. Recorded out of scope per design D5. |
| `adapters.ts` (`ctx.assignment.stepId !== "core.research"`, ×3) | launch-context tool/extension selection | Needs adapter launch context, not `{snapshot, run}`; not named in this stage's design inventory. |
| `cli.ts` `authorizeWikiWriter`, research-handoff restriction | `stepId === "core.wiki"`, `"core.research"` | Capability/authorization boundaries — this stage's non-goals explicitly exclude capability handling changes. |
| `registry.ts`, `cli.ts` `rolesForDefinition` (`fusion.plan` empty-candidate exemption) | `id === "fusion.plan"` | A registration-time structural invariant (which step may have zero catalog-time candidates), not step business semantics. |
| `contracts.ts` `parseSnapshot()` (~line 1061) | `snapshot.status === "active"` combined with `["core.completed", "core.closed"].includes(snapshot.currentStep)` (rejects an `active` status at a terminal step) | A schema-level snapshot invariant enforced while deserializing/validating persisted JSON, before any `StepBehavior` lookup is possible from the raw input; a data-shape guard, not step business semantics. |
| `src/tui/dash/*.ts`, `src/tui/*.tsx` | None (stage D closed this row) | `tui/dash/data.ts`'s `requiredUserActionFor` derives which actions to show from the engine view's `availableActions` array (keyed by action id), not from step or definition ids; `App.tsx`'s review-popup and submit-path selection switches on the required action's stable `key` instead of comparing `stepId` to `core.*` literals. The dashboard is an action *client*: it owns presentation copy (titles, prompts, item labels) keyed by action id, and a narrow legacy fallback for a view with no `availableActions` array at all, but it derives, extends, or filters nothing from step or workflow definition identifiers. |

Not included above because they check `snapshot.definition.id` (a workflow
*definition* id such as `"research"`, `"wiki-comments"`, `"no-openspec"`) and
never a `core.*`/`fusion.*` *step* id: `validateTriageScope()`,
`validateSourceBaseline()`, and `wikiVerificationPayload()`. Those are a
different axis from this stage's goal and were miscategorized in an earlier
draft of this table.

`effect-runner.ts`'s `roundScoped`, `assignmentFor`'s research/wiki
objective/permissions/checks branches, `assignment.ts`'s wiki-role asset map
and research handoff note, and `profiles.ts`'s
`enforceResearchReadOnlyRouting` are the branches this stage *did* move —
they now read `StepBehavior.roundScoped`, `assignmentInputs`,
`instructionAssetForRole`, `handoffNote`, and the caller-supplied
`definition.initial` (instead of a hardcoded `"core.research"`),
respectively.

## Module map (after split-workflow-god-modules)

`src/workflow/runtime.ts`, `src/workflow/definitions.ts`, and
`src/workflow/cli.ts` are re-export barrels; their pre-split export surface
is pinned by `test/workflow-module-exports.test.ts` against
`test/fixtures/workflow-god-module-export-surface.json`, and
`test/workflow-module-import-cycles.test.ts` asserts no module under
`runtime/`, `definitions/`, or `cli/` imports its own parent barrel.

### `src/workflow/runtime/`

Dependency order is enforced one-way (a lower row never imports a higher
row):

| Module | Owns |
| --- | --- |
| `targets.ts` | Change-id validation, the wiki/research repository-independent target locators, canonical repository/store path resolution. |
| `store.ts` | Schema DDL, row mapping, open/close, snapshot/run/effect read-write helpers, plus the registry-only structural invariants (`validateStructure`, `validateSnapshot`, `validateEffect`, `actions`, `requireRevision`) and the due-question-expiry read path (`expireDueQuestions`, `getSnapshot`) — grouped here because none of them touch anything beyond `registry` and an already-open `db`, so they sit at the foundation alongside row IO rather than needing a home in a higher tier. |
| `evidence.ts` | Git inspection, source-content fingerprinting, changed-file discovery, current-branch lookup, wiki baseline/verification content reads — all external-I/O reads. |
| `capability.ts` | **The security boundary** (design D2): token hashing/comparison, run capability issuance, agent and exact-run authorization, and the `MAX_ARTIFACT_BYTES`-bounded artifact checks. Extracted as one cohesive unit so it can be reviewed and tested as a whole. |
| `dialogue.ts` | Developer-question dialogue: resolving the run a question command acts on (`questionRun`), answering a question or questionnaire (`answerQuestion`), and marking questions expired (`expireQuestions`). Needs only the clock. |
| `engine-types.ts` | Public request/result shapes (`StartWorkflowInput`, `DispatchResult`, `ClaimedEffect`, `RepairPreview`) factored out so leaf modules can reference them without importing `engine.ts`. |
| `kernel.ts` | The shared step-transition primitives every reducer and `engine.ts` need: `enqueue`, `applyReduction`, `createRun`, `enterStep`, `transition`, plus the pure step-shape helpers (`freshStep`, `resolveArrivalContext`, fusion routing/draft helpers) and round-cleanup helpers (`stopRoundAgents`, `expireRuns`, `expireSiblingRuns`). Kept separate from `engine.ts` because `migration.ts` and every `reducers/*.ts` module need these without needing the `WorkflowEngine` class itself — importing `engine.ts` from either would close the cycle `engine.ts -> reducer -> engine.ts`. |
| `migration.ts` | Legacy `workflows`-table discovery, phase-to-step mapping, legacy evidence conversion, migration diagnostics. **Thinnest test coverage in the package** (`test/workflow-migration.test.ts` is the only oracle) — moved verbatim with no signature change beyond taking `registry`/`now` as explicit parameters. |
| `view.ts` | The read model: `view`, `list`, `status`, `previewRepair`, and the run/effect projection into `WorkflowView`. Read path only. |
| `reducers/*.ts` | One file per `reduce()` command branch (or a small explicitly-grouped set: `agent-question.ts` holds both `agent.question` and `agent.question-expire`; `repair.ts` holds `operator.repair`, `operator.repin`, and `operator.resume`). Each reducer receives `registry`/`now` as explicit parameters and the already-open `db`/`snapshot` — it runs inside the kernel's existing transaction, never opening its own. |
| `engine.ts` | The `WorkflowEngine` class: `start`, `dispatch`, the `reduce()` command-type dispatch table, `claimEffects`, `telemetry`, `locate`, and thin public-API delegates to the modules above. The residue once every leaf/feature/reducer is moved out. |

### `src/workflow/definitions/`

| Module | Owns |
| --- | --- |
| `catalog.ts` | `PUBLIC_WORKFLOW_CATALOG` — the human-facing workflow family list. |
| `contracts.ts` | The step output contracts (`triage`, `findings`, `planDraft`, `passthrough`, `empty`) and the standalone `researchHandoffContract`. |
| `steps.ts` | The `step()` factory, per-step instruction asset list, and the full `WORKFLOW_STEPS` catalog. |
| `edges.ts` | `workflowEdges()` (the shared implementation-loop edge builder) and `definitionVersionForPolicy`. |
| `manifest-policy.ts` | The manifest-policy tier (design D1): the per-workflow-id policy table, `definitionVersionForManifestPolicy`, `effectiveManifestPolicy`. |
| `graphs/*.ts` | One file per workflow family — `openspec.ts`, `no-openspec.ts`, `fusion.ts`, `wiki.ts`, `research.ts` — each exporting a manifest-builder function for that family only. |
| `registerBuiltins.ts` | Orchestrates step registration and every family's graphs across every verification-round count and wikiGate/manifest-policy tier. |

### `src/workflow/cli/`

| Module | Owns |
| --- | --- |
| `args.ts` | argv parsing primitives (`flag`, `requireFlag`, `positionals`, `parseInput`, `parseInlineJson`). |
| `git.ts` | `runGit`. |
| `caller-environment.ts` | Process-ancestry authentication for managed-agent commands (`callerEnvironment`, `managedAgent`, `managedWorkflowTarget`). |
| `identity.ts` | `resolveHandoffIdentity` — resolves and authorizes the run identity a handoff/question/research-handoff command acts on. |
| `schema.ts` | `SUBCOMMANDS`, `REQUIRED_FLAGS`, subcommand vocabularies, and the flag/positional-argument schema validator. |
| `help.ts` | Usage text. |
| `registry.ts` | The process-lifetime builtin registry and `engine()`. |
| `pane.ts` | Pane allocation for a launched run (`paneForRunFactory`, `verificationPosition`). |
| `drain.ts` | `drainEffects`, `detachedDrainArgv`. |
| `commands/*.ts` | One module per command (or small group): `start.ts`, `dispatch-actions.ts` (action/question/handoff), `wiki.ts`, `research-handoff.ts`, `misc.ts` (repair/repin/agent-extension/listProjects). |
| `run.ts` | The command-name lookup table that replaces the former `run(argv)` branch chain, plus `main` and the test-only `cliTest` bundle. |

### Extending the split without touching unrelated modules

- **New workflow family:** add `definitions/graphs/<family>.ts` exporting a
  manifest-builder function, then add it to `registerBuiltins.ts`'s
  `manifests()` concatenation. Do not touch `steps.ts` or another family's
  graph file.
- **New CLI command:** add `cli/commands/<command>.ts`, then register it in
  `cli/run.ts`'s `COMMAND_HANDLERS` table (or as an early special-case next to
  `wiki`/`config`/`projects` if it must run before `repo`/`engine` setup). Add
  its flag schema to `cli/schema.ts`.
- **New reducer (new `WorkflowCommand` variant):** add
  `runtime/reducers/<command>.ts` exporting a function that takes
  `(db, snapshot, definition, command, registry, now)` and returns
  `{ type, actor, data }`, then add a branch in `engine.ts`'s `reduce()`
  dispatch table. It may import any of `store.ts`, `evidence.ts`,
  `capability.ts`, `dialogue.ts`, and `kernel.ts`, but never `engine.ts` or
  another `reducers/*.ts` module — that would risk the
  `engine.ts -> reducer -> engine.ts` cycle design D5 calls out. A reducer
  that turns out to need something not expressible via those modules stays a
  private method on `WorkflowEngine` in `engine.ts` instead of widening this
  contract.

## Adding a step

1. Add the versioned step contract and graph references in `definitions.ts`.
2. Add a behavior entry in the appropriate module under `src/workflow/steps/`.
3. Provide both role hooks for agent steps, or an empty behavior for developer
   and system steps. Add `validateEvidence`, `onArrive`, `onEnter`,
   `developerActions`, `assignmentInputs`, `instructionAssetForRole`, or the
   context carry-over flags only if the step needs them.
4. Keep behavior pure and module-level; do not import runtime, definitions, or
   CLI from a step module. Entry guards that throw use
   `WorkflowRuntimeError` from `contracts.ts` (not `runtime.ts`, to avoid a
   cycle through `definitions.ts` → `steps/index.ts`).
5. Add role parity and digest coverage, then run the focused workflow tests,
   type-check, format, lint, and build.

## Planned follow-ups

Stage A (`restructure-repo-for-agent-use`), stage B
(`move-step-semantics-to-behavior-hooks`), and stage D
(`derive-dashboard-actions-from-engine`) are complete. Remaining stage:

Stage C (`split-workflow-god-modules`) is also complete: `runtime.ts`,
`definitions.ts`, and `cli.ts` are now re-export barrels over the module trees
described in [Module map](#module-map-after-split-workflow-god-modules) above.
The file-and-line references in the step-identity table above predate that
split; the qualitative disposition of each match is unchanged, but the
functions now live in `runtime/kernel.ts` (`transition`, `enterStep`,
`stopRoundAgents`, `validateFusionRouting`), `runtime/reducers/agent-handoff.ts`
(`agentHandoff`), `runtime/reducers/effect-result.ts` (`effectResult`),
`runtime/reducers/developer-action.ts` (`developerAction`),
`runtime/reducers/research-handoff.ts` (`recordResearchHandoff`),
`runtime/migration.ts` (`migrateLegacy`), `runtime/store.ts` (`validateEffect`),
and `runtime/kernel.ts` (`createRun`) rather than directly in `runtime.ts`.

Stage D also resolved two live divergences between the engine's action list
and the dashboard's own (now-deleted) copy: a completed `wiki-comments`
workflow no longer offers `create-pr` (the engine never reported it as
available), and the dashboard's undispatchable `close-clean` menu item is
removed outright — it duplicated `workspace.cleanup`, which the engine
already enqueues automatically after every `workspace.close` completes, so
there was no missing capability to add.
