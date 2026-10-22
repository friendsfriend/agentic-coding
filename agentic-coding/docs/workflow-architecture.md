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

### Agent runtime and workspace surface

There is no multiplexer boundary: the terminal multiplexer integration
(Herdr/Luvus ports, adapters, pane lifecycle, tab/sidebar/notification
synchronization) was removed. `pi-durable` is the one managed agent runtime
(`src/workflow/adapters.ts`), hosted by the bundled durable agent host
(`src/agent-host/`); pane-hosted runtimes (`pi`, `opencode`) are gone with the
multiplexer. `src/workflow/effect-runner.ts` therefore allocates no pane and
performs no workspace bookkeeping: `workspace.setup` resolves the worktree (and
switches the branch for a checkout-mode run) and nothing else, `workspace.close`
is a no-op because the workflow's own durable status is its only lifecycle, and
`workspace.cleanup` still removes the worktree. `notification.show` is an
explicit no-op — the shell surfaces workflow state in its own UI.

A detached-worktree family (`debug`) addresses its worktree by path, so a
second workflow on the same branch meets whatever the first left there. Two
leftovers are handled by the worktree port rather than failing the setup: git's
registration of a worktree whose directory is gone (pruned first, or `git
worktree add` refuses it as "missing but already registered worktree"), and a
directory holding nothing but this engine's own `.herdr-workflow` data — the
worktree a closed workflow removed and a late telemetry write recreated. A
`TelemetrySink` therefore writes only while the workspace it belongs to still
exists (`telemetryWorkspaceRemoved`, `src/workflow/observability.ts`), which the
agent host's runtime bridge applies to its own `HERDR_TELEMETRY_PATH` too.
Anything else at the target path is content: the setup fails naming the path and
what it holds, and never deletes it.

The OpenTUI shell is the workspace surface: its workspace sidebar
(`src/tui/otel/app/sidebar-model.ts`, `src/tui/otel/components/WorkspaceSidebar.tsx`)
lists the durable workflows from the workflow store (SQLite-backed, so rows
survive a restart), reading the configured project catalog plus the workflow
target registry — the durable list of directories workflows were started in
(`src/workflow/runtime/target-registry.ts`, one marker per target under the
shared workflow data root, recorded by `WorkflowEngine.start`). The registry is
what keeps a workflow started in a directory of the operator's own choosing
visible: that store belongs to no configured project, and the sidebar never
scans the filesystem for stores. The shell resumes pending effects for the same
set. A row carries two identities: `state.repository` is the
repository the workflow was started from — empty for repository-independent
wiki/research work — while `target` is the store that owns its rows
(`<repository>` | `wiki://centralized` | `research://standalone`). Every
store-scoped operation addresses a workflow by its target, so the sidebar
resolves a row through `target` and never through `state.repository`.
`Enter` opens that workflow's dashboard in the page body,
`n` opens the worktree in a new tmux window, `d` opens a confirmation that
deletes the workflow (its store rows and worktree directory; the branch is
kept, so the committed work stays reviewable), and `Ctrl+S` toggles focus between
the sidebar and the page body on every surface (it is a host key, so feature
views that claim `h`/`l` cannot swallow it). `Ctrl+H`/`Ctrl+L` open the
previous/next workspace — the pinned Orchestrator and the filter's rows in
order, wrapping at both ends — and are host keys for the same reason. A
terminal without the kitty keyboard protocol reports `Ctrl+H` as the Backspace
byte, so a Backspace counts as `Ctrl+H` only while the sidebar holds focus:
that is the one surface where the two cannot be told apart from text editing.
The sidebar collapses to a three-line stack while unfocused: the workspace index
in bold, its status glyph, and one phase-specific character (remaining running
verifiers while verifying, remaining tasks or a review marker for other stages).
The glyph is the expanded row's status glyph in its tone colour, bold while the
state waits on a reader; `ui.sidebar_mode: "permanent"` keeps it expanded, and
the `e` toggle (or the title/strip glyph) writes that value back
to the user configuration so it survives restarts. Side apps that used to run in a pane (the editor opened
from a finding) go through `src/tui/shared/side-app.ts`: a new tmux window when
the shell runs inside a tmux client, a local spawn with the renderer suspended
otherwise.

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
- a workflow resolves its worktree through the port; there is no workspace to
  open at that path any more, so setup is runtime-independent.

The shared layout (`<root>/<ident>/<ident>.<sanitized branch>`,
`src/worktree/template.ts`) is the only place a worktree path is computed, and
every port call disables worktrunk hooks, directory changes and prompts. The
workflow layer always passes an explicit location (`src/worktree/layout.ts`):
its own root, `<DEVENV_HOME>/worktrees`, with the managed project's ident or a
short-hashed ident for a custom path. It never relies on worktrunk's ambient
`worktree-path` default, which has no `<root>/<ident>/` container to derive from
for a repository outside the environment home.

### Delivery push preflight (efficiency backlog item 16)

A `delivery.push` that cannot authenticate used to be attempted, retried
unchanged through the durable outbox and attempted again. Measured: six
`git_operations_failed` events in three workflows, all
`Permission denied (publickey)` on `git push`, with retries 11 s and 12 s apart
and one pair 4.5 min apart — every attempt spending the same seconds to
reproduce the same failure, and each one adding a monitor line whose workflow id
was repeated twelve times.

`src/workflow/push-preflight.ts` asks the credential question **once**, cheaply
and non-interactively, from inside the `delivery.push` handler's `execute` — no
new effect kind and no store change:

- `git remote get-url --push --all -- <remote>` resolves the URL a push would
  actually use (a configured *name* is resolved here too, so URL rewrites apply);
  a configured URL resolves to itself. An empty remote, or a name this
  repository does not have, is `skipped-no-remote` and runs no subprocess.
- `git ls-remote --heads -- <remote>` runs under `GIT_TERMINAL_PROMPT=0`,
  `GIT_SSH_COMMAND=<the command git would use> -o BatchMode=yes` and
  `GIT_ALLOW_PROTOCOL=https:ssh:git`, with the process environment minus every
  askpass relay (`GIT_ASKPASS`, `SSH_ASKPASS`, `SSH_ASKPASS_REQUIRE`,
  `AGENTIC_CODING_ASKPASS*`). The ssh command is *extended*, never replaced: a
  configured `GIT_SSH_COMMAND`/`core.sshCommand`/`GIT_SSH` keeps its key and its
  wrapper, so the check cannot fail for a push that would have worked.
  `PUSH_PREFLIGHT_TIMEOUT_MS` bounds it at 10 s and the `git config` read at 5 s.
- **Only a positive authentication failure blocks**: `Permission denied
  (publickey|password|keyboard-interactive)`, `authentication failed`, `invalid
  username or password`, `access denied`. A timeout, an unknown host, a refused
  connection, a repository that is not there, a 404, or git's own "terminal
  prompts disabled" is `inconclusive` and the push runs exactly as before — a
  preflight must never block a push that would have succeeded, so the check's own
  failure is a verdict, never an error.
- A remote that is a local path or `file://` URL needs no credential and is
  `skipped-local`, again without a subprocess.
- `skipped-interactive`: when the push itself can ask the developer for a
  credential — the dashboard and the execution coordinator always attach a
  credential prompt — the check is skipped, because `BatchMode=yes` cannot
  reproduce an answer that prompt would give and would report a failure for a
  push that would have worked. That path still blocks **once**: the handler
  attempts the push, and a push that fails with one of the same authentication
  lines raises the same note (`source: push`) instead of being retried unchanged.

A block is one `PermanentFailure` carrying `pushAuthFailureNote`: which remote
and which URL, the matched line (bounded to 300 characters), and what to do
(unlock the key the remote accepts — `ssh-add -l` lists what is loaded — fix the
stored credential, or retry the delivery push to answer a prompt). The reported
remote is masked and redacted (`//user:pass@host` becomes `//user:***@host`,
known credential shapes are removed), so no key material, token or passphrase is
printed, persisted or emitted. The effect ends `failed` with `attempts = 1`, the
workflow enters `attention-required` with that single line, and nothing retries
it. After the fix, the `retry-effect:<id>` developer action gives the effect a
fresh attempt budget and the same push runs normally.

Every attempt emits one `delivery.push_preflight` adapter envelope (`outcome:
error` only for `auth-failed`; `herdr.delivery.push.preflight` is the verdict,
`herdr.delivery.push.source` is `preflight` or `push`,
`herdr.delivery.push.remote` is the masked remote and
`herdr.delivery.push.detail` a bounded one-line reason). Emitting is wrapped so
telemetry can never change the delivery outcome.

To verify a delivery in a store, read the `events` query
(`event = 'delivery.push_preflight'`, `event_class = 'delivery'`) and the failed
effect's attempt count — baseline 3 attempts in 23 s becomes one failed effect
with `attempts = 1` and one attention line. `delivery-timeline`'s `git_failures`
column counts only the legacy `git_operations_*` vocabulary and stays at its
baseline here; the modern shape of that failure is an `attention-required`
workflow with a failed `delivery.push` effect, which this change now produces
once instead of repeatedly.

### Store lifecycle

`initializeStore()` is the only schema-writing boundary, and it writes
exactly one schema: version 6, which stores custom workflow definitions
beside the workflows that pin them (`custom-workflow-definitions`) and
carries the delegated `debug_requests` table
(`add-debug-subagent-requests`). A genuinely empty database is created
directly with that DDL and its `PRAGMA user_version`, inside one
`BEGIN IMMEDIATE` transaction, so two runtimes racing a first creation
serialize on the SQLite write lock and the loser adopts the committed schema.
A store with any other persisted version is refused before any DDL,
transaction or row write, with
`unsupported workflow store version N; this build only reads version 6`;
the store is left byte-identical, so converting it needs the older build.
An existing version 6 store is opened without changing its schema, rows or
pragma: the canonical tables, columns, indexes, foreign keys and statement
structure are validated, and a table this build does not know is stepped over
when it is empty (another feature or build may share the file without
versioning it) and fails closed when it holds rows. Statement text is compared
structurally, so a DDL written with different spacing is the same schema, not
drift. Mutating engine entry points initialize before their command
transaction. Status and list never initialize or write: an absent store stays
observationally absent and an unreadable one is reported as a diagnostic view.
The explicit drain command accepts bounded `--limit` and `--wait-ms` values
for retry progress without disguising execution as observation.

### Evidence store

Durable debugging evidence (screenshots, videos, traces, repro scripts, logs)
lives beside the workflow it came from, not in the agent's scratch space:
`<workflow data root>/evidence/<workflowId>/[req-<requestId>/]<id>.<ext>` plus
one `manifest.json` per workflow, written atomically. The data root is the
checkout's own `.herdr-workflow` for a repository-backed workflow and the shared
workflow data root for a wiki/research one; `workflow/runtime/evidence-store.ts`
is the one place that derivation and the deletion live, so the store, the
routes, the observation and the engine cannot disagree about where evidence is.

