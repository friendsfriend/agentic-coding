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
4. Effects execute external work. The serial effect runner claims one effect immediately before processing it, then runs each claim inside one Effect execution scope with a supervised renewal fiber using the engine clock: observation, execution, renewal, and finalization share ownership context. Rejected or exceptional renewal interrupts external work, and final lease validation gates result publication. Handler failures are classified (transient retries through the durable outbox, permanent/defect failures enter attention immediately, ownership loss never publishes, interruption claims nothing) and a failed observation is never treated as confirmed absence. Expired claims consume attempts; an expired claim at the automatic attempt limit is failed transactionally and puts the workflow in `attention-required`. Explicit operator retry starts a fresh bounded attempt budget without changing the effect identity. Runner versions with this lifecycle must be deployed together; older drainers do not renew leases and can still reproduce the pre-fix expiry behavior.
5. CLI and TUI modules present workflow state.

`runtime.ts`, `definitions.ts`, and `cli.ts` are each now a re-export barrel
over a focused module tree (`runtime/`, `definitions/`, `cli/`) — see
[Module map](#module-map-after-split-workflow-god-modules) below. Every
importer listed above keeps importing the barrel path unchanged; the split is
a pure internal reorganization with no behavior change (digests, exports, and
the full test suite are unmodified oracles for that claim).

### Multiplexer boundary

Workspaces, tabs, panes, agents, notifications, and runtime events reach the
terminal multiplexer through one runtime-neutral port
(`src/multiplexer/port.ts`). Every operation is an Effect with a normalized
identity/intent payload and a classified `MultiplexerError`; callers never
construct vendor argument vectors or parse vendor envelopes. Two adapters
implement it: `src/multiplexer/herdr/` is the mechanical passthrough over the
existing Herdr CLI calls (moved from `src/herdr-client.ts` and
`src/workflow/herdr-schema.ts`, whose paths remain compatibility shims), and
`src/multiplexer/luvus/` speaks Luvus UHP/CLI with its own decoders.

Runtime selection is top-level `multiplexer: "herdr" | "luvus"` configuration
with `AGENTIC_CODING_MULTIPLEXER` taking precedence and `herdr` as the default;
`src/multiplexer/factory.ts` resolves it once and fails loudly when the
selected executable/socket is unavailable, never falling back to another
runtime. Detached `workflow drain` children inherit the selector and both
runtimes' connection variables through the bounded allowlist in
`src/workflow/cli/drain.ts`. Promise/sync consumers of the port run its effects
through the single `src/multiplexer/boundary.ts` execution point.

The Herdr-only sidebar/custom Agents view (`src/workflow/sidebar-sync.ts`) is
deferred and stays on the raw Herdr CLI type; the port deliberately exposes no
sidebar operation.

### Worktree boundary

Worktrees are created, resolved, listed and removed through one Effect-native
port (`src/worktree/port.ts`) implemented over worktrunk (`wt`) in
`src/worktree/index.ts`, so neither the environment layer nor a workflow runs
worktree `git`/`wt` arguments itself:

- the environment repository facade's worktree methods are its only
  `Promise`-returning ones and cross the port through
  `src/worktree/boundary.ts`;
- the action runner translates a declared `git worktree add|remove` command into
  a port call, while `worktree list`/`prune` stay plain git because their output
  is what the actions view shows;
- a workflow resolves its worktree through the port and then asks the
  multiplexer for a workspace at that path, so setup is runtime-independent.

The shared layout (`<root>/<ident>/<ident>.<sanitized branch>`,
`src/worktree/template.ts`) is the only place a worktree path is computed, and
every port call disables worktrunk hooks, directory changes and prompts. The
workflow layer always passes an explicit location (`src/worktree/layout.ts`):
its own root, `<DEVENV_HOME>/worktrees`, with the managed project's ident or a
short-hashed ident for a custom path. It never relies on worktrunk's ambient
`worktree-path` default, which has no `<root>/<ident>/` container to derive from
for a repository outside the environment home.

### Store lifecycle

`initializeStore()` is the only schema-writing boundary. It takes SQLite's
migration lock, rereads `PRAGMA user_version`, and applies ordered native
migrations atomically. Store versions 1–4 are supported: version 1 adds run
ownership columns, version 2 adopts nullable workflow identity, version 3
repairs rebuilt child foreign keys, and version 4 is the current validated
schema. Unsupported future versions fail closed. An unversioned store is
classified by shape: the canonical tables, columns, indexes, foreign keys and
statement structure must match a known version, while a table this build does
not know is stepped over when it is empty (another feature or build may share
the file without versioning it) and fails closed when it holds rows — unknown
data is never migrated over. Statement text is compared structurally, so a
legacy DDL written with different spacing is the same schema, not drift.
Mutating engine entry points initialize before their command transaction and
may then import legacy `workflows` rows. Status and list do not initialize or
import: absent and old stores are presented as migration-required diagnostics. The explicit drain
command accepts bounded `--limit` and `--wait-ms` values for retry progress
without disguising execution as observation. Back up persistent stores with
SQLite's consistent backup mechanism before upgrades, and stop old schema
writers while a migration is in progress. Migration commits are
independent, so a later command rejection does not undo a successful schema
transition. There are no automatic down migrations; rollback to an older
binary requires a verified pre-upgrade backup or explicit support in that
binary.

## Startup context and execution pins

CLI, dashboard, research, and wiki-comment starts use `src/workflow/startup.ts`.
The startup boundary resolves the selected repository before reading `.pi` project
configuration, so linked worktrees use the canonical repository source and
repository-independent workflows use global configuration. `HERDR_WORKFLOW_CONFIG`
is a full replacement and carries environment provenance. Status, list, snapshot,
view, and dashboard JSON reads are observational: they do not drain effects,
expire questions, initialize stores, or import legacy rows. Explicit execution
uses the bounded `workflow drain --repo PATH` command or a mutation-owned
continuation. Handoff evidence is prepared from bounded artifact/source
observations before the writer transaction, then reauthorized and checked again
inside the transaction; concurrent replacement or source drift is rejected,
not silently accepted. This leaves an intentional filesystem race window and
keeps the final integrity check load-bearing.

Classifier-driven model pools select the model of **every** agent step, in
**every** family. Each classifiable step (`core.plan`, `fusion.consolidate`,
`fusion.plan`, `core.implementation`, `core.triage`, `core.verification`,
`core.wiki`, `core.research`, `core.archive`) declares a classification mode in
its own step behavior — `CLASSIFIABLE_STEPS` is *derived* from those behaviors,
so the config keys and the routing pass can never disagree — and a preset
supplies one ordered pool per classifiable step. Routing is per step, not per
phase: `withPerStepRouting` gives every classifiable step a routing step
immediately before it (`core.route-implementation`, `core.route-verification`,
…), every inbound edge enters that routing step, and the routing step asks
exactly one pool question for the step that follows. The state is what that step
is about to run against: the task before planning, and the task plus the plan
artifacts and the changed-file paths afterwards (never diff bodies). A loop
therefore re-selects the model, so a verification round re-asks. A single
selection pins the entry the classifier named — or, when it named none, the
offered entry with the highest `probabilities` value — and replaces every route
of its step, so one `core.verification` pool covers all verifier roles; the
reported `confidence` is observable telemetry and never changes the pick, and
only an answer with no usable decision falls back to the pool's tagged
`default`. A fusion roster recomputes `planner-1..N`. Every new start
resolves the per-step routing tier (`rounds + 700`) and requires a preset whose
pools cover every classifiable step in its definition — the error names the
step; the `fusion.plan` pool's tagged defaults seed the pre-classification
planner fan-out. The resolved routing is pinned in the
workflow snapshot before effects run, so a preset switch is validated and
explicit.

## Classifier providers and the local model

The transport that serves those System One requests is pluggable. A provider
(`src/workflow/classifier-providers.ts` catalog + `src/workflow/classifier-runner.ts`
live registry) supplies the endpoint, the headers, and the model id; the
request builders own only the `state` and `questions`. Two providers are
built in:

- **`opencode-zen`** — the hosted, usage-based plan. This is the default, and
  `resolve` returns today's endpoint (`https://opencode.ai/zen/v1/systemone`),
  `OPENCODE_API_KEY` bearer header, and the model id with the `opencode/`
  prefix stripped. A configuration that says nothing keeps exactly this.
- **`laya-local`** — an offline sidecar. `src/workflow/laya-local.ts` locates
  the `laya-system-one` package — the `LAYA_PACKAGE_ROOT` override first (a
  directory that must actually be that package), then the executable's
  neighbourhood, the working directory, and module resolution — stages the
  model metadata, acquires the ~324 MB INT8
  model only on an explicit request, and spawns `laya-serve` itself — a
  standalone process, not the dependency's `serve()` proxy — on a fixed
  `127.0.0.1` port (`LAYA_PORT`, default 4571). Everything about the sidecar is
  deliberate: it is detached with no stdio, so it keeps running after the UI
  exits; the port is fixed, so the endpoint serialized into a pane's
  `AGENTIC_JEV` stays valid when that pane outlives the engine; and a start
  that finds the port already answering adopts that sidecar instead of loading a
  second ~1 GB model. Readiness is polled on `/health`, not parsed from the
  child's stdout, because stdio is detached and the port is chosen here. Nothing
  in the app stops it — not a provider switch, not server shutdown — so a later
  engine, and any pane still holding the endpoint, keeps the warm model. A compiled binary copied out of the tree its `node_modules`
  live in finds none of those, so `LAYA_PACKAGE_ROOT` is the supported way to
  point it back at the package, and the failure names it instead of reading as
  a corrupt or missing install. The model id is a local one; the sidecar ignores unknown
  models. It is bound to loopback only and runs without a bearer credential:
  the child environment has any ambient `LAYA_API_KEY`/`API_KEY` removed, so an
  unrelated variable can never turn the local listener into an authenticated
  service this process cannot reach. Liveness is probed (a killed sidecar
  reports `unavailable` and is respawned on the next classification).

`[agents.classifier]` selects the provider (`provider`, plus opaque
`options`); an unknown id is a hard config break. The selected id is resolved
once at start and pinned into `metadata.classifier`, exactly like
`metadata.gatePolicies`, so a mid-run config edit cannot switch the endpoint;
a snapshot without the pin (one started before local providers existed)
resolves from the configuration and falls back to `opencode-zen`. Provider
overrides are `LAYA_SERVE_BIN`, `LAYA_MODEL_PATH`, `LAYA_CACHE_DIR`, and
`LAYA_PORT`; `LAYA_BACKEND` is native-only, since the wasm engine lives
in-process and cannot be a standalone service. The install/cache directory defaults under
the app config root at `classifier/laya/`.

Installation is user-decided and never automatic. Flipping the Settings picker
to `laya-local` opens an install modal: *Install* starts a server-owned,
cancelable acquisition (atomic and checksum-verified by `resolveModel`) and
persists the provider only after health is `ready`; *Not now* / Escape leaves
the previous provider in effect. The server exposes
`GET /api/v1/classifier/status`, `POST /api/v1/classifier/install`, and
`POST /api/v1/classifier/install/cancel`; persisting the provider stays on the
existing `POST /api/v1/config/agents` path through a `set-classifier`
mutation, so the `expectedRevision` conflict check is reused. A missing model
or a dead sidecar is never fatal: the provider reports `unavailable`, triage
and gates fail open (force the run plus an `attention` entry), and routing fails
open too, completing each step on its pinned pool default plus an `attention`
entry instead of parking the run. Routing fails open only for a typed
`ClassifierUnavailable` (the local provider's own outage); a hosted transport or
status failure still fails and is retried by the durable outbox, so the OTEL
error telemetry and retry budget are unchanged. `GET /api/v1/classifier/status`
awaits a bounded liveness probe, so a killed sidecar is reported as not running
rather than as a healthy handle.

Classifier-driven verifier-role routing decides *which* verifiers run, per
round. `core.triage-route` is a system step between `core.implementation` and
`core.triage` in the shared implementation loop (definition tier
`rounds + 500`; earlier tiers keep their graph, digest, and step list). It
enqueues one `model.classify` with the `triage` integration, whose idempotency
key carries the snapshot revision — the step is re-entered every round with a
constant attempt, so a per-attempt key would be dropped by the outbox from round
2 and strand the run. It asks one `noul` necessity question per eligible role —
the registered verifier catalog minus the engine-owned full suite, minus the
OpenSpec verifier for `no-openspec` — and includes a role at `noul >= 0.5`. A
selection is trusted only when every question is answered: a truncated response
is an outage, not a verdict, so the round falls back to the full catalog rather
than silently narrowing. It resolves no model pool and never changes the pinned
routing. The state is the engine's own changed-file manifest plus capped
per-file diffs (per-file, total, and a cap on how many files are read at all);
reads are bounded at the source, manifest entries are passed to git with
`--literal-pathspecs`, and the corpus is framed as untrusted JSON data so a
filename or diff cannot forge structure or address the questions. A selection
arrives at `core.triage` as the edge output (and as its step input), which may
only narrow it — never empty it; zero roles bypass triage and run the full
suite only; and every classifier failure fails open into an unconstrained triage
plus an `attention` entry, because a classifier outage must never block
verification. The pass is recorded in the snapshot's bounded
`classifierDecisions` history — one record per question it asked, carrying the
model, the bounded head of the state, the necessity answer, and whether the role
was selected; a pass that obtained no usable answer at all is one record — so a
round's classification can be read instead of inferred from which verifiers ran.
The per-file judgment sweep is recorded the same way, as the one sweep it was:
its banded paths travel as the record's options, its coverage counts as the
record's attention line, and its rendered section as the record's input, while
the content-bound artifact reference stays the evidence a verifier reads.

Configurable stage gates decide whether four stages run at all. The policy is
configuration, not code: a preset's `gates` table
(`planApproval`, `verification`, `developerReview`, `wiki`, each `always` or
`auto`) wins over the global `agents.gates` table, which wins over `always`. It
is resolved once at start and pinned into `metadata.gatePolicies`, so a mid-run
config edit cannot change a running workflow; a snapshot with no pinned table
(some pre-gate workflow already on disk) resolves from the configuration, and an
unreadable or invalid one falls back to `always` for every stage. `always` is decided
locally — a forced run, no HTTP request — so a configuration that declares
nothing behaves exactly like a workflow with no gates at all. `auto` asks the
JEV classifier one `noul` necessity question for the stage and runs it at
`noul >= 0.5`, skipping strictly below; a `noul` answer carries no confidence,
so that one floor is the whole rule. Every failure mode — missing credential,
provider error, unparsable body, missing answer key, an answer with no usable
value — is a successful *forced run* plus an `attention` entry, never a skip and
never a failed effect, because a gate must never block its own stage.

Three gates are system steps with exactly two outcomes, `run` and `skip`, in
the `rounds + 600` tier (earlier tiers keep their graph, digest, and step
list): `core.plan-gate` between `core.plan` and `core.plan-approval` (present
only in definitions that own a plan approval), `core.review-gate` between a
passing `core.verification` and `core.developer-review`, and `core.wiki-gate`
in front of `core.wiki`. Each enqueues one `model.classify` with the `gate`
integration and a revision-keyed idempotency key, exactly like
`core.triage-route`. A skip targets the guarded stage's *own* approval or
completion target, so a skip is shape-identical to an approval: the plan gate
skips to the apply-phase routing pass (or `core.completed` in the propose-only
families), the review gate to the wiki gate or the archive/delivery tail, and
the wiki gate to `core.archive` — or `core.delivery` in the archive-free
`no-openspec` family. `core.archive` is never gated: archiving is mandatory for
OpenSpec to complete.

The fourth gate, `verification`, guards triage and verification as one
inseparable unit and therefore rides on the existing `core.triage-route` step:
under `auto` its `needs_verification` question joins the round's single
request, and a `skip` takes the step's third outcome, `skip-verification`,
which bypasses both stages. The only edge out of that outcome is
`core.review-gate`, so skipping both verification and developer review is
possible only when both gates are `auto` — the safeguard is structural, not a
second rule in code. A zero-role round is a *reduction*, not a skip: triage is
bypassed and the engine-owned full suite still runs, and the round is never
recorded as a skipped gate. The standalone `wiki` and `research` lifecycles are
registered unchanged: their wiki step is the whole workflow, so a gate in front
of it would have nothing to fall through to and the gate's evidence does not
exist in a documentation-only run.

Each gate is decided from bounded, stage-specific state: the plan gate reads
the change's planning artifacts, the review gate the capped changed-file diffs
plus the round's bounded verification results (handed over on the `pass`
transition and adopted by the gate's `onArrive`), and the wiki gate the plan
summary with a changed-file path list. The collectors keep their per-file,
total, and file-count caps, pass manifest entries to git with
`--literal-pathspecs`, list every path in full even when its diff text is
truncated away, and frame the material as untrusted repository data that cannot
direct the answer.

A failed decision records the same `attention` entry as a skip: a forced run
carrying a `reason` is the one forced run that stays audible, while a
locally-decided `always` run and an answered run carry no reason and stay
attention-free. Every decision is recorded in the snapshot's bounded
`gateDecisions` list —
stage, resolved policy, answer value, forced-or-answered, run-or-skip — with
its own record-count and aggregate-size bounds; an actual skip additionally
appends an `attention` entry naming the stage (so `workflow status` shows it
without a new status surface), raises a notification through the same
`port.notify` boundary the `notification.show` effect uses, and emits a
`gate.skip` telemetry event. The notification and the telemetry are
best-effort and outside the outbox; the reducer's record is the durable
guarantee that a skipped test suite or human review is never silent. A
workflow that has taken no gate decision exposes an empty list. The dashboard's
Change panel renders the latest decision per stage, so a stage whose most recent
verdict was a skip shows as `stage — skipped (policy, necessity)` beside the
phase status; a workflow that has skipped nothing renders nothing. The
dashboard's Classifications panel merges that list with the classifier-decision
history into one time-ordered view, so model-pool routing, verifier-role triage,
every stage-gate verdict, and the per-file sweep appear in the one place a
reader looks for what the classifier decided.

Every repository-controlled string a gate reads — the task, the change id, the
plan summary, artifact bodies, paths, and diffs — travels inside one JSON
envelope introduced by an "untrusted data" preamble, so no repository line can
start a line that reads as engine-authored in the classifier's instruction area.

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

### Semantic step compatibility

Definitions registered in the `rounds + 300` tier pin `stepRefs` containing the
step ID, registered step version, and behavior compatibility version. Runtime
lookups use the definition-aware registry resolver. Legacy ID-only definitions
remain supported through the explicit built-in baseline mapping at step version
1; extension steps without a declared legacy mapping fail closed. Step behavior
compatibility versions are manual semantic identities: changes to outcomes,
guards, completion aggregation, context transfer, role selection, or effect
declarations require a new compatibility identity or a validated migration.
Instruction asset digests are presentation pins and do not contribute to
semantic step or definition digests. Repin cannot replace semantic references;
changed references require migration. Historical definition digests and legacy
snapshots omit `stepRefs` and remain readable. Retain every registered semantic
step version and behavior identity for as long as a persisted definition can
reference it; do not garbage-collect a pin that an active or historical
snapshot needs. ID-only legacy mappings are supported for the lifetime of those
readable snapshots and may be removed only through an explicit migration policy
change. Migration is revision-bound, requires a target with the same graph shape
and semantic pins, preserves non-run lifecycle effects (including setup gating),
and expires/restarts run ownership. Rollback is not automatic: it is another
validated migration to a retained compatible target, and graph-changing or
unpinned targets are rejected.

## Step ownership

Step knowledge belongs only in `src/workflow/steps/`. The engine, CLI, and
dashboard read the registered step behavior (`StepDefinition.behavior`)
instead of keeping their own `core.*`/`fusion.*` id tables. Behavior is pure,
engine-internal (excluded from both `stepDigest()` and the definition digest —
editing behavior never produces a pin mismatch), and receives no database
handle; hooks that need to persist something declare it and the engine
performs the write.

`StepBehavior` hooks:

- `classification` — the classifier mode (`single` or `roster`) a classifiable
  step declares; absent when the step is never asked of the classifier. The
  route steps and the reducer read it from the registered step definition.
- `roles` / `candidateRoles` — which agent roles are active now / could ever be
  routed for this definition (stage A).
- `validateEvidence({ snapshot })` — entry-guard predicate run before a step's
  `complete` outcome is accepted; throws `WorkflowRuntimeError("entry-guard",
  ...)` to reject.
- `onAgentComplete({ snapshot, definitionId, run, outcome, output,
  outputDigest, remainingActiveRunIds, evidence })` and
  `onEffectComplete({ snapshot, effect })` — completion decisions over
  authenticated facts. They return only constrained local updates, one legal
  transition request, candidate-role run requests, and allowlisted effects.
  The runtime validates routes, roles, effects, and leases, then applies the
  result atomically; hooks never receive persistence or I/O handles.
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
  `roundScoped` (triage/verification agent-name grouping), `groupByRole`
  (resolve a round-scoped step's layout group to the run's role, so each
  verifier role owns its own full-height tab) and `paneGroup` (which tab a
  round-scoped step splits into when `groupByRole` is unset; triage is its own
  group).

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
(`repository` | `wiki` | `research`), `checkoutRequired`, and historical
`requiresReadOnlyResearcher`. `WorkflowRegistry.registerWorkflow` validates it
(unknown target kind, or a contradictory combination such as
`requiresReadOnlyResearcher` outside the `research` target) and names the
manifest in the rejection. Current research definitions set that flag false;
older pinned definitions retain their original read-only policy and digest.

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
  `rounds + 200` — wiki gate and `policy`.
- **Behavior-pin tier:** `definitionVersionForBehaviorPins(rounds)` =
  `rounds + 300` — wiki gate, `policy`, and exact semantic `stepRefs`.
- **Research-tool tier:** `definitionVersionForResearchTools(rounds)` =
  `rounds + 400` — the `research` family with the selected profile's normal
  tool access. `research` starts still resolve this tier.
- **Verifier-role tier:** `definitionVersionForTriageRouting(rounds)` =
  `rounds + 500` — adds `core.triage-route` to the shared implementation loop.
- **Stage-gate tier:** `definitionVersionForStageGates(rounds)` =
  `rounds + 600` — adds `core.plan-gate`, `core.review-gate`, and
  `core.wiki-gate`, gives `core.triage-route` its `skip-verification` outcome
  (as step version 2, with version 1 still registered for the tier above), and
  registers the standalone `wiki` family unchanged. This is the version
  `startWorkflowInProcess` / `cli.ts`'s `start` command actually use for new
  non-research workflows.

All tiers stay registered; nothing is removed. `start()` reads policy
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
| `runtime/reducers/agent-handoff.ts` | No bespoke step-ID completion branches remain; registered behavior owns verification, fusion, planning, and delivery decisions. | The runtime retains authentication, evidence integrity, run bookkeeping, and generic fallback/closure handling. |
| `runtime/reducers/effect-result.ts` | No bespoke completion-routing branches remain; registered behavior owns effect-gated transitions and delivery chaining. | Workspace setup/close and cleanup remain cross-cutting runtime mechanics. |
| `runtime.ts` `createRun()` (~line 2565) | `step.id === "core.research"` (narrows `allowedOutcomes` to exclude `complete`) | A capability-shaping rule (research never hands off `complete`), adjacent to but distinct from `StepBehavior`; not in this stage's inventory. |
| `runtime.ts` `validateEffect()` (~lines 2718–2740) | `snapshot.currentStep === "core.delivery"` / `"core.research"` / `"core.completed"` | Effect-legality exceptions (wiki-verify promoted at delivery/completion, research's workspace-setup-before-entry ordering) — a persistence/outbox invariant, not step business semantics. |
| `runtime.ts` `validateFusionRouting()` (~line 3256) | `route.stepId === "fusion.plan"` | Routing-shape validation for the fusion fan-out, called only for the two fusion definition ids — a routing concern, not step business semantics. |
| `effect-runner.ts` `assignmentFor` (`core.triage` changed-files line) | `run.stepId === "core.triage"` | Needs `changedFilesIn`, a `runtime.ts`-resident git-status walker; moving it means either splitting `runtime.ts` (stage C's job) or duplicating a non-trivial recursive helper. Recorded out of scope per design D5. |
| `adapters.ts` | No research-specific tool or permission branch remains; researcher profiles receive the same configured runtime tools as other roles. | Adapter launch policy follows the resolved profile. |
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
objective/permissions/checks branches, and `assignment.ts`'s wiki-role asset map
and research handoff note are the branches this stage *did* move — they now read
`StepBehavior.roundScoped`, `assignmentInputs`, `instructionAssetForRole`, and
`handoffNote`, respectively.

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
| `kernel.ts` | The shared step-transition primitives every reducer and `engine.ts` need: `enqueue`, `applyReduction`, `createRun`, `enterStep`, `transition`, plus the pure step-shape helpers (`freshStep`, `resolveArrivalContext`, fusion routing/draft helpers) and run-expiry helpers (`expireRuns`, `expireSiblingRuns`). Agents stay live across expired runs; workspace closure owns process shutdown. Kept separate from `engine.ts` because `migration.ts` and every `reducers/*.ts` module need these without needing the `WorkflowEngine` class itself — importing `engine.ts` from either would close the cycle `engine.ts -> reducer -> engine.ts`. |
| `migration.ts` | Legacy `workflows`-table discovery, phase-to-step mapping, legacy evidence conversion, migration diagnostics. **Thinnest test coverage in the package** (`test/workflow-migration.test.ts` is the only oracle) — moved verbatim with no signature change beyond taking `registry`/`now` as explicit parameters. |
| `view.ts` | The read model: `view`, `list`, `status`, `previewRepair`, and the run/effect projection into `WorkflowView`. Read path only. |
| `reducers/*.ts` | One file per `reduce()` command branch (or a small explicitly-grouped set: `agent-question.ts` holds both `agent.question` and `agent.question-expire`; `repair.ts` holds `operator.repair`, `operator.repin`, and `operator.resume`). Each reducer receives `registry`/`now` as explicit parameters and the already-open `db`/`snapshot` — it runs inside the kernel's existing transaction, never opening its own. |
| `engine.ts` | The `WorkflowEngine` class: `start`, `dispatch`, the `reduce()` command-type dispatch table, `claimEffects`, `telemetry`, `locate`, and thin public-API delegates to the modules above. The residue once every leaf/feature/reducer is moved out. |

### `src/workflow/definitions/`

| Module | Owns |
| --- | --- |
| `catalog.ts` | `PUBLIC_WORKFLOW_CATALOG` — the human-facing workflow family list. |
| `contracts.ts` | The step output contracts (`triage`, `findings`, `planDraft`, `passthrough`, `empty`) and the standalone `researchHandoffContract`. |
| `steps.ts` | The `step()` factory, per-step instruction asset list, `commonImplementationSteps(triageRoute)`, and the full `WORKFLOW_STEPS` catalog. |
| `edges.ts` | `workflowEdges()` (the shared implementation-loop edge builder, which threads the triage-routing edges) and `definitionVersionForPolicy`. |
| `manifest-policy.ts` | The version tiers (`definitionVersionForManifestPolicy`, `…ForBehaviorPins`, `…ForResearchTools`, `…ForTriageRouting`, `…ForStageGates`), the per-workflow-id policy table, and `effectiveManifestPolicy`. |
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

## Source-layer boundaries (enforced)

`test/workflow-source-layer-boundaries.test.ts` is a runnable architecture
check over all of `src/` (`.ts` and `.tsx`), backed by
`scripts/workflow-module-graph.ts` (AST import scan) and
`scripts/workflow-architecture.ts` (layer policy). It enforces the documented
dependency direction below; the docs and the tests are the only surface — no
runtime code depends on it.

### Layer matrix

| Layer | Paths | Owns |
| --- | --- | --- |
| **domain** (pure) | `workflow/steps/`, `workflow/definitions/`, `workflow/contracts.ts`, `workflow/schema.ts`, `workflow/format.ts`, `workflow/registry.ts`, `workflow/embedded.generated.ts`, `workflow/definitions.ts` | Pure step behavior, definitions, contracts, Effect Schema-backed contract decoding (`schema.ts` — declarative; the `Contract<T>` facades delegate here), structural registry validation, and the generated instruction-asset data module. |
| **runtime** | `workflow/runtime/`, `workflow/runtime.ts`, `workflow/effects.ts`, `workflow/effect-runner.ts`, `workflow/secure-fs.ts`, `workflow/paths.ts`, `workflow/assets.ts`, `workflow/assignment.ts`, `workflow/observability.ts`, `workflow/wiki.ts`, `workflow/adapters.ts`, `workflow/credentials.ts`, `workflow/profiles.ts`, `workflow/agent-extensions.ts`, `workflow/project-catalog.ts` | Persistence, engine internals, effect execution, and external I/O services (git inspection, wiki data, adapters, credentials, agent-extension config, configured-project catalog reads). |
| **application** | `workflow/startup.ts`, `workflow/operations.ts`, `workflow/application.ts` | Shared orchestration both the CLI and the dashboard compose: startup/validation routing, the in-process engine factory, effect draining, configured-project listing (`operations.ts`, backed by the runtime catalog client), and the named application composition root (`application.ts` — the single place the production `applicationLayer` is composed and Effect programs run, complete-workflow-effect-cutover task 1). |
| **cli** | `workflow/cli/`, `workflow/cli.ts` | Command parsing, dispatch (`run.ts`), command modules, and git/registry/pane helpers. |
| **tui-feature** | `tui/dash/`, `tui/otel/`, `tui/settings/` | Dashboard, observability and settings feature implementations (the Settings surface is a Home destination: section views, inventory and its own section keys). |
| **tui-shared** | `tui/shared/`, `tui/themes/`, `tui/clipboard.ts`, `tui/lifecycle.ts` | Shared presentation primitives and theme data. |
| **tui-app** | remaining `tui/` files | TUI shell entrypoint (`index.tsx`) and lifecycle components. |
| **root** | `cli.ts`, `herdr-client.ts` (shim over `multiplexer/herdr/cli.ts`), `multiplexer/`, `worktree/`, `server-command.ts`, `server/` | Composition roots and foundational clients. `server/` is the unified Bun backend transport/client/build root (`expose-unified-bun-backend`): `protocol.ts` (contracts + route manifest), `auth.ts`, `app.ts`, `client.ts`, `events.ts`, `credentials.ts`, `handlers.ts`, `lifecycle.ts`. See [`docs/unified-backend-api.md`](unified-backend-api.md). |

Allowed directions (anything else fails, **including type-only imports**):

- `domain` → `domain`
- `runtime` → `domain`, `runtime`, `root`
- `application` → `domain`, `runtime`, `application`, `cli`, `root` — application
  orchestration is the **only** layer allowed to compose CLI internals (git,
  registry, pane); backend (`domain`/`runtime`) and TUI never see the CLI.
- `cli` → `domain`, `runtime`, `application`, `cli`, `root`
- `tui-feature` → `domain`, `runtime`, `application`, `root`, `tui-shared`, `tui-feature`
  (the observability app composes the dashboard feature; features never import
  CLI command modules or barrels)
- `tui-shared` → `tui-shared`, `root`
- `tui-app` → everything TUI plus typed engine views and application operations
- `root` → anything

The explicitly forbidden directions the tests pin with negative fixtures:
dashboard/OTEL importing CLI orchestration (identifies `operations.ts` as the
application boundary to use instead), backend importing presentation types,
shared primitives importing feature implementations, and pure `domain`
modules reaching anything outside `domain`.

### Pure-domain guardrails

`domain` modules may not depend — directly or transitively, type-only edges
included — on persistence, external effects, filesystem/process/network I/O,
presentation, or ambient clocks. The check reports the full dependency path to
the first forbidden boundary. In guarded pure modules the check also rejects:

- directly imported I/O builtins (`node:fs`, `node:fs/promises`,
  `node:child_process`, `node:net`, `node:dgram`, `node:http`, `node:https`,
  `node:tls`, `node:readline`, `node:tty`, `node:worker_threads`,
  `node:sqlite`, `bun:ffi`, `bun:sqlite`); pure-safe builtins such as
  `node:path` and `node:crypto` stay allowed;
- recognized ambient I/O/clock globals with source locations: `fetch`,
  `Bun.spawn`, `Bun.spawnSync`, `Bun.write`, `Bun.read`, `Bun.file`,
  `process.cwd`, `process.chdir`, `process.exit`, `process.stdout`,
  `process.stderr`, `process.stdin`, `Date.now`, `new Date()`;
- computed module loading (`import(<expression>)` / `require(<expression>)`),
  which escapes static resolution.

A step hook using *supplied* typed validated evidence and an explicitly
supplied timestamp passes. These are bounded static guardrails — they are not
a sandbox and not a whole-program purity proof: aliased globals or arbitrary
JavaScript runtime behavior can escape them.

### Import forms covered

The graph helper parses `.ts` and `.tsx` with `@babel/parser` (its
`typescript` plugin, with `jsx` enabled only for `.tsx`) and resolves
extensionless specifiers, explicit extensions
`.ts`/`.tsx`/`.json`, and `index.ts`/`index.tsx`/`index.json` directory
targets. It collects static imports/re-exports, literal `import()` calls, and
literal `require()` calls (property calls named `require` are ignored). Two
views are maintained:

- **runtime edges** (value imports/re-exports plus literal dynamic/require
  targets) back the cycle and parent-barrel checks;
- **all edges** (type-only references included) back the layer-ownership and
  purity checks, so forbidden architectural type coupling fails without ever
  synthesizing a false runtime cycle.

External/builtin targets are distinguished from project-relative ones rather
than dropped, and unresolved project-relative runtime targets fail with an
actionable source/specifier diagnostic.

### Exception policy

`checkLayerOwnership`/`checkPureDomain` take an exact-edge allowlist keyed by
`rel-from -> rel-to` with a reviewed rationale and a removal condition. There
is **no wildcard or historical exemption**: unused entries fail
(`exception:unused`), and a module with one approved entry that adds a
different forbidden edge fails that new edge independently. The production
allowlist is currently empty — the ownership fixes below were resolved through
intended ownership rather than exemptions:

- The dashboard's `tui/dash/engine.ts` imported `engine()`, `drainEffects()`,
  `listProjects`, and `CONTINUATION_WAIT_MS` from `workflow/cli.ts`. Those
  moved to a new application-operations module `src/workflow/operations.ts`;
  CLI commands (`cli/run.ts`, `cli/commands/*`) and the dashboard both consume
  it now.
- Step behavior validated evidence by reading files itself
  (`steps/validation.ts` → `secure-fs.ts`). The bounded evidence reader moved
  to `runtime/step-evidence.ts`; `steps/validation.ts` now holds only the
  `PreparedStepEvidence` type and pure validation predicates, and behavior
  hooks consume the evidence the runtime prepares and passes in.

Run the checks with:

```bash
cd agentic-coding && bun test test/workflow-source-layer-boundaries.test.ts test/workflow-module-import-cycles.test.ts test/workflow-module-exports.test.ts
```

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

## Adding a stage gate

`core.plan-gate`, `core.review-gate`, and `core.wiki-gate` share one behavior
factory in `src/workflow/steps/gates.ts`; each entry names only the stage it
guards, and the step catalog entry declares the two `run`/`skip` outcomes,
`allowedEffects: ["model.classify"]`, and `retryLimit: 3`. The stage
vocabulary, the fixed question texts, and the necessity rule live once in
`src/workflow/classifiers.ts` (`GATE_STAGES`, `GATE_POLICIES`,
`GATE_QUESTIONS`, `selectGateDecision`); `src/workflow/profiles.ts` re-exports
the vocabulary so the Settings editor never reaches into the runtime protocol.
The verification gate has no step of its own: it is the `needs_verification`
question inside the triage request and the `skip-verification` outcome of
`core.triage-route`, which is step version 2. `assertStepBehaviorCoverage`
fails closed for a gate step without a behavior, and every gate step must
appear in `LEGACY_STEP_BASELINE` for tiers without exact step references.

## Adding a verifier role

The `core.verification` role catalog is a single closed list, `VERIFIER_ROLES`
in `src/workflow/steps/verification.ts`, exported as the source of truth for
engine selection validation, triage validation, and the dashboard preset
editor. Each registered role resolves exactly one pinned instruction asset by
stripping its `-verifier` suffix: `<role>` → `verification-<role>.md`. Adding a
role is additive — existing ids, asset names, and relative order stay fixed so
in-flight workflows keep the behavior and assets they started with.

`core.verification` is the one step declaring the `read-only` requirement, and
routing enforces it: `enforceReadOnlySteps` (`src/workflow/profiles.ts`) runs in
both routing paths (`startup.ts`'s `resolveRoutingForStart` and the
`switch-preset` reducer) and rewrites every `core.verification` route into a
read-only profile — no `edit`/`write` tools, no `shell`/`edit` capability —
before the routing is pinned or preflighted. A verifier therefore launches
under pi's read-only policy (`--no-extensions`, no `edit`/`write` in the
tool list; or opencode's `edit: deny` permission block), and its assignment
renders `read repository`. `bash` stays on purpose: focused checks and the
`agentic-coding workflow handoff` CLI run through it — a read-only verifier is
prevented from using pi's *edit/write tools*, not from mutating state through
the shell.

`--tools` is a strict allowlist over built-in *and* extension tools, so the pi
adapter (`src/workflow/adapters.ts`) is the single place that builds it: the
profile's declared list plus every tool the launch itself loads
(`developer_question`, `agent_ask`, the in-session `ask_jev`) plus the tools the
user enabled globally in their pi settings, with each global tool's built-in
extension requested explicitly (`-e builtin:codemode`) because
`--no-extensions` would otherwise drop it. A profile that declares no tools keeps
pi's own default selection, so an undeclared profile is never reduced to the
extension tools alone. The allowlist governs the *surface*, but it is not the
whole containment story: a `codemode` script may call every active `direct` tool
plus every registered `codemode`/`deferred`-exposure tool. The read-only
guarantee therefore rests on `edit`/`write` being `direct` and inactive — they
are never named in the allowlist — and on a global tool being inherited only
when a built-in extension provides it (`BUILTIN_EXTENSION_BY_TOOL` in
`src/workflow/pi-tools.ts`).

1. Author `agent-definitions/instructions/verification-<role without
   "-verifier">.md`, following the brevity and "concrete evidence only"
   wording of its siblings; state the role's scope boundary (for example that
   a review role never runs the complete suite).
2. Append the role id to `VERIFIER_ROLES` in
   `src/workflow/steps/verification.ts` before the derived `TRIAGE_ROLES`
   filter; `test-verifier` is the only derived exclusion.
3. Add the role's necessity question to `TRIAGE_ROLE_QUESTIONS` in
   `src/workflow/classifiers.ts` (id `needs_<role without "-verifier">` plus
   the role's remit as a necessity question), so `core.triage-route` asks it.
   `triage.md` needs no role row: the classifier decides the round's roles and
   the agent only scopes them.
4. Append `verification-<role>.md` to the `core.verification` asset list in
   `src/workflow/definitions/steps.ts` in the same order.
5. Regenerate the embedded definitions with `bun run build` (or
   `bun run scripts/generate-embedded.ts`) and confirm
   `AGENT_DEFINITION_VERSION` changed; never hand-edit
   `src/workflow/embedded.generated.ts`.
6. Consume the role only through the catalog: the Settings Agent Presets form
   imports `VERIFIER_ROLES`, so no second role list is edited. Keep
   `test-verifier` the sole engine-auto-launched verifier and the only owner
   of the complete repository test suite.
7. Update registered-catalog/instruction-digest tests and the definition
   digest table, add a registration test that every catalog role resolves a
   pinned asset, then run the focused workflow tests (`bun test
   test/workflow-steps.test.ts test/workflow-registry.test.ts
   test/workflow-model-config.test.ts test/app/agentPresetsView.test.tsx`),
   `bun run lint`, `bun run type-check`, and `bun run build` with zero
   diagnostics.

## Planned follow-ups

Stage A (`restructure-repo-for-agent-use`), stage B
(`move-step-semantics-to-behavior-hooks`), and stage D
(`derive-dashboard-actions-from-engine`) are complete. Completion
centralization is also complete: authenticated agent and effect completion
facts are passed to registered behavior hooks, whose constrained results are
validated and applied by the runtime transaction.

Stage C (`split-workflow-god-modules`) is also complete: `runtime.ts`,
`definitions.ts`, and `cli.ts` are now re-export barrels over the module trees
described in [Module map](#module-map-after-split-workflow-god-modules) above.
The file-and-line references in the step-identity table above predate that
split; the qualitative disposition of each match is unchanged, but the
functions now live in `runtime/kernel.ts` (`transition`, `enterStep`,
`validateFusionRouting`), `runtime/reducers/agent-handoff.ts`
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