- **Layout and rules** are owned by `server/evidence/store.ts`: ULID ids (so
  lexical order is creation order), kind/content checks (PNG/JPEG/WebP,
  WebM/MP4, ZIP, text), a per-file cap (video 100 MB, other 20 MB) and a
  per-workflow cap (1 GB) that both **refuse with `evidence-quota`** — nothing
  already stored is ever evicted to make room.
- **Attach is copy-in and path-safe.** The source must resolve, by `realpath`,
  inside the workflow's checkout or data directory; the destination is derived
  from a fresh ULID, never from the caller's path.
- **Surfaces.** `POST/GET /api/v1/agent-env/evidence[/attach]` ride the owner
  capability a run already holds (the workflow comes from the verified owner),
  `GET /api/v1/evidence/{workflowId}/{id}` serves the recorded bytes to the
  local dashboard under the instance capability, and the `evidence` observation
  returns the manifest. The `evidence_attach`/`evidence_list` tools are offered
  to every durable run beside the `env_*` tools.
- **Lifecycle.** `workspace.cleanup` deletes the workflow's evidence with its
  workspace (and reports remaining evidence in its observation, so a
  repository-mode workflow still loses it), and workflow deletion removes it in
  the same step.
- **The report is an entry, not a kind.** `evidence_attach` takes a `report`
  flag: the store accepts it only on kind `other` with a `.md`/`.markdown` text
  file, so a report is an ordinary manifest entry (`report: true` — no new kind,
  no renamed path, no manifest version bump, and a manifest written before the
  flag reads exactly as before). A revised report is a second flagged entry and
  the newest one is the effective report, so replacing it never mutates the
  manifest. The dashboard's Evidence panel is a one-line kind summary; `Enter`
  opens the evidence subview, whose report pane renders that markdown with the
  wiki's own renderer and resolves `[^<evidence-id>]` citations against the
  manifest, with cited screenshots inline on kitty terminals.
  `src/tui/dash/evidence-panel.ts` and `evidence-report.ts` hold both view
  models (`evidence-summary-subview`).

## Custom workflow definitions

A workflow pins `definition: { id, version, digest }`. Built-in definitions
resolve from the process-lifetime registry; a **custom** definition resolves
from the target store's `workflow_definitions` table (store v5) through
`runtime/definitions.ts`. That resolver is the one definition lookup every
caller uses — `engine.ts`, `view.ts`, `store.ts`,
`effect-runner.ts`, and `startup.ts`: it answers from the built-in registry
first, and for the reserved `custom.` namespace it reads the stored row from the
target store, recompiles its manifest against the current step catalog
(including the newest-tier invariants), caches the compilation per process
(keyed by content-addressed identity and re-validated against the requesting
registry's step catalog), and verifies the pinned digest. The stored row is the
source of truth on every resolution: it is read before any cache is consulted,
so a target that never stored the identity fails closed instead of inheriting
another target's definition. A stored definition the catalog no longer
satisfies — a removed step version, a tampered row, an undecodable manifest —
throws a pin mismatch naming the offending step, exactly like a removed built-in
version, so the workflow blocks before any further mutation or effect execution
and its outbox rows cannot stall other workflows in the store.

`definitions/custom.ts` owns the namespace and the invariants a custom manifest
must keep: the `custom.` prefix, version 1, exact `stepRefs`, a non-empty
`label` (the view projection and the wire schema require one), a manifest policy
with family traits for a repository code-change target, a routing step
immediately before every classifiable step, and the stage gate in front of
every gated stage the graph contains. A custom identity is content-addressed:
`id = "custom." + digest[0..12]` over the manifest with the derived identity
fields forced to their canonical values, so an identical manifest stored twice
yields one row, and an identity collision (the id held by a different digest, or
the digest under a different id) fails closed. Two identities travel with a
stored definition, and `workflow define` prints both: `digest` is the content
address the identifier is derived from, and `definitionDigest` is the compiled
manifest digest the engine pins in the snapshot — the same value a built-in pin
carries, and the one `status` echoes back. An operator defines one with
`workflow define --repo PATH --file manifest.json` — which refuses a managed
agent caller (a definition is a durable trust root, so only the interactive
operator channel may write one; a non-interactive invocation must acknowledge
it with `--operator`, because the channel test is an ancestry heuristic and the
durable write must not rest on that heuristic alone) and compiles the manifest
*before* it migrates or writes the store, so a rejected manifest leaves the
repository untouched — and starts it with `workflow start --workflow-id ID
--repo PATH --type custom.ID`; `--type` is an alias for `--workflow`. A custom
definition is always
classifier-routed (it carries a routing step before every classifiable step), so
its start needs a preset whose pools cover those steps.

## Workflow blueprints

A **blueprint** is a small logical description of a workflow a model can author
reliably: a label, a rationale, repository family traits, whether the repository
checkout is required, the logical steps, the logical edges with optional loop
bounds, and a verification round count. It is the input to a pure compiler in
`src/workflow/blueprints/` that turns it into a manifest indistinguishable in
shape from a newest-tier built-in.

`blueprints/catalog.ts` is the logical allowlist (`BLUEPRINT_STEP_CATALOG`):
each entry is a registered step with its label, actor, outcomes and a one-line
description. Routing steps (`core.route-*`), `core.triage-route` and the stage
gates (`core.plan-gate`, `core.review-gate`, `core.wiki-gate`) are **internal**:
the compiler inserts them, and a blueprint that names one is rejected with an
`internal-step` diagnostic.

`blueprints/review.ts` is the human-review invariant over the logical graph,
checked **by removal**: it deletes the review node(s) and asks whether a
forbidden node is still reachable, so loops need no path enumeration.

- the **entry step** may reach `core.delivery`, `core.archive` and `core.wiki`
  only through `core.developer-review` or `core.findings-review`. The rule runs
  for **every** graph (not only one that declares `core.implementation`), and
  anchoring it on the entry rejects an author-controlled entry that starts the
  run after the review chain as well as an implementation-free graph that hands
  straight off to a delivery step. The start node itself is never a forbidden
  target, so the documentation-only shape whose entry is `core.wiki` stays legal
  (rule 3 guards its approval);
- a workflow that **pushes code** may reach `core.completed` only through a
  review too. It pushes code when it contains delivery or archive, or when its
  delivery trait is `pull-request` and its `core.completed` can `create-pr`
  (the trait is what `steps/lifecycle.ts` reads before offering the action). A
  workflow that pushes nothing is the solo shape, whose only exit is
  completion. (This is the deliberate resolution of the conflict between the
  invariant and the solo-equivalence requirement; recorded with the change's
  developer decision.)
- planning may reach `core.implementation`, `core.delivery`, `core.archive` or
  `core.completed` only through `core.plan-approval`;
- `core.wiki` may reach `core.archive`, `core.delivery` or `core.completed` only
  through `core.wiki-approval`.

`blueprints/compiler.ts` (`compileBlueprint`) is pure and deterministic. It
rejects an internal or unknown step, a duplicate step, an unknown edge endpoint,
an illegal outcome, a duplicate edge, and out-of-range bounds (the widest
built-in logical graph, the built-in loop maximum, and the registry's
verification-round range). The derived entry is constrained to a step a run may
begin with (`core.plan`/`fusion.plan`/`fusion.consolidate`,
`core.plan-approval`, `core.implementation`, `core.triage`, `core.verification`,
`core.rebase`, `core.wiki`); a delivery, terminal or review-decision step as the
entry is rejected with an `initial-step` diagnostic. The change identity must
agree with the graph's planner (`planned` exactly when `core.plan`,
`fusion.plan` or `fusion.consolidate` is present), or the blueprint is rejected
with a `change-identity` diagnostic. A graph that contains `core.verification`
must carry a `core.verification` `fix` edge whose loop bound equals the declared
`verificationRounds` (the compiled definition's effective round cap), or the
blueprint is rejected. The compiler then:

1. inserts the triage-routing step between `core.implementation` and
   `core.triage` (with the `empty` bypass to verification and a
   `skip-verification` edge to the developer review gate, the findings review's
   approval tail, or the verification pass target), exactly as the built-in tier
   wires all three outcomes;
2. inserts the plan, review and wiki gates, each in front of its stage, with its
   `skip` mirroring the stage's own approval target. When the gated stage (or
   `core.triage`) was the entry, the inserted gate (or routing step) becomes it,
   so a gated or triage-entry graph is never left unreachable;
3. applies `withPerStepRouting` (`definitions/edges.ts`) so every classifiable
   step gains its routing step and every inbound edge enters it;
4. pins exact step references (`exactStepReferences`; `core.triage-route` at
   version 2), mirrors the built-in `wiki.verify` edge effect as a fresh
   per-compile literal (so no two manifests share digest-covered content),
   derives the policy (`targetKind: repository`, the blueprint's
   `checkoutRequired`, and the blueprint's traits — with `clean-tree` added to
   the start requirements whenever the graph delivers or archives, so a
   delivering blueprint can never start on top of uncommitted work), and
   restricts a non-terminal step's outcomes to the ones the graph provides (so
   solo's `create-pr`-less completion is legal);
5. dry-compiles through `WorkflowRegistry.compileWorkflow` under the derived
   `custom.` identity — the custom-definition invariants included — without
   registering anything. The result carries both digests: `digest` is the
   compiled pin, `identityDigest` the content address the stored row is keyed
   on.

The schema bounds the authored arrays (`steps` to 64 ids of at most 256 bytes,
`edges` to 256, `traits.startRequirements` to the six enum values) and
`decodeBlueprint` rejects unknown properties
(`onExcessProperty: "error"`), so a mistyped field is never silently dropped
from the persisted manifest and decode cost is bounded before the compiler's
scans run.

A blueprint describing a repository code-change family's logical graph therefore
compiles to that family's steps and edges; `test/workflow-blueprints.test.ts`
proves it for `openspec`, `openspec-apply`, `openspec-propose`,
`openspec-fusion`, `openspec-fusion-propose`, `no-openspec`, `solo`, `rebase`
and `verify`, and that the same blueprint compiles to the same digest twice. A
gated stage keeps its newest-tier gate even when it is also the graph's entry
(the documentation-only `wiki` shape), because the custom-definition invariants
require a gate in front of every gated stage present, so that shape is the one
exception to the equivalence clause. Diagnostics name the rule and the
step/edge so a model can fix its blueprint; the compiler never throws for a
blueprint-shaped failure. Storage, server routes and orchestrator tools are
separate changes (`add-orchestrator-blueprint-workflows`).

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
exactly one pool question for the step that follows. It is otherwise a
pass-through: it records the arriving edge's output as its own context and hands
the same value on as its transition output, so the step it precedes receives
exactly what the edge would have delivered directly — a triage plan's locked
role set and each role's scoped files, or a review's comments. The model answer
is consumed by the routing reducer and recorded in `classifierDecisions`; it is
never forwarded as the next step's input. The state is what that step
is about to run against: the task before planning, and the task plus the plan
artifacts and the changed-file paths afterwards (never diff bodies). A loop
therefore re-selects the model, so a verification round re-asks. A single
selection pins the entry the classifier named — or, when it named none, the
offered entry with the highest `probabilities` value — and replaces every route
of its step, so one `core.verification` pool covers all verifier roles; the
reported `confidence` is observable telemetry and never changes the pick, and
only an answer with no usable decision falls back to the pool's tagged
`default`. A fusion roster recomputes `planner-1..N`. Every new start
resolves the family-traits tier (`rounds + 800`) and requires a preset whose
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

### Decision telemetry

Four engine events record a decision the workflow already took, so a round's
selection and its gates are measurable without reading a snapshot. They are
emitted through the same boundary as `gate.skip` — one envelope per event in
`.herdr-workflow/<workflowId>/telemetry.jsonl`, written after the command
commits, never able to fail or re-play it — and they add no state: the
durable record stays `snapshot.gateDecisions`, `snapshot.verificationScope`, and
the classifier decision history.

- `triage.plan.selected` — once per round, the round's role set and the path
  that produced it: `herdr.triage.source` is `classifier` (the round's own
  classification selected the roles), `default` (the graph asks and the
  classification came back fail-open, so the triage agent chose),
  `legacy-agent` (the definition predates `core.triage-route`, so the agent's
  plan has always been the selection), `reverification` (the routing step scoped
  the round to the roles owning the files the previous fix changed, read from
  the persisted scope record rather than from the classifier's answers),
  `empty-bypass` (a real zero-role verdict, which skips triage for a
  full-suite-only round and is recorded by the routing step that decided it,
  since no triage run follows), or `reverification-empty` (a fix below the
  minimum changed-file count with no reported finding to re-run, whose round
  runs the engine-owned full suite only). The event also carries the round
  index, the roles and their count, and the plan's file→role map as counts plus
  a digest; the `reverification-empty` payload also carries the measured
  changed-file count, because no triage run reports that round's change set.
- `verification_scope` — once per round that reaches the routing decision, next
  to the gate decision: `herdr.verification.scope.round`, `.mode`
  (`first-round`, `scoped`, `suite-only`, `full-set`), `.reason`
  (`no-previous-round`, `owner-touched`, `below-minimum-diff`,
  `findings-reported`, `baseline-unusable`, `delta-unusable`,
  `no-plan-ownership`, `unowned-touched-file`, `shared-touched-file`,
  `reported-role-outside-catalog`), `.threshold`,
  `.touched.count` (substantively changed files), `.touched.changed` (all
  touched files), `.baseline.count`, and the sorted `role=reason` lists
  `.roles.rerun` and `.roles.skipped` (`owner-touched`, `not-owner`,
  `below-minimum-diff`, `findings-reported`, `classifier-selected`,
  `classifier-skipped`). Roles come
  from the nine-role catalog and reasons from a closed vocabulary, so both lists
  are bounded by construction; no path and no file body is exported.
- `verification_round` — once per round that ends: the round index, `outcome`
  (`findings` when a critical finding was handed over, `none` otherwise,
  `abandoned` when a verifier run failed and the round ended without a verdict),
  the runs and roles that took part, the critical count, the role selection the
  round was locked to, and the plan's file→role counts and digest. A round that
  is still open — a sibling run in flight, or the engine-owned full suite not yet
  dispatched — records nothing, so one round has exactly one event. A round
  skipped by the verification gate runs nothing and records none: the gate
  decision is its whole record.
- `gate.decision` — once per gate evaluation, whether the stage ran or was
  skipped: `herdr.gate.stage`, `herdr.gate.decision` (`run`/`skip`),
  `herdr.gate.policy` (`auto`/`always`), `herdr.gate.forced`, and
  `herdr.gate.noul` when the classifier answered with one. The evaluation's
  latency is the envelope's `durationMs` (the classification call's measured
  duration), so it is present exactly when the effect measured one. The
  existing `gate.skip` event is unchanged and still fires on an actual skip.

The file→role map never travels as a file list: `herdr.*.files.count`, one
`role=count` per role, and a 16-character sha256 digest of the sorted
`role:path` lines are the whole of it, so a round over a thousand-file change
set costs the same as a round over one file. Payload fields the engine does not
hold at that boundary are omitted rather than invented: per-finding ids, the
warning/info breakdown, turns, tokens, cost, and peak context are not part of
the handoff contract, and the changed-file count is resolved at the triage
handoff — where the round's plan records it as `herdr.triage.changed.count` —
not at verification. The same records are queryable after the fact: import
`.herdr-workflow/**/telemetry.jsonl` into the efficiency dataset and run
`analyze.ts verification-rounds-recorded` (recorded rounds against the rounds
reconstructed from run timing, per source) and `analyze.ts gate-decisions` (the
run/skip split per gate step, per source).

### Re-verification scope

`core.triage-route` decides which roles a round runs. Rounds 2..N used to take
today's path — the classifier asks one question per eligible role and every
selected role runs again — whatever the fix actually touched. A round that
follows a fix now runs only the verifier roles that own the fix's substantively
changed files, plus the engine-owned full-suite role, which is unconditional.
The full-suite verifier never becomes skippable, no edge, outcome, round budget,
or blocking behaviour changes, and the dashboard renders nothing new: the record
is engine state plus telemetry.

The decision is computed when the routing step's classification effect
completes (only a completion can persist a record and choose an outcome) and is
persisted as `snapshot.verificationScope`, one optional exact struct with the
caps the other bounded records use (512 plan paths, 512 baseline and delta
entries, 16-character digests, 9 roles):

- `round`/`plan` — written by `core.triage`'s completion, which is where the
  round's `{role, files}` ownership is final. A round that bypasses triage (a
  zero-role selection, a below-minimum fix) records an empty plan, so the next
  round widens (`no-plan-ownership`). The plan is always written: the record is
  merged field by field, so an omitted plan would keep the previous round's
  ownership under this round's stamp.
- `reported` — written by `core.verification`'s `fix` completion: the round that
  reported critical findings and the roles that reported them (the engine-owned
  full-suite role excluded). The fix exists to resolve those findings, so the next
  round re-runs each reported role whatever file it touched, with the reason
  `findings-reported`; a reported role the definition can no longer launch widens
  the round (`reported-role-outside-catalog`).
- `baseline` — the tree the round verifies, captured at the `core.triage`
  handoff as a fallback and at every `core.implementation` handoff as its
  post-fix stamp, per file two 16-character sha256 digests: `raw` over the bytes
  and `normalized` over the bytes with ASCII whitespace removed (a binary file,
  detected by a NUL byte in the first 8 KiB, uses the raw digest for both).
  Files the engine writes under `HERDR_WORKFLOW_DIRECTORY` are excluded, or its
  own bookkeeping would widen every round.
- `delta` — measured at the `core.implementation` handoff against the stored
  baseline: a path whose `raw` digest differs, or that appears or disappears, is
  touched; one whose `raw` digest differs but whose `normalized` digest matches is
  touched but not substantive. `threshold` carries the effective
  `workflow.min_reverification_changed_files` (integer 0..20, default 1; `0`
  disables the rule).
- `decision` — the mode, the reason, the counts, and the per-role reasons.

Caps are 512 manifest entries, 1 MiB per file and 32 MiB in total; an overflow or
an unreadable file marks the capture incomplete instead of failing the handoff,
and an incomplete capture widens the round. The reader trusts no path in the
manifest: it resolves the real path, refuses anything outside the worktree or that
is not a regular file (a FIFO or `/dev/zero` never reaches EOF), and applies the
per-file cap before reading. A path the tree no longer holds is recorded as a
deletion with a reserved all-zero digest pair — a change in its own right — and a
path or plan entry longer than the record's 1024-byte bound makes the observation
incomplete rather than unwritable. A second `core.implementation` handoff in one
round window folds its fix into the round's delta (the union of the substantive
paths) instead of replacing the first fix's measurement.

The round widens to exactly today's classifier-decided round — unconstrained on a
classifier outage, minus the reported roles it must not drop — when no
previous-round record exists, when the record's round stamps are not the last
completed round and the round it opens, when the baseline or delta is missing or
incomplete, when the plan assigns no file, when a substantively touched file has
no owner or more than one owner, or when a reported role is outside the eligible
catalog. Everything unreadable or ambiguous therefore widens, and the decision's
reason names why.
Below the minimum the round runs no domain role **other than the roles that
reported the findings the fix resolved**: with none it takes the routing step's
existing `empty` outcome — `core.triage` is bypassed and `core.verification` runs
the engine-owned full-suite role only — and appends an `attention` entry naming
the below-minimum fix, so a round that opens without domain roles after a fix is
never silent. A scoped or suite-only round that ran without the classifier (an
outage) appends one too.

### Repair records

An `operator.repair` moves a workflow back to an earlier step and expires what the
step it leaves still holds. The event used to name only the two steps, which left
every repair in the imported dataset with no recorded cause: 42 repairs across 23
workflows, a reason on none of them. The transition now carries its own record —
in the committed event data, on `snapshot.repaired`, and on the workflow view's
`repaired`:

- `reason` — the operator's own words, bounded to 160 characters with control
  characters collapsed and known credential shapes redacted, through the same
  `boundedSummary` helper that bounds an event's `detail`. An absent reason is an
  empty string, never a placeholder.
- `expiredEffects` and `retiredRuns` — the ids of the outbox rows the expiry
  retired (`artifact.write`, `agent.prompt`, `agent.launch`) and of the runs it
  expired, including a debug run the expiry launched. Both are capped at 32
  entries and deduplicated; a `snapshot.repaired` record is a summary of what the
  repair did, not a second copy of the outbox.
- `count` — how many repairs the workflow has recorded by then, this one
  included, read from the committed `operator.repair` events. It is a
  reconciliation figure, not stored state: a workflow's events and its record
  always agree about it.

The engine telemetry event carries the reason and the two counts
(`herdr.repair.reason`, `herdr.repair.effects`, `herdr.repair.runs`, and
`herdr.repair.count`) and no ids, because `boundedTelemetryPayload` keeps scalars
only — the ids live in the durable event and the snapshot, which is where a reader
that has to act on them reads them. Recording is observational: a repair with no
reason still repairs, and neither the source step, the target step, the expired
effects nor the retired runs depend on the record being written. In the efficiency
dataset the reason lands in `events.detail` and the counts in
`events.repair_effects`, `events.repair_runs` and `events.repair_count`, which is
what `analyze.ts operator-repairs-recorded` reports per source — every repair, and
how many carry a reason and a retirement count — against the baseline of 42
repairs over 23 workflows with a reason on none of them.

### Developer waits

Agent time stops and human time starts wherever the workflow hands itself over to
the developer: a question it asked (including a `login-handoff` ask, which is one
of these records), a run that handed off as blocked, or a step whose actor is the
developer — the plan, findings and wiki gates. The wait is a **projection**, in
`src/workflow/runtime/waiting.ts`, over state the engine already has: the
snapshot's status and current step with its entry time, the dialogue records, the
run rows, and the actor of the current step in the pinned definition. It is never
stored, never a snapshot field and never an effect, so there is no schema or
migration for it and no way for it to disagree with the state it describes. The
view carries it as `waiting` (`{ kind, subject, since }`, optional and additive,
with `waitResponseSchema`), precedence is question over handoff over approval,
and the subject is the oldest open question, the first blocked run, or the gate's
step id. A question the developer owes an answer for is a record that is pending
and not routed to a peer agent; one still routed to the orchestrator counts,
because the developer is the backstop. The clock never ends a wait: a record past
its durable expiry is still the wait until the expiry the engine records clears
it, so every start has an end. A workflow that is `completed` or `closed` waits
for nobody, which is what makes a wait left open by a killed run end at the close.

The wait becomes an event at each transition, not on each read. In the engine,
`commitDispatch` projects the wait *before* the reducer runs (`waitBefore`, over
the pre-transition run rows) and again after the commit (`waitAfter`), and the
repository writes `workflow.waiting.ended` then `workflow.waiting` only when the
two differ — so a poll, a retried command, a re-entered gate and a repeated read
emit nothing, and one blocking state replacing another ends one wait and starts
the next in that order. A workflow that starts straight into a developer step gets
its start event from the start path for the same reason. Leaving a wait reports
`herdr.wait.seconds`, so the recorded telemetry can be summed per workflow.

The event bus derives the same pair from the workflow view it already observes
(`deriveWorkflowEvents`), which is what the event stream, subscriptions and the
shells read: the first observation of a workflow emits nothing, an unchanged wait
emits nothing, and both events are in the versioned catalog
(`WORKFLOW_EVENT_CATALOG_VERSION` 3) with payload schemas, category `workflow` and
**not** `human-needed` — the obligation itself already notifies as
`question.pending` or `review.waiting`, and a second notification per wait would
double it. In the efficiency dataset `wait_kind` comes from `herdr.wait.kind` and
the subject from the telemetry detail, and `analyze.ts developer-waits` reports
agent seconds and human wait seconds as two numbers per workflow: it prefers the
recorded waits and falls back to the question records (`asked` paired with
`answered` or `expired`) only where a source recorded none, which is the 22
question waits and 3,562 seconds the dialogue alone could account for.

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

Every hook context also carries `traits`: the pinned definition's effective
family traits, resolved once per command by the caller through
`effectiveFamilyTraits(definition)` (read-family-traits-instead-of-ids). A
behavior that used to branch on a repository code-change family id reads the
trait instead, so a graph composed at runtime — a definition with an id the
engine has never seen — behaves by what its manifest declares. `traits` is
`undefined` for the documentation families (`wiki`, `wiki-comments`,
`research`), which declare none; a hook invoked without it (a direct call, or a
tier registered before the family-traits tier) falls back to the same per-id
table `effectiveFamilyTraits` reads, so no built-in family changes behavior.

`StepBehavior` hooks:

- `classification` — the classifier mode (`single` or `roster`) a classifiable
  step declares; absent when the step is never asked of the classifier. The
  route steps and the reducer read it from the registered step definition.
- `roles` / `candidateRoles` — which agent roles are active now / could ever be
  routed for this definition (stage A).
- `validateEvidence({ snapshot, traits })` — entry-guard predicate run before a
  step's `complete` outcome is accepted; throws `WorkflowRuntimeError("entry-guard",
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

### The archive attempt budget (efficiency backlog item 17)

Two archive runs in the measured corpus spent 110 and 58 turns — around 40
`openspec` invocations and 90 kB of output between them, 23% of that family's
archive turns — and both ended `attention-required` with an `operator.repair`
afterwards. The cost was not the archive but the unbounded repair loop: the run
re-derived, re-validated and re-archived while the developer waited.

`core.archive`'s behavior now spends a **two-attempt budget per archive entry**
(`ARCHIVE_ATTEMPT_LIMIT` in `src/workflow/steps/lifecycle.ts`):

- one attempt is one `openspec validate --strict` plus one `openspec archive
  --yes` pair. The assignment states which attempt the run owns and what that
  attempt may do: attempt 1 repairs nothing, attempt 2 fixes only structural
  merge markers (a missing `## MODIFIED Requirements`/`## REMOVED Requirements`
  section) and never rewrites requirement or scenario content;
- a failed attempt that still has budget hands off `blocked` and the engine
  re-enters the step: exactly one structural repair round;
- the **second** failure hands off `blocked` and returns no completion at all,
  so `runtime/reducers/agent-handoff.ts` parks the workflow
  `attention-required` with the run's own validator output as the `attention`
  detail, redacted for known credential shapes (`redactTelemetryText`; the
  handoff contract's own 4096-byte `message` bound is what keeps a transcript
  from arriving unbounded), and no third archive run is launched;
- a developer `operator.repair` or `resume` re-enters the step without an
  engine arrival, which starts a **fresh pair** of attempts.

The counter is step-local state in `snapshot.loopCounts`
(`core.archive:attempts`), like the verification round and fix counters, so no
snapshot schema change is needed. `onArrive` counts an entry the engine
transitioned into — the graph entry, or the failed attempt's own self-loop — and
sets the `core.archive:arrival` marker; `onEnter` consumes that marker and
starts a fresh pair when it is absent, because the engine's `enterStep` without
a transition is by construction a developer repair, a resume, or a profile
preset switch, each of which should grant one. A granted repair round is
reported as the `archive.repair_round` decision event (failed attempt, next
attempt, limit); the parked attempt needs no event of its own, because the run's
blocked handoff and the parked workflow are its visible signal.

The graph's `blocked`/`failed` loop edges keep their `maxAttempts: 3` bound:
the second blocked attempt now never reaches them, and the `failed` outcome
keeps the retry it always had. The happy path is untouched — a change that
archives on its first pair completes through the same evidence check
(`validateArchiveEvidence`) and the same `complete` transition.

The `archive-attempts` efficiency query (`scripts/efficiency/lib/queries.ts`)
lists archive runs per snapshot with turns, calls, the handoff outcome and the
item's 12-call ceiling flag, so the bound is verified from the corpus rather
than from this document.

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
manifest in the rejection. `requiresReadOnlyResearcher` is false for the
definition a new start resolves: the research-tool tier sets it false, the
step-routing tier's second `withManifestPolicy` pass carried it true again, and
the family-traits tier — the tier new starts pin — restores the full-tool
policy (see its bullet), so a `research` start runs with the selected profile's
normal tools. Older pinned definitions retain their original policy and digest.

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
  tool access. The tier stays registered so workflows pinned to it keep their
  policy and their digest; new research starts resolve the newest registered
  tier (the family-traits tier below), which sets the flag false again.
- **Verifier-role tier:** `definitionVersionForTriageRouting(rounds)` =
  `rounds + 500` — adds `core.triage-route` to the shared implementation loop.
- **Stage-gate tier:** `definitionVersionForStageGates(rounds)` =
  `rounds + 600` — adds `core.plan-gate`, `core.review-gate`, and
  `core.wiki-gate`, gives `core.triage-route` its `skip-verification` outcome
  (as step version 2, with version 1 still registered for the tier above), and
  registers the standalone `wiki` family unchanged.
- **Step-routing tier:** `definitionVersionForStepRouting(rounds)` =
  `rounds + 700` — one routing step immediately before every classifiable
  agent step. A family added later (like `rebase`) is registered here as well
  as in every tier below only so a pinned lookup of an older version still
  resolves it — a family's own digest covers only its own manifest, so
  appending one never changes another definition's pin.
- **Family-traits tier:** `definitionVersionForFamilyTraits(rounds)` =
  `rounds + 800` — the same graphs as the step-routing tier, plus a declared
  `traits` block on every repository code-change family. This is the version
  `startWorkflowInProcess` / `cli.ts`'s `start` command actually use for new
  workflows. Every reader now resolves its per-family decision through
  `effectiveFamilyTraits`: the step behaviors (change-free implementation,
  close-only completion, OpenSpec-verifier eligibility), the start guards and
  start requirements (`validateStart`, `validateStartEvidence`), fusion
  planning, the workflow-id change identity, the launcher's checkout mode, and
  the rebase checkout preparation — so a graph composed at runtime declares
  which family it behaves as instead of falling through every literal
  comparison. `test/workflow-repository-family-literals.test.ts`'s architecture
  guard (`checkRepositoryFamilyIdComparisons`) fails on any new repository
  family id compared to a definition id outside `workflow/definitions/`, while
  the `wiki`/`wiki-comments`/`research` checks stay by design. It also
  restores `research`'s full-tool policy, which the step-routing tier's second
  `withManifestPolicy` pass had reverted and thereby made unstartable (the
  start guard looks for a route named by `definition.initial`, which per-step
  routing had rewritten to the `core.route-research` system step); only
  versions 801..820 move, and nothing was pinned to them.

All tiers stay registered; nothing is removed. `start()` reads policy
through `effectiveManifestPolicy(definition)`, which falls back to the same
per-id table the manifest-policy tier is built from when a resolved
definition has no `policy` block (any legacy or wikiGate-policy version).
`effectiveFamilyTraits(definition)` reads a declared `traits` block the same
way, falling back to the per-id family-traits table for any version registered
before the family-traits tier — so every repository code-change workflow has
traits, declared or fallback, whichever version it is pinned to.
This is why a workflow pinned to a pre-manifest-policy version still starts
and dispatches without repair: `policy` is read only inside `start()` — no
other engine function references it — so it cannot affect an already-running
workflow's `transition`/`dispatch`/`validateStepEvidence`/`actions` path.

## The rebase family

`rebase` is the one family whose launch selects a branch instead of inheriting
one: `core.rebase` runs one agent (role `worker`, capabilities `shell` and
`edit`) that rebases `metadata.branch` onto `metadata.baseBranch` in the
repository checkout and resolves the conflicts. It has no planning, triage,
verification, developer review, wiki, archive, or delivery step — completion
offers `close` only.

- The launch surface (`NewWorkflowModal`'s two branch pickers, or
  `start --branch BRANCH --onto REF`) sends the two refs on
  `WorkflowStartRequest.sourceBranch` / `targetBranch`; `startup.ts` maps them
  onto `metadata.branch` / `metadata.baseBranch`, forces checkout mode, and
  runs one best-effort `git fetch --prune` on the configured remote before the
  branch rules are enforced.
- `validateStart` (startup) and `validateStartEvidence` (the engine's own
  start guard) both require the source to be an existing local branch and the
  target ref to resolve, and refuse the two being the same ref. They mirror the
  clean-tree rule the same two boundaries already duplicate.
- The manifest policy keeps `checkoutRequired: false`: the family uses the
  repository checkout, but the selected source branch is *not* necessarily the
  checked-out one, so `start()` must not demand `metadata.branch === current
  branch`. `workspace.setup`'s observation therefore reports the checkout as
  set up only when it is already on the selected branch, and its execution
  switches it otherwise; a checkout run owns no worktree, so
  `workspace.cleanup` stays a no-op. `prepareRebaseCheckout` (effect-runner)
  verifies the source branch and target ref once more and fetches the target
  remote, so an unresolvable target parks the run in `attention-required`
  without ever launching an agent.
- The two pickers read the `branches` observation (`discoverBranches`): local
  refs for the source, local plus remote-tracking refs for the target, with the
  repository's default branch preselected.

## The verify family

`verify` is verification entered without a planning or implementation phase: it
verifies the branch the checkout is already on against the configured base
branch, then hands the round's findings to a developer review that selects what
a worker fixes. It has no plan, plan approval, review gate, wiki, archive, or
delivery step — completion offers `close` only.

- The change set is the whole branch, not just the uncommitted work: `startup.ts`
  fetches the configured remote once and sets `metadata.baseCommit` to
  `git merge-base <workflow.base_branch> HEAD`. `changedFilesIn` (the
  `git status` ∪ `baseCommit..HEAD` manifest) and every per-file diff
  (`collectTriageClassifierState`, `loadLocalChanges`, `loadLocalDiff`) measure
  against that one commit, so committed branch work and uncommitted work are
  both in scope and a file the branch never touched is not. A base ref that does
  not resolve, or shares no ancestor with HEAD, fails the start with the ref
  named.
- The manifest policy is `checkoutRequired: true`, which is exactly the contract
  the family needs: the repository checkout, mode `checkout`, and
  `metadata.branch` equal to the current branch (never a switch). That flag also
  makes `start()` pass `proposal` to `validateStartEvidence`, so the clean-tree
  rule is deliberately off — verifying a dirty checkout is the point. The
  startup boundary mirrors both decisions (`validateStart`'s verify branch,
  `validateVerifyBase`).
- The graph is `core.triage-route → core.triage → core.verification →
  core.findings-review`, and both verification verdicts land on the review: a
  failing round has the critical findings that must be selected explicitly, and
  a passing round still has advisory ones. `core.findings-review` declares the
  same `approve-review` / `review-comments` actions and input schema as
  `core.developer-review`, so the dashboard renders and dispatches it through the
  same popup (`requiredUserActionFor` gives it the same `developer-review` key);
  the difference is that `loadDeveloperReviewFindings` includes critical findings
  while this step is current, and that `comments` enters the standard worker loop
  (`core.implementation` in `review-fix` mode, whose completion re-enters the
  round at `core.triage-route`). Both the verification `fix` edge and the
  worker's `complete` edge carry the loop budget, so the fix cycle is bounded and
  the `limit` verdict parks the workflow in `attention-required`.
- `core.implementation`'s arrival mode reads the carried payload, not only the
  edge outcome: the per-step routing pass hands a review's comments on as its own
  transition output with outcome `complete`, so an outcome-only check ran every
  review fix in `apply` mode. The `comments` payload now decides, which also
  fixes the same path for the shared families on the routing tier.

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
| `runtime/store.ts` `validateEffect()` | A row is legal when the current step's `allowedEffects` lists it, or when one of that step's own inbound edges declares it (`definition.edges`); plus research's workspace-setup-before-entry ordering | Edge effects are enqueued while advancing into their destination step, so a promotion into delivery/completion — or, with per-step routing, into the routing step that precedes archive — is legal without broadening that step's contract. A persistence/outbox invariant, not step business semantics. |
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
| `definitions.ts` | The definition resolver: built-in registry first, then the target store's `workflow_definitions` rows for the `custom.` namespace, recompiled against the current step catalog and cached per process by identity (re-validated against the requesting registry on every hit), plus `validateDefinition`/`storeDefinition` for the operator `define` path. Imports `store.ts` (not the reverse: `store.ts` takes the resolver as an injected parameter for its due-question-expiry path). |
| `evidence.ts` | Git inspection, source-content fingerprinting, changed-file discovery, current-branch lookup, wiki baseline/verification content reads — all external-I/O reads. |
| `evidence-store.ts` | The evidence store's location and lifecycle (`add-workflow-evidence-store`): `workflowDataRoot`/`workflowEvidenceRoot`/`workflowEvidenceScope` (the checkout's `.herdr-workflow` or the shared wiki/research data root, plus the roots an attach may resolve inside) and `workflowEvidencePresent`/`removeWorkflowEvidence`, which the engine's `workspace.cleanup` observation and execution both use. The manifest, ids, content checks and caps live in `server/evidence/store.ts`. |
| `capability.ts` | **The security boundary** (design D2): token hashing/comparison, run capability issuance, agent and exact-run authorization, and the `MAX_ARTIFACT_BYTES`-bounded artifact checks. Extracted as one cohesive unit so it can be reviewed and tested as a whole. |
| `dialogue.ts` | Developer-question dialogue: resolving the run a question command acts on (`questionRun`), answering a question or questionnaire (`answerQuestion`, including the developer's backstop answer for an orchestrator-routed record), finding the record an answer event names (`answeredQuestionRecord`), and marking questions expired (`expireQuestions`). The agent-facing wait (`AGENT_QUESTION_WAIT_MS`) and the durable lifetime (`QUESTION_WAIT_MS`) live here as separate constants. Needs only the clock. |
| `engine-types.ts` | Public request/result shapes (`StartWorkflowInput`, `DispatchResult`, `ClaimedEffect`, `RepairPreview`) factored out so leaf modules can reference them without importing `engine.ts`. |
| `kernel.ts` | The shared step-transition primitives every reducer and `engine.ts` need: `enqueue`, `applyReduction`, `createRun`, `enterStep`, `transition`, `resumeBlockedAsker`/`resumeAskerAfterAnswer` (re-issue the run that asked a question once its answer is recorded), plus the pure step-shape helpers (`freshStep`, `resolveArrivalContext`, fusion routing/draft helpers) and run-expiry helpers (`expireRuns`, `expireSiblingRuns`). Agents stay live across expired runs; workspace closure owns process shutdown. Kept separate from `engine.ts` because every `reducers/*.ts` module needs these without needing the `WorkflowEngine` class itself — importing `engine.ts` from a reducer would close the cycle `engine.ts -> reducer -> engine.ts`. |
| `view.ts` | The read model: `view`, `list`, `status`, `previewRepair`, and the run/effect projection into `WorkflowView`. Read path only. |
| `waiting.ts` | The developer wait as a pure projection (`WaitState`/`waitState` → `workflowWait`) plus `definitionStepActor` for the current step's actor. Shared by the view, the engine's emission and the event bus, so all three name the same wait. No store access, no clock, no state. |
| `reducers/*.ts` | One file per `reduce()` command branch (or a small explicitly-grouped set: `agent-question.ts` holds both `agent.question` and `agent.question-expire`; `repair.ts` holds `operator.repair`, `operator.repin`, and `operator.resume`). Each reducer receives `registry`/`now` as explicit parameters and the already-open `db`/`snapshot` — it runs inside the kernel's existing transaction, never opening its own. |
| `engine.ts` | The `WorkflowEngine` class: `start`, `dispatch`, the `reduce()` command-type dispatch table, `claimEffects`, `telemetry`, `locate`, and thin public-API delegates to the modules above. The residue once every leaf/feature/reducer is moved out. |

### `src/workflow/definitions/`

| Module | Owns |
| --- | --- |
| `catalog.ts` | `PUBLIC_WORKFLOW_CATALOG` — the human-facing workflow family list. |
| `digest.ts` | Canonical JSON (`stableJson`) and the SHA-256 `digest` every workflow/step/projection identity is built on, shared by `registry.ts` (re-exported there) and the custom-definition identity. |
| `custom.ts` | The `custom.` namespace, the derived content-addressed identity (`customDefinitionDigest`/`withCustomIdentity`), and `assertNewestTierInvariants` — the newest built-in tier's rules a custom manifest must satisfy at store time and on every load. |
| `contracts.ts` | The step output contracts (`triage`, `findings`, `planDraft`, `passthrough`, `empty`) and the standalone `researchHandoffContract`. |
| `steps.ts` | The `step()` factory, per-step instruction asset list, `commonImplementationSteps(triageRoute)`, and the full `WORKFLOW_STEPS` catalog. |
| `edges.ts` | `workflowEdges()` (the shared implementation-loop edge builder, which threads the triage-routing edges) and `definitionVersionForPolicy`. |
| `manifest-policy.ts` | The version tiers (`definitionVersionForManifestPolicy`, `…ForBehaviorPins`, `…ForResearchTools`, `…ForTriageRouting`, `…ForStageGates`, `…ForStepRouting`, `…ForFamilyTraits`), the per-workflow-id policy table with the repository family-traits table, and the fallbacks `effectiveManifestPolicy` / `effectiveFamilyTraits`. |
| `graphs/*.ts` | One file per workflow family — `openspec.ts`, `no-openspec.ts`, `fusion.ts`, `wiki.ts`, `research.ts` — each exporting a manifest-builder function for that family only. |
| `registerBuiltins.ts` | Orchestrates step registration and every family's graphs across every verification-round count and wikiGate/manifest-policy tier. |

### `src/workflow/blueprints/`

| Module | Owns |
| --- | --- |
| `catalog.ts` | The blueprint step catalog (`BLUEPRINT_STEP_CATALOG`, `BLUEPRINT_STEP_IDS`) — the logical allowlist with label/actor/outcomes read from the registered step catalog and a description each — plus the internal-step predicates (`isInternalStepId`, `gateForStage`, `GATED_STAGES`). |
| `review.ts` | `validateBlueprintReviews` — the human-review invariant over the logical graph, by node removal and reachability, returning violations with one offending path each. |
| `compiler.ts` | `decodeBlueprint`, `compileBlueprint`, the diagnostic/summary types and the bounds constants — the pure blueprint → `custom.` manifest compiler (triage-routing/gate/per-step-routing insertion, exact step references, policy from traits, registry dry-compile). |
| `index.ts` | The blueprint domain barrel consumers import. |

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
| `commands/*.ts` | One module per command (or small group): `start.ts`, `define.ts` (custom-definition store), `dispatch-actions.ts` (action/question/handoff), `wiki.ts`, `research-handoff.ts`, `misc.ts` (repair/repin/agent-extension/listProjects). |
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

## The durable agent host (`src/agent-host/`)

`pi-durable` is the one managed runtime and hosts its own process. Its code is isolated
under `src/agent-host/` so the heavy experimental `@earendil-works/pi-durable`/
`pi-ai` packages are never eagerly loaded by a command mode that does not need
them:

| Module | Owns | Imports pi-durable/pi-ai? |
| --- | --- | --- |
| `protocol.ts` | The versioned NDJSON wire protocol (requests, responses, framing, byte bound) between the host and its clients. | No. |
| `layout.ts` | Storage/socket/lock/log/run-env paths under one workflow's runtime directory. | No. |
| `client.ts` | `HostClient` (typed request/response + `watch`) and `ensureHostRunning` (connect-or-spawn). The engine adapter (`PiDurableAdapter` in `workflow/adapters.ts`) and the dashboard session snapshot (`tui/dash/handlers/keys.ts`) depend on this module only. | No. |
| `settings.ts` | The `agentHost` configuration section type and its one-time seeding from the global pi `settings.json`. | No. |
| `credentials.ts` | `PiAuthCredentialStore`, a pi-ai `CredentialStore`-shaped adapter over the user's live `~/.pi/agent/auth.json` (no copying). | No (structurally compatible, not statically coupled). |
| `tools.ts` | The durable extensions: coding tools + read-only policy, `developer_question`/`agent_ask` (bounded agent wait, abort signal forwarded to the spawned CLI), `ask_jev`, the system-prompt sections, and the CLI handoffs a developer's session drives: `recordAbortedRunHandoff` (the `blocked`, `--aborted` handoff an abort records) and `recordResumedRunHandoff` (the `resume-run` reconcile that reopens the parked run for the next prompt). `recordFailFastRunHandoff` records the run's own `blocked` handoff when the host stops it for a dead tool surface. | Yes. |
| `bash-tool.ts` | The `bash` tool's wall-clock bound (efficiency review item 2): pi-durable's coding tools with `bash` replaced by one that runs under a 120-second default when the caller passes no `timeout`, stops the command's process group when that bound fires, returns the output collected so far plus what to do instead, notes the elapsed time of a call that ran past 60 seconds, and caps a caller's own `timeout` at 3600 seconds. | Yes. |
| `fail-fast.ts` | The per-run dead-tool-surface rule: the consecutive-failure and success counters, the failure kinds that mean a broken surface, the exempt roles, and the bounded secret-free `blocked` message. Pure logic, no harness and no I/O. | No. |
| `tool-suggestions.ts` | What a failed `read`/`edit`/`grep` call adds to its own error text (efficiency backlog item 12): the nearest whitespace-normalised region of the file with line numbers, the lines a non-unique `oldText` occurs at, the overlapping edit indexes, the nearest existing path for a path that is not there, or the first entries of a path that is a directory. Pure text logic plus one bounded path search, wrapped around pi-durable's `read` and `edit` by name. | Yes. |
| `host.ts` | `DurableHost`: opens the `Harness`, serves the control socket, maps requests to conversations, records a developer abort as the run's `blocked` handoff (`abort`; never on teardown), serializes a conversation's mutating requests so a prompt cannot race the abort's withdrawal, reconciles the workflow state before delivering a prompt to an aborted run, and feeds every finished tool call to that run's dead-surface monitor (`onToolOutcome`). | Yes. |
| `configured-models.ts` | The one durable model collection (`durableModels`): pi-ai's built-in providers with the custom providers of global pi's `models.json` composed over them by pi's own loader, plus the configured-provider / `provider/model` enumeration the `/model` picker, the Settings agent-profile select and a run's model resolution all read. A `models.json` that cannot be used adds nothing and reports one content-free diagnostic; an absent one adds nothing and reports nothing. | Yes, through a dynamic `await import()` inside the builder, so a caller that supplies its own collection never loads the `models.json` loader. |
| `host-main.ts` | The `agent host --workflow-dir DIR` process entry point. | Yes (transitively, via `host.ts`). |

`src/cli.ts`'s `agent host` mode reaches `host-main.ts` through a dynamic
`await import()`, which the source-layer boundary check does not track as a
static edge, so no other command mode pays for loading `host.ts`. The boundary
check (`scripts/workflow-architecture.ts`) classifies every file under
`agent-host/` as **runtime**; the client/protocol-only dependency the
workflow/dashboard layers are meant to take is a discipline enforced by
reviewing `workflow/adapters.ts` and `tui/dash/handlers/keys.ts`'s own imports
(they import `client.ts`/`protocol.ts` only), not by a dedicated static rule —
a narrower guarantee than a hard import-allowlist would give.

### Global pi `models.json` custom providers (fix-custom-provider-models-in-pickers)

The durable model set is pi's own two layers, not just the built-in half: the
providers pi-ai ships **plus** the custom providers of the user's global pi
`models.json` (`$PI_CODING_AGENT_DIR`, else `~/.pi/agent`). `configured-models.ts`'s
`durableModels()` composes them with pi's loader rather than a second reading of
the file — `ModelRuntime.create` loads `models.json` through `ModelConfig` and
composes each provider with `composeModelProvider`, so pi's schema, its `apiKey`
forms (literal, `$ENV_VAR` template, `!command`) and its header handling are the
ones in force. That is also pi's precedence rule for a provider id that collides
with a built-in one: the file is overlaid on the built-in provider, which keeps
its api and gains the configured `baseUrl`, models and auth. `create` is called
with `refreshOnCreate: false` and an in-memory models store, because this is a
read of `models.json` and never a catalog refresh — the durable host must not
write `models-store.json` behind pi's back.

The host builds that collection once (`DurableHost.open`) and hands the same one
to the `Harness`, to `catalog()` and to `configuredModelList()`, so the `/model`
picker, the Settings profile select and a run's launch-time model resolution
cannot drift apart. A `models.json` that is unreadable, malformed or
schema-invalid leaves the built-in providers intact, is logged once as one
content-free diagnostic (pi's own message: the file and the offending paths,
never the content and never a key) and never fails the host or a picker. A
custom provider counts as configured when pi-ai's side-effect-free `checkAuth`
accepts it, which includes a `models.json` `apiKey` and — deliberately — a
`!command` key without executing the command, so rendering a picker runs nothing
from that file. `workflow/profiles.ts` keeps its small synchronous reader for
workflow-start validation; the two agree on the same file because both answer
for the providers and model ids that file declares.

**Known gaps in this pass** (add-pi-durable-runtime, deliberately deferred):
the `use-default-model` built-in preset still defaults to `pi`, not
`pi-durable`, because flipping that sitewide default has a blast radius this
implementation pass could not fully verify with focused tests; `pi-durable`
model validation at workflow start accepts a built-in provider's model on
shape alone rather than enumerating pi-ai's full catalog (a locally configured
custom provider's models are still validated exactly). The host side of that
custom-provider half is closed by the section above: the durable collection
composes the same global pi `models.json`, so every model validation accepts is
also offered by the pickers and resolvable at launch.

### The environment capability handoff (fix-env-tools-for-all-runs)

Every durable run receives `AGENTIC_ENV_URL` and `AGENTIC_ENV_TOKEN` in its run
environment (`agent-host/environment-capability.ts`): the base URL of the
unified server plus the capability `environmentTokenFor` derives for
`workflow:<id>`, which the owner-scoped `/api/v1/agent-env/*` surface verifies.
The `env_*`, `browser_*` and debug tools all present it, so a run whose run
environment lacks it has no environment, browser or debug tools at all.

The endpoint has two sources, in this order:

1. the **in-process publication** (`publishEnvironmentServer`) the unified
   server's composition root makes — the engine and the server are one process
   when the shell or a headless `agentic-coding server` drains;
2. the **discovery record**, `environment-server.json` under the configuration
   root, written by `startWorkflowServer` when it was told which configuration
   it serves (`mode 0600`, replaced atomically, removed on shutdown).

`ensureEnvironmentServer()` resolves the record once per process, and every
launch path calls it before it builds a run environment (the effect runner's
`agent.launch` and its redelivery path; the CLI's `workflow start`, so the
health an env-setup start records is decided from the real answer). This is what
makes the capability reach runs launched by a process that is **not** the
server: a `workflow start`/`workflow drain` in another repository, the
per-repository `agent host`, or a workflow of a repository other than the one
the shell was started for. A record is trusted only when it is loopback, mode
0600, names a live pid, and the server at that URL answers `/api/health` with
the recorded instance — so a stale or foreign record is ignored instead of
handing a run an endpoint it cannot use. A discovered endpoint is used only for
the configuration root this process resolves, so no run is ever handed a
capability derived for a configuration it does not serve.

When no server is reachable anywhere, today's behaviour is kept and made
visible: the rendered assignment states that the environment tools are
unavailable, and starting an `env-setup` workflow (which cannot do its job
without them) records the same in the workflow's own `attention` health instead
of launching an author run that can neither start nor build what it drafts.

### The session window (efficiency backlog item 20)

A run has two windows and the record used to state only one of them. The **run
window** is the engine's: `workflow_runs.started_at` to `completed_at`, closed by
the run's `agent.handoff`. The **session window** is the durable host's: one
pi-durable conversation per canonical agent name — `(workflow, step, role)`,
stable across rounds, attempts, repairs and resumes — which outlives every run it
serves.

Nothing used to say that a session continued: the conversation's telemetry
stream was attached once, with the identity of the run that created it, so every
later run of the same step and role was stamped with that first run's id. On the
pinned snapshot 156 of 1,259 runs carried turns after their own recorded
completion (11,960 of 34,711 turns) while the runs that actually did the work
recorded none — a run labelled `blocked, 4 minutes` covered 45 minutes of work.

`host.ts` now keeps one **binding** per conversation (`sessionBindings`: the run
most recently bound to it, with that run's identity) and updates it in
`ensureRun` before the run's first submission:

- the conversation's telemetry stream resolves its identity once per event
  (`attachTelemetry` takes an identity or a getter) and hands that identity to
  each writer, so a turn that lands after a rebinding is the later run's turn —
  and the cost ceiling is decided from the measurement of the run that produced
  the message, while a tool outcome is charged to the run that *started* that call
  (`tool_execution_start` records the owner by `toolCallId`), so neither can act on
  a run other than its own. A dead-surface decision is acted on with the failing
  run's own context and recorded as `herdr.fail_fast.scope: "owner-rebound"`
  (refused, no abort, no handoff) when a later run now holds the conversation;
- the move is stated as two runtime envelopes on the same sink, both carrying the
  conversation id as `herdr.session.conversation_id` (never as `sessionId`, which
  means *run* id everywhere else):
  - `runtime.session_window.opened` with `herdr.session.reason` — `created` (the
    conversation was made for this run), `rebound` (an existing conversation
    whose previous run is known, with `herdr.session.previous_run_id`), `adopted`
    (an existing conversation whose previous run this host cannot name, as after
    a restart) or `resumed` (the same run bound again, as after an abort);
  - `runtime.session_window.closed` for the run being left, with
    `herdr.session.rebound_to` naming the run now bound, emitted before the
    opened record. A close that could not be written (the leaving run's workspace
    is gone) is retried into the binding that now holds the conversation, and on
    that conversation's later bindings, until it lands — its absence is what a
    reader treats as a defect.

The whole transition (read the previous binding, drain the stream, write the new
one) is serialized per conversation, so two overlapping rebindings can neither
close one run twice — naming a successor that never held the conversation — nor
leave the last run unclosed. The drain is one macrotask turn: pi-durable publishes
a commit's events synchronously and delivers them a microtask later, so without it
a frame already committed under the leaving run would resolve the new identity.

The two windows stay separate on purpose. A run is **not** closed when its
session stops: that would change when a run — and so a workflow — is complete,
and would relabel a resumed run, which is the *same* run and must keep its
window. Both envelopes are observational: they write no workflow state, need no
store field (`STORE_SCHEMA_VERSION` stays 6), no migration and no snapshot, and a
failed emission leaves the run and the workflow exactly as they would be
without it. Nothing is recorded for a conversation with no run id in its
environment (an orchestrator session).

A reader pairs the two: `scripts/efficiency`'s `run-window-drift` query reports,
per drifting run, the turns in its tail, whether a session-window row names *that
run* (`session_recorded`) and a `drift_kind` of `attributed` (a `closed` row
states the session went on under a later run), `resumed` (the recording binds the
run's own conversation to it at or after its completion, or with the reason
`resumed`), `clock-artifact` (the run's recorded completion is not after its
start, so the window cannot be read) or `unexplained` (the record states no
continuation, whether or not it names the run — a binding from before the run's
completion is not one). The build refuses an `unexplained` tail whose record was
due.

The build's gate is **per run, not per workflow**: a run is recorded iff a
session-window row names its run id, so a workflow that records one run's move
still cannot hide another run's lost record. A run with no record of its own is
either *before the record* (it started before its workflow's first
session-window event, or its window cannot be read) — counted, never failed — or
a **broken record** (it started after that event and still has none), which fails
the build exactly like an unexplained tail does (see
[`efficiency/01-dataset-tooling.md`](./efficiency/01-dataset-tooling.md)).

**Coverage limit**: the conversation survives everything, but the host's binding
map is in memory. A host restart between two rounds of the same step loses it, so
the next `ensureRun` records `adopted` and no `closed`, and the turns the
detached conversation produced while no stream was attached are not attributed to
anyone (`watchEvents` streams only what is published after the attachment). That
hole is *unrecorded*, never misattributed.

`stopRun` deliberately keeps the conversation's binding even though it drops the
run's own bookkeeping — and it only drops that bookkeeping when the conversation
is still bound to the run it is stopping, because a successor can be ensured while
the abort is in flight. A conversation reused after its run was retired therefore
records `rebound` from that run, which is what the query's `attributed` class
means.

Two ordering rules keep the record honest. The stream is drained for one macrotask
turn before a rebinding, because pi-durable publishes a commit's events
synchronously and delivers them a microtask later: without the wait, a batch
already committed under the leaving run would resolve the *new* identity and
re-stamp that run's turns. And a `closed` record whose append failed (an
unwritable telemetry path, a removed workspace) is kept per conversation and
retried on the conversation's next binding, because its absence is what the
dataset build treats as a defect. The binding map and that retry live as long as
the host process — the same lifetime as the per-conversation telemetry stream —
and die with it, never per run.

### Fail fast on a dead tool surface (efficiency backlog item 3)

Nothing used to cut a run short when every tool call failed: the agent kept
taking turns against a broken tool host, a denied sandbox or a wrong working
directory, each turn re-reading the whole context. The tool-call telemetry shape
now records every call's `ok` and a machine-readable failure kind, so
`agent-host/fail-fast.ts` can decide it.

`ToolSurfaceMonitor` counts consecutive failed calls and successes per run:

- a run is **surface-dead** when it has had **zero successful calls** in this
  run *and* either five consecutive failures whose kinds mean a broken surface
  (`host-error`, `denied`, `timeout`, `aborted`, `invalid-args`, `other`) or
  fifteen turns of failures that are all one tool's;
- `not-found` and `no-match` never count towards the five: reading a path that
  does not exist yet, or editing text that is not there, is ordinary work;
- one successful call anywhere disables the rule for the rest of the run — the
  rule is about a surface that never worked, not about a run going badly.

The thresholds are the module's exported constants
(`FAIL_FAST_CONSECUTIVE_FAILURES`, `FAIL_FAST_TURNS_WITHOUT_SUCCESS`). The
first detection re-probes the run's tool host **once** and gives the agent one
more turn: `reprobeToolHost` re-runs the environment-server discovery probe
(the unified server behind `env_*`, `browser_*` and the debug tools) for a run
that actually received `AGENTIC_ENV_URL`, and a run with no such host reports
`probed: false` honestly rather than inventing a mechanism. A call that fails
after that ends the run: the conversation is aborted and the host records the
run's own `blocked` handoff (`recordFailFastRunHandoff`; no `--aborted` marker,
so a later reconcile reports the run finished instead of reopening it) naming
the tool, the failure kinds, the count, the turns and one bounded redacted error
line. The engine turns that message into the developer-visible `attention`
line, and every decision is emitted as the `run.fail-fast` runtime envelope
(decision, tool, kinds, counts, turns, whether a re-probe was possible).

Two roles are exempt because their first failing calls are expected evidence,
verified against their own briefs: `env-setup` (its brief requires it to report
what it authored and hand off `blocked` naming the missing server when the
environment tools are unavailable) and `debug` (its brief asks it to read a
failure rather than guess). An orchestrator conversation is not an engine run
and carries no run id, so it is never monitored at all.

### Self-correcting tool failures (efficiency backlog item 12)

`edit` fails on roughly one call in eight — "oldText not found", "not unique",
"edits overlap" — and each failure used to cost the model a full turn plus a
re-read to re-derive text it already had; of the 22 tool errors measured in one
run, nine were the same wrong-root path (a repository-root-relative path while
the package lives one level down) answered by a bare ENOENT.

`agent-host/tool-suggestions.ts` derives the hint **locally**, from the file and
the run's own environment, and appends it to the tool's own error text as a
question. Never a silent substitution: a nearest match can mislead, so the
model sees what it asked for and what was actually there.

- an `edit` failure names the nearest region of the file as `did you mean lines
  N-M of <path>` with a short numbered excerpt (1-based line numbers, the region
  marked `>`), the line numbers a non-unique `oldText` occurs at, or the
  `edits[i]`/`edits[j]` pair that overlaps with the lines each spans. Lines are
  compared after whitespace normalisation, so an indentation-only difference —
  which pi-durable's exact match rejects — is still recognised;
- a path that is not there suggests the nearest existing one: the same relative
  path under each ancestor and each descendant directory of the working
  directory (the wrong-root case), then the closest same-named file. A path that
  is a **directory** says so and lists its first entries;
- `grep` carries the same hint when the searched path is not there (a directory
  is a legitimate search target, so it gets none); `read` adds it for both the
  missing-path and the directory case.

Everything is bounded by the module's exported `TOOL_SUGGESTION_LIMITS`: 20
rendered lines and 2 KB of text, at most 400 directory entries read by the path
search (three levels below the working directory, never into `.git`,
`node_modules`, `dist`, `build`, `.cache` or `.herdr-workflow`), and ten entries
listed for a directory. The text logic (`nearestMatchWindow`, `matchRange`,
`matchingLineNumbers`, `overlappingEditIndexes`, `editFailureHint`,
`nearestExistingPath`, `renderPathSuggestion`) is pure and unit-tested without a
tool or a filesystem; `suggestingCodingTools()` wraps pi-durable's `read` and
`edit` and is installed by the host right after `boundedCodingTools()`, so the
registration selected for each of those names is the suggesting one everywhere a
run selects it.

The tool's error text stays **first** and the original error stays the thrown
error's cause, so the failure kind `classifyToolFailure` records is still the
tool's own (`not-found`/`no-match` keep their exemptions in the fail-fast rule)
and a suggestion cannot turn one failure into another: an unexpected throw while
deriving a hint leaves the original error untouched.

### The orientation budget and the named tool surface (efficiency backlog items 13 and 14)

Measurement: `core.plan` spent 50.7 % of its cost before the first artifact,
and the wiki step 66 %; planners made **no** `grep` call at all (1,621 `bash`
vs 908 `read`), and 38.3 % of a worker's pre-edit calls were exploration. The
protocol document already stated the batching rule — but once per run, at the
top of an ~18 kB prompt, never in the dynamic envelope a follow-up attempt or
round re-sends and never at the point where the tool is chosen.

Three independent mechanisms, no engine behavior change and no new persisted
state:

- **Write early, budget orientation.** `instructions/planning.md` says a
  skeleton of the first artifact is written as soon as `openspec status` names
  its `resolvedOutputPath` and `openspec instructions` returns its template, then
  extended in place — keyed on the resolved path, because `openspec new change`
  creates a directory and no artifact file; the domain-surface paragraph
  budgets orientation against a fallback that is not a read (`openQuestions`),
  restates the dependency-read rule it must not weaken, and `artifacts` is
  documented as the plan's file list. `wiki-openspec.md` and
  `wiki-research.md` each gained a `## Write early` section in their own
  vocabulary, keyed on the target their update-first sequence names (not on the
  search), keeping "the update-first sequence decides the path" untouched.
- **The tool surface travels with the assignment.** `assignment.ts` renders a
  `## Tool surface` section between the identity lines and `## Objective`
  (447 B), so it is part of the dynamic envelope on every round: `read`
  (`offset`/`limit`) and `grep` (with a `path` filter) are the default way to
  inspect code, `bash` is for focused builds, tests, `openspec` and the
  repository's git and handoff commands, `codemode` chains a search → filter →
  summarise pipeline when the run offers it, and independent calls belong in one
  message. `agent-host/tool-surface.ts` owns those sentences (the
  `read`/`grep`/`bash`/`codemode` descriptions build their text from the same
  constants and `assignment.ts` imports the section, so the two surfaces cannot
  drift), and the host resolves the surface once — before installing the tools —
  from the run's global pi settings for `codemode` and from the host mode for
  `grep`: the orchestrator host installs no search extension, so its `read` and
  `bash` descriptions carry the split without the search tool instead of naming
  a tool those runs do not have. The sentence names no editing tool, which keeps
  it true for a read-only run. `DurableHost.toolDescriptionsForTest()` exposes
  the installed descriptions so a test can assert the registration and the
  wording agree.
- **Forwarded scope.** `workflow/runtime/assignment-scope.ts` reads what the
  engine already recorded: the plan artifact's `artifacts` (newest of
  `core.plan:planner` / `fusion.consolidate:consolidator`) becomes the
  implementation assignment's `Plan files:` line, and a verification round gets
  its `Changed files:` line plus the last recorded findings per verifier role as
  an untrusted block. Every read is bounded (40 plan paths, 100 changed files or
  4 KiB of `Changed files:` text with every path gated like a plan path — no
  absolute path, no `..`, no control characters, ≤200 characters, 8 findings per
  role, 200 characters per detail, 4 KiB per findings block, the assignment's own
  512 KiB artifact bound) and every failure — missing,
  unreadable, oversized, digest-mismatched or undecodable — degrades to no
  forwarded line rather than a failed launch. Forwarded text is paths and
  findings only, masked through `redactSecrets`, never file contents or diff
  text, and no change documents are parsed and no worktree is scanned to find
  either list. `effect-runner.ts`'s `stepForwardsChangedFiles` keeps triage's own
  unbounded line exactly as it was. A multi-line forwarded block (findings, prior
  dialogue, research handoff) is rendered as its own blank-line separated section
  in `## Inputs`, so its `##` heading stays a heading instead of becoming a
  bullet.

Measured prompt addition: 447 B per assignment, 846 B in `planning.md`, 485 B in
`wiki-openspec.md` and 487 B in `wiki-research.md` (once per run each), and a net
112 B per request across the four tool descriptions (a 51 B sentence on each of
`read`/`grep`/`bash`, less the 41 B duplicate the `grep` description lost). The
forwarded lists are bounded, so the worst case is a few kilobytes on a first
prompt of ~21 kB, well inside `MAX_ASSIGNMENT_BYTES` (96 KiB). The efficiency
query `explore-tools` reports the per-run exploratory mix by profile
(`bash`/`read`/`grep` calls, bash share, exploratory result bytes and their
median); it is additive and no existing query or CSV column changed.

### Prompt assembly and budgets (slim-agent-prompts)

An agent's first assignment is `assignmentParts` (`src/workflow/assignment.ts`): the pinned `workflow-agent-protocol.md` (hashed whole), the role instruction asset(s) and the envelope. The protocol file is one core block plus marked optional sections (`<!-- protocol-section: <id> -->`, ids owned by `src/workflow/prompt-sections.ts`); each step declares the sections its role needs with the optional `StepBehavior.protocolSections` hook, and a step without the hook gets every section. Guidance lives where it applies: interaction guidance under `Interaction:`, the never-re-ask rule in the prior-dialogue block, the peer-question rule in the peer message. Edits under `agent-definitions/` need `bun run scripts/generate-embedded.ts`.

`bun run scripts/prompt-inventory.ts` prints bytes and tokens (bytes / 4) per protocol section, asset and envelope part for every agent step and role (`--json`, `--print <stepId:role>`, `--system` for the system prompt sections and tool definitions). `test/workflow-prompt-budget.test.ts` fails when a role exceeds its family budget in `PROMPT_BUDGETS` (`src/workflow/prompt-inventory.ts`) or a registered agent step and role has none; the `codemode` section has `CODEMODE_SECTION_BUDGET`, asserted in `test/agent-host-codemode.test.ts`. Growing a brief means raising a budget in the same change, on purpose.

### Developer-question lifecycle (asynchronous)

The tool call is **not** the answer-delivery channel
(make-developer-questions-asynchronous). A question is a durable dialogue
record; `developer_question`/`agent_ask` wait only `AGENT_QUESTION_WAIT_MS`
(the agent grace) and then return the pending record. An agent that receives a
pending record reports a bounded `blocked` handoff, so the workflow parks in
`attention-required` with the question as its visible reason instead of holding
a model turn open until the 24 h durable expiry.

When the answer arrives — from the developer's modal, the orchestrator's
action, or a peer's `workflow answer` — the answer reducers call
`resumeAskerAfterAnswer`, which re-issues only the run that asked (its attempt
bumped) when that run handed off `blocked` for this question and no other run
of its role is active. The answer reaches the new attempt through the
assignment's existing `## Prior dialogue (untrusted context)` section. A
cancelled or expired question does not resume: the parked step waits for the
developer's explicit repair or retry.

An orchestrator-routed question stays the orchestrator's first, but it is also
listed in the developer's `pendingQuestions` and `answerQuestion` accepts the
developer's answer (clearing the routing marker), so an orchestrator session
that is off or idle cannot strand the workflow. A developer abort of a run is
recorded by the host as that run's `blocked` handoff (`--aborted`), so an
interrupted turn parks the workflow rather than leaving a `working` run with no
turn left to finish it. An aborted run is parked only while nobody is working
in it: the host reconciles the run's state with the engine through
`workflow resume-run` right before it delivers the developer's next prompt, and
the `agent.resume` reducer reopens exactly that run (working again, the abort's
own attention entry removed, the workflow back to `active`) with an
`agent.resumed` event. Only an abort is reopenable — the marker is the
capability the abort keeps, which the run's own `blocked` handoff (a real
blocker or a question asker) always clears — so an unrelated message never
clears a park the agent created, and a run that already handed off is reported
(`finished`/`stale`) instead of being reopened. A park recorded before the
abort marker existed is recognized by the abort message the host recorded as
the workflow's own attention, and reopened only for a caller that still holds
the run's launch token (verified against the run's own `run.env`); the token is
bound as the reopened run's capability so its continued turn can hand off.

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
| **domain** (pure) | `workflow/steps/`, `workflow/definitions/`, `workflow/blueprints/`, `workflow/contracts.ts`, `workflow/schema.ts`, `workflow/format.ts`, `workflow/registry.ts`, `workflow/embedded.generated.ts`, `workflow/definitions.ts` | Pure step behavior, definitions, blueprint compilation, contracts, Effect Schema-backed contract decoding (`schema.ts` — declarative; the `Contract<T>` facades delegate here), structural registry validation, and the generated instruction-asset data module. |
| **runtime** | `workflow/runtime/`, `workflow/runtime.ts`, `workflow/effects.ts`, `workflow/effect-runner.ts`, `workflow/push-preflight.ts`, `workflow/secure-fs.ts`, `workflow/paths.ts`, `workflow/assets.ts`, `workflow/assignment.ts`, `workflow/observability.ts`, `workflow/wiki.ts`, `workflow/adapters.ts`, `workflow/credentials.ts`, `workflow/profiles.ts`, `workflow/pi-tools.ts`, `workflow/run-env.ts`, `workflow/project-catalog.ts`, `agent-host/` | Persistence, engine internals, effect execution, and external I/O services (git inspection, wiki data, adapters, credentials, global-pi settings reads, the run environment file, configured-project catalog reads, the durable agent host). |
| **application** | `workflow/startup.ts`, `workflow/operations.ts`, `workflow/application.ts` | Shared orchestration both the CLI and the dashboard compose: startup/validation routing, the in-process engine factory, effect draining, configured-project listing (`operations.ts`, backed by the runtime catalog client), and the named application composition root (`application.ts` — the single place the production `applicationLayer` is composed and Effect programs run, complete-workflow-effect-cutover task 1). |
| **cli** | `workflow/cli/`, `workflow/cli.ts` | Command parsing, dispatch (`run.ts`), command modules, and git/registry/pane helpers. |
| **tui-feature** | `tui/dash/`, `tui/otel/`, `tui/settings/`, `tui/orchestrator/` | Dashboard, observability, settings and Home Orchestrator feature implementations (the Settings surface is a Home destination: section views, inventory and its own section keys). |
| **tui-shared** | `tui/shared/`, `tui/themes/`, `tui/clipboard.ts`, `tui/lifecycle.ts` | Shared presentation primitives and theme data. |
| **tui-app** | remaining `tui/` files | TUI shell entrypoint (`index.tsx`) and lifecycle components. |
| **root** | `cli.ts`, `worktree/`, `server-command.ts`, `server/` | Composition roots and foundational clients. `server/` is the unified Bun backend transport/client/build root (`expose-unified-bun-backend`): `protocol.ts` (contracts + route manifest), `auth.ts`, `app.ts`, `client.ts`, `events.ts`, `credentials.ts`, `handlers.ts`, `lifecycle.ts`, and `evidence/` (the evidence store and its routes, `add-workflow-evidence-store`). See [`docs/unified-backend-api.md`](unified-backend-api.md). |

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
- The `stage.replay` step behavior (`add-stage-flow-replay`) first read the
  stage-blocks flow registry, the evidence store, and the filesystem directly
  to decide replay eligibility and to load a finished replay's result/report/
  heal JSON. Both reads moved to the runtime layer:
  `runtime/stage-replay-eligibility.ts` (called from `runtime/store.ts`'s
  `actions()`, which already builds the developer-action view) and
  `runtime/stage-replay-evidence.ts` (called from
  `runtime/reducers/agent-handoff.ts`, which already builds the stage
  journal/evidence-id facts `stage.execute`'s own handoff validation needs).
  `steps/stage-test.ts` now only consumes the already-decoded
  `stageReplayEligible` boolean and `stageReplayEvidence` object those callers
  pass through `DeveloperActionsContext`/`AgentCompletionContext` — the same
  shape the pre-existing `stageJournal`/`stageEvidenceIds` facts already used.

### Stage-test definition tiers

`stage-test` is registered twice from one graph module: the plan-only tier
(`definitionVersionForStageTest`, `rounds + 1001`) and the authored-blocks tier
(`definitionVersionForStageBlocks`, `rounds + 1100`). The second differs only
by the `stage.blocks.promote` edge effect on `stage.review → approve` and
`→ approve-and-update-wiki`. A new tier rather than an edit, because a
registered version's digest covers the whole manifest and a pinned workflow has
to keep resolving the graph it was started under; new starts resolve the
authored-blocks tier. The handler (`effect-runner.ts`) revalidates the run's
drafts against the report's claims, writes the approved documents atomically,
rolls back on failure and removes the drafts only after every write landed.

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
`runtime/store.ts` (`validateEffect`),
and `runtime/kernel.ts` (`createRun`) rather than directly in `runtime.ts`.

Stage D also resolved two live divergences between the engine's action list
and the dashboard's own (now-deleted) copy: a completed `wiki-comments`
workflow no longer offers `create-pr` (the engine never reported it as
available), and the dashboard's undispatchable `close-clean` menu item is
removed outright — it duplicated `workspace.cleanup`, which the engine
already enqueues automatically after every `workspace.close` completes, so
there was no missing capability to add.
