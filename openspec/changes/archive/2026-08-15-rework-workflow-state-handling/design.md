## Context

See `proposal.md` for motivation. Current engine has one untyped state JSON per change, dual writable SQLite copies, descriptive module metadata that does not own orchestration, command-local phase guards, and side effects interleaved with state saves. Agent launch, skills, prompts, completion commands, telemetry, dashboard actions, and tests each encode portions of lifecycle. Pi is hardcoded in launch and deep telemetry.

Constraints:

- Herdr remains terminal/workspace host. Managed agents must start through `herdr agent start`, be confirmed with `herdr agent get`, and receive prompts through `herdr agent prompt`; no raw startup, text insertion, or Enter-key coordination.
- One compiled TypeScript `agentic-coding` binary remains engine and TUI.
- Standard, direct-apply, and no-OpenSpec workflows must remain available, but legacy CLI/state compatibility is intentionally not retained.
- Existing valid active rows must migrate automatically; ambiguous or malformed data must fail closed.
- OpenCode V2 is beta, installed separately as official `opencode2`, and Herdr currently detects that process as OpenCode but starts canonical executable `opencode` for kind `opencode`.
- Runtime workflow plugin loading is deferred. Registry must nevertheless be usable unchanged by a later trusted loader.

## Goals / Non-Goals

**Goals:**

- Make workflow definition flexible at registration time and strictly validated/immutable at runtime.
- Make every lifecycle mutation schema-checked, authorized, transactional, revisioned, auditable, and recoverable after process/effect failure.
- Give agents one product-independent assignment and handoff protocol; agents never select lifecycle transitions.
- Route each step/role to a pinned Pi, OpenCode, or OpenCode V2 profile and optionally enforce implementation/review runtime diversity.
- Provide baseline telemetry for every adapter and normalized deep telemetry where runtime hooks exist.
- Migrate all built-in workflows, dashboard interactions, assets, scripts, and tests to same contracts.

**Non-Goals:**

- Loading third-party workflow plugins in this change.
- Sandboxing untrusted JavaScript workflow plugins; later in-process plugins are trusted code unless separate process/WASM design is added.
- Installing Pi, OpenCode, OpenCode V2, Herdr integrations, providers, or credentials automatically.
- Guaranteeing identical model/tool telemetry fields from runtimes that expose different hooks.
- Preserving removed role/phase CLI verbs, raw status JSON, Pi workflow skills, or writable state mirrors.

## Decisions

### 1. Registry owns lifecycle

Create registry independent from command/effect modules:

```ts
interface StepDefinition<Input, Output> {
  id: string;
  version: number;
  actor: "agent" | "developer" | "system";
  instructionAssets?: string[];
  requirements: AdapterCapability[];
  input: Contract<Input>;
  output: Contract<Output>;
  outcomes: readonly string[];
  retryLimit?: number;
  allowedEffects: readonly EffectKind[];
  enter(snapshot: WorkflowSnapshot): Reduction;
  reduce(snapshot: WorkflowSnapshot, command: StepCommand<Output>): Reduction;
}

interface WorkflowDefinition {
  id: string;
  version: number;
  initial: string;
  terminal: readonly string[];
  steps: readonly string[];
  edges: readonly WorkflowEdge[];
}
```

`Contract<T>` exposes a stable schema ID/version plus `parse(unknown)` returning typed value or bounded field errors. Existing manual report validation pattern is reused; no schema dependency is added. Registry compiler checks unique IDs, references, actor/effect registrations, reachability, terminal paths, declared cycles, retry bounds, and adapter requirements. Definitions are frozen after registration.

Built-ins use namespaced stable IDs such as `core.plan`, `core.plan-approval`, `core.implementation`, `core.triage`, `core.verification`, `core.developer-review`, `core.archive`, `core.delivery`, `core.completed`, and `core.closed`. Fix rounds are new `core.implementation` runs with mode/input, not a second mutable phase implementation.

Workflow stores definition `{id, version, digest}`. Digest covers serializable graph manifest, step contract versions, effect IDs, and instruction asset hashes. Binary keeps every supported built-in version registered. Missing exact definition blocks workflow until restored or migrated.

Why not retain module array: current array only describes some transitions; commands still own real behavior. Explicit graph makes addition one registered step plus explicit composition, while no plugin can silently insert itself.

Why no automatic plugin scanning: registration code is arbitrary trusted code and discovery order creates non-deterministic graphs. Later loader will explicitly allowlist exact package/version/digest, then call same registry API before workflow creation.

### 2. One command dispatcher and pure reductions

All mutation callers use one discriminated command union:

```ts
type WorkflowCommand =
  | { type: "developer.action"; workflowId: string; revision: number; actionId: string; input?: unknown }
  | { type: "agent.handoff"; runId: string; generation: number; token: string; outcome: "complete" | "blocked" | "failed"; artifact?: string; message?: string }
  | { type: "effect.result"; effectId: string; lease: string; outcome: "complete" | "retry" | "failed"; data?: unknown }
  | { type: "operator.repair"; workflowId: string; revision: number; targetStep: string; reason: string }
  | { type: "operator.resume"; workflowId: string; revision: number };
```

Dispatcher sequence:

1. Parse command and locate canonical workflow.
2. Open `BEGIN IMMEDIATE`.
3. Load and validate current snapshot/definition.
4. Authorize developer revision, run generation/capability, or effect lease.
5. Resolve current registered reducer and parse input/artifact.
6. Produce reduction containing next snapshot, audit data, and effect intents.
7. Validate next snapshot and every effect against definition.
8. Increment revision and atomically write snapshot, event, runs, and outbox.
9. Commit, then ask effect runner to drain ready work.

Developer/operator actions use optimistic revision. Agent handoffs intentionally do not require current global revision: parallel verifier capabilities bind to one active `runId` and `generation`, so distinct runs can commit serially across revisions. Consuming one run cannot overwrite results from another; duplicate capability fails.

Reducers are synchronous and effect-free. Filesystem/OpenSpec/Git guards that need observations execute through read-only validation ports before reduction; observation digest is included in command/event so reducer result is reproducible and transaction rechecks relevant identity before commit.

Why not event sourcing: current needs audit and recovery, not arbitrary historical replay. Validated snapshot remains authority; append-only events explain each revision. This is less code than reconstructing every state from external-effect history.

### 3. Canonical SQLite schema

Resolve canonical repository from checkout with Git common directory and store only at `<repository>/.herdr-workflow/herdr.db`. Artifacts remain under workflow worktree `.herdr-workflow/<change>/`.

Tables:

```text
workflow_instances(id, change_id, repository, worktree, definition_id,
  definition_version, definition_digest, revision, status, current_step,
  snapshot_json, created_at, updated_at)
workflow_runs(id, workflow_id, step_id, role, generation, attempt, status,
  profile_json, capability_hash, assignment_path, output_path, output_digest,
  handle_json, created_at, completed_at)
workflow_events(workflow_id, revision, type, actor_json, data_json, at)
workflow_outbox(id, workflow_id, revision, kind, idempotency_key, payload_json,
  status, attempts, lease, lease_expires_at, next_attempt_at, last_error)
```

Foreign keys, unique `(workflow_id, revision)` events, unique run IDs, and unique outbox idempotency keys add SQLite constraints. Snapshot remains JSON for step-specific state, but parser validates it on every read/write. Terminal handles may live on run rows for reconciliation; pane geometry and observed status never decide workflow completion.

No mirror writes. Dashboard, source checkout, and linked worktree resolve same DB. Discovery stops scanning per-worktree databases as authorities.

### 4. Durable outbox owns all external effects

Reducers request named effects only: workspace/branch setup, assignment artifact write, agent launch/prompt/stop, notification, OpenSpec/Git validation, delivery commit/push, PR, workspace close, and cleanup. Each intent receives stable ID/idempotency key.

Runner claims work with expiring SQLite lease. On success/failure it submits internal `effect.result`; dispatcher atomically updates outbox and snapshot/event. If process dies after external success but before result, handler retries same key and first observes whether target already exists/completed. Agent names include run identity; prompt includes assignment digest; delivery records expected tree/head and checks remote before commit/push; file writes use temp+rename and digest.

Ready effects drain after commands and in dashboard background loop. A later CLI call also drains abandoned ready/expired leases, so correctness does not require dashboard to remain open. Unsafe/terminal failures set attention-required and expose diagnostic/action; they never imply success.

Why not state-after-effect: process can die after effect and before save. Outbox makes desired external work durable first.

### 5. Snapshot and run model

`WorkflowSnapshot` has schema version, revision, definition pin, status (`active`, `paused`, `attention-required`, `completed`, `closed`), current step ID, step attempt data, durable domain metadata, evidence digests, and run IDs. Parallel verification is explicit active run set in `core.verification`; each role has independent run row/capability/result. Adapter observations are joined into read view, never stored as completion evidence.

A run capability is random 256-bit token. DB stores SHA-256 hash; plaintext exists only in run launch environment. Scope includes workflow, run, generation, actor, allowed outcomes, output path/schema, issued revision, and expiry. Compare hash timing-safely. Token consumes only in same transaction that accepts validated output. Repair increments/invalidates run generations and capabilities.

Agent output path is engine-declared (`$HERDR_OUTPUT`) under workflow artifact directory and includes run identity/schema version. Handoff accepts omitted artifact when step has no output, otherwise only exact assigned path. Engine enforces bounded size, regular-file/non-symlink containment, parser, run identity, and digest before reducer sees output.

### 6. Built-in workflow definitions

`standard`:

```text
plan(agent planner)
→ plan-approval(developer)
→ implementation(agent worker)
→ triage(agent)
→ verification(parallel selected verifiers, then test verifier)
↘ critical: implementation(mode=fix) → triage → verification
→ developer-review(developer)
↘ comments: implementation(mode=review-fix) → triage → verification
→ archive(agent)
→ delivery(system effects)
→ completed
```

Planning completion validates required proposal/design/tasks/specs and `openspec validate --strict` before approval action. Implementation completion validates base freshness, complete task checklist for OpenSpec workflows, and declared output. Triage validates changed-file-bound role plan. Verification derives verdict from findings schema, records each run once, starts test verifier automatically after selected passes, and advances/fixes automatically when required set completes. Test verifier never coordinates. Developer review reducer handles approval/comments. Archive validates expected OpenSpec move. Delivery system effect owns stage/commit/push idempotently.

`direct-apply` starts only after pre-authored OpenSpec artifacts pass same planning-output validation, then enters implementation; remainder equals standard.

`no-openspec` requires non-empty task, starts implementation, excludes OpenSpec verifier/checklist/archive, and links developer approval directly to delivery.

Closed is terminal action after completed and optional PR actions. UI actions come from current step definition/reducer, not static map.

### 7. Safe repair replaces override/recovery agent

Repair preview is pure against validated snapshot/definition and returns compatible target steps plus retained/expired evidence. Execute requires current revision, compatible target, confirmation, and non-empty reason. Transaction expires incompatible runs and pending effects, rebuilds target state through target repair constructor, validates whole snapshot, records audit, and leaves status `paused`. It may enqueue idempotent stop/reconcile effects for stale agent handles but never launch successor. Separate engine-provided resume action reruns entry/artifact/routing/capability checks and enters normal flow.

No recovery agent proposes state mutation. Unknown/terminal target, stale revision, invalid retained evidence, or missing definition fails before write.

### 8. Runtime-neutral assignment instead of skills

Move managed assets to `agent-definitions/instructions/` (or rename directory to `agent-assets/` during implementation):

```text
workflow-agent-protocol.md
planning.md
implementation.md
triage.md
verification-security.md
verification-quality.md
verification-performance.md
verification-openspec.md
verification-usability.md
verification-test.md
archive.md
```

These are plain trusted Markdown, not `SKILL.md`, and not placed in runtime discovery. Prompt renderer concatenates:

1. Common protocol.
2. Step instruction fragments from pinned definition.
3. Validated assignment section: protocol/run/step/role, objective, interaction mode, input artifacts, permissions/checks, exact output contract, allowed outcomes, generic handoff examples.

Prompt has bounded bytes and asset digest. Every reused session gets full current assignment. Runtime starts without workflow skills or `/skill:` invocation. Pi uses `--no-prompt-templates` and no `--skill`; restricted profile may also disable runtime skill/tool access as policy. OpenCode profiles receive isolated permission/config, not workflow skills.

Only agent lifecycle command in prompt is:

```bash
agentic-coding workflow handoff --outcome complete --artifact "$HERDR_OUTPUT"
agentic-coding workflow handoff --outcome blocked --message "..."
agentic-coding workflow handoff --outcome failed --message "..."
```

Workflow/run/token/generation/output come from environment. Blocked outcome routes via step policy (planner, developer, or retry) rather than agent-selected recipient.

### 9. Agent adapters and profile routing

Adapter seam:

```ts
interface AgentAdapter {
  readonly id: "pi" | "opencode" | "opencode-v2" | string;
  readonly capabilities: ReadonlySet<AdapterCapability>;
  preflight(profile: ResolvedProfile, requirements: AdapterCapability[]): Result;
  launch(ctx: LaunchContext): Promise<AgentHandle>;
  prompt(handle: AgentHandle, message: string): Promise<void>;
  observe(handle: AgentHandle): Promise<AgentObservation>;
  stop(handle: AgentHandle): Promise<void>;
}
```

Adapters only transport assignment/lifecycle and emit observations. They do not read workflow snapshot or choose successors.

Configuration:

```toml
[agents]
default_profile = "pi-default"

[agents.profiles.pi-default]
runtime = "pi"
model = "provider/model"
thinking = "high"

[agents.profiles.oc-review]
runtime = "opencode"
model = "provider/model"
agent = "build"

[agents.profiles.oc2-review]
runtime = "opencode-v2"
model = "provider/model"
agent = "build"
variant = "high"

[agents.routes]
"core.plan" = "pi-default"
"core.implementation" = "oc-review"
"core.verification" = "oc2-review"
"core.archive" = "pi-default"

[agents.role-routes."core.verification"]
security-verifier = "oc-review"

[[agents.runtime-diversity]]
steps = ["core.implementation", "core.verification"]
```

Resolution precedence: exact step/role, step, definition default, global default. At start, resolve all reachable agent actors and known roles; pin non-secret resolved values/profile digests. Credentials remain environment/runtime stores, never snapshot. Active workflow ignores later config edits until validated routing repair/migration. No implicit model/runtime fallback.

Each step declares capabilities such as interactive Herdr lifecycle, prompt transport, persistent session, shell/read/edit policy, read-only enforcement, runtime bridge, and run environment. Routing preflight rejects weaker adapter instead of launching. Optional diversity compares runtime IDs after role overrides and fails workflow start with route names.

### 10. Pi, OpenCode, and OpenCode V2 launch

Shared launch utility creates required topology and environment, waits for shell, invokes `herdr agent start`, retries once only for unavailable shell, confirms with `agent get`, then sends complete message with `agent prompt`.

- Pi adapter uses `--kind pi`, profile model/thinking/tool policy, no workflow skill flags, and explicitly injected Pi telemetry bridge.
- OpenCode adapter uses `--kind opencode`, stable `opencode`, isolated run config/permissions, profile model/agent options, and OpenCode telemetry bridge.
- OpenCode V2 adapter requires `opencode2`. Because Herdr detects `opencode2` as OpenCode but starts canonical `opencode`, adapter creates workflow-scoped engine-generated `runtime-bin/opencode` launcher pointing to preflight-resolved absolute `opencode2`, validates launcher digest before each launch, and prepends that directory only to V2 tab PATH. It still calls `herdr agent start --kind opencode`; no raw pane startup and no global executable replacement.

OpenCode V2 adapter owns beta-specific config/flag translation. Contract tests use fake Herdr. Opt-in live smoke checks exact installed runtimes, detection, prompt, handoff, status, and telemetry. Missing executable/profile integration gives preflight error; install scripts do not install beta.

### 11. Telemetry layering

Three layers share normalized envelope keyed by workflow/run/step/role/profile/runtime:

1. Engine: command, validation, revision, event, effect, repair, migration.
2. Adapter: preflight, launch, prompt, observe, stop, duration/error.
3. Runtime bridge: model/provider/tool/compaction/content usage when hooks expose it.

Refactor current Pi extension into Pi bridge plus shared pure encoder. Add OpenCode V1 and V2 thin plugin bridges against each runtime hook API. Bridges receive trace/run environment, emit local `telemetry.jsonl`/`traces.jsonl` and best-effort OTLP, and never read DB/state files. They cannot nudge, retry, detect workflow completion, switch provider/model, or issue lifecycle commands. Adapter baseline remains when bridge unavailable; unsupported deep fields are absent.

W3C trace context flows command → effect → assignment → runtime operation → handoff → successor effect. One-use trace handoff remains workflow artifact but bound to run/message. Content capture remains opt-in/bounded and never exported by default.

### 12. Clean CLI and typed workflow view

CLI surface:

```text
start --repo --change --mode [--workflow] [--task] [--ticket]
status --repo --change
action <action-id> --repo --change --revision [--input <json-or-path>]
handoff --outcome <complete|blocked|failed> [--artifact] [--message]
repair --repo --change --revision --step --reason
projects
config
agent-extension list|install|install-local
```

No shim translates removed verbs. Dashboard imports dispatcher/view in-process. `status` returns read model, not snapshot. View includes revision/definition/current step, run statuses and runtime profiles, effect/validation attention, observations, and available actions with IDs, labels, input contract, confirmation level. Shared engine types replace duplicate dashboard phase/state/action maps.

PR, close/clean, approvals, review comments, resume, and delivery retries are action IDs returned only when legal. Dashboard sends displayed revision and refreshes on conflict.

### 13. Legacy migration

Schema migration adds new tables without deleting old `workflows` rows or legacy files. On first access:

1. Resolve canonical repository and collect repository/worktree legacy rows/files.
2. Parse known legacy schema and compare copies after excluding explicitly transient layout fields.
3. If equivalent, map workflow type and phase: `explore→plan`, `proposed→plan-approval`, `apply/fix→implementation`, `triage→triage`, `verify→verification`, `developer-review→developer-review`, `archive→archive`, `committing→delivery`, terminal phases accordingly; paused retains mapped target with paused status.
4. Validate/import plan, task, verification, findings, approval, branch, and artifact evidence only when shape/path/digest is valid.
5. Pin matching built-in definition and resolve profiles (legacy model fields become generated Pi profile when unambiguous).
6. Expire legacy agent ownership; mapped active agent step gets fresh run/assignment effect after migration. Existing old agent cannot use new capability.
7. Commit revision 1 plus migration event in canonical DB.

Conflicting mirrors, unknown workflow type/phase, missing required evidence, or malformed row produces diagnostic repair-required view and preserves all sources. It never picks latest timestamp or overwrites evidence. Discovery ignores worktree DB after successful canonical migration.

### 14. Testing strategy

- Pure: contracts, graph compiler, route precedence/diversity, reducers for every outcome, repair planner, state invariant parser, idempotency decisions.
- Store: transactions, CAS developer actions, concurrent parallel handoffs, token consumption, mirror migration/conflict, malformed rows, outbox leases/restart.
- Effects: failure before/after external completion, agent launch/prompt idempotency, delivery commit/push resume.
- Adapter contract: identical assignment semantics for Pi/OpenCode/OpenCode V2; runtime-specific args/config/executable; capability/missing binary failures.
- Workflow end-to-end: all built-ins, fail/fix/review loops, zero verifier, test verifier, max attempts, archive/no archive, PR/close actions.
- Dashboard: generated actions, stale revision refresh, unknown registered step rendering, repair preview/confirm.
- Assets/telemetry: no skill flags/invocations, prompt digest/size, runtime bridge normalization, bridge failure isolation.
- Opt-in live smoke for installed runtimes; CI fake tests never install runtimes or require credentials.

## Risks / Trade-offs

- [Large breaking rewrite] → Land registry/store/dispatcher behind tests first, migrate all call sites in same change, and reject old verbs so split behavior cannot survive unnoticed.
- [OpenCode V2 beta flags/plugins change] → Isolate in adapter/bridge, preflight version/capabilities, keep fake contract plus opt-in live smoke, and fail closed without switching runtime.
- [Herdr canonical OpenCode executable differs from `opencode2`] → Use workflow-scoped validated PATH launcher only for V2 while still using `agent start --kind opencode`; never replace global binary.
- [External effect succeeds before crash] → Stable idempotency keys and observe-before-retry handlers; attention-required when completion cannot be proven.
- [Legacy mirrors diverged] → Preserve data and require repair; never choose based on timestamp.
- [Definition upgrade strands active workflow] → Pin digest and keep supported definition versions; require explicit migration when old version removed.
- [Capability token visible to same-user process] → Threat model prevents accidental/cross-run agent authority, not hostile local OS user; use random single-use scoped token, hash at rest, short expiry, run-generation invalidation.
- [Runtime permission models differ] → Steps declare capabilities and preflight rejects weaker adapter; no best-effort downgrade for restricted verification.
- [Deep telemetry differs by runtime] → Guarantee engine/adapter baseline; normalize available runtime hooks and omit unsupported data.
- [Future plugin code is trusted] → No loader now; later allowlist exact package/version/digest and preserve explicit workflow composition.

## Migration Plan

1. Add registry/contracts, versioned built-in definitions, typed snapshot/view, canonical schema, command dispatcher, and outbox with isolated tests while legacy engine remains test fixture only.
2. Add instruction renderer, generic handoff, capability/run artifact contracts, profile config/routing, adapter interface, and Pi/OpenCode/OpenCode V2 adapters/telemetry bridges.
3. Implement built-in step reducers/validators/effects and drive all three workflow definitions through end-to-end tests.
4. Replace dashboard state/action model, repair flow, configuration UI/docs, manager paths, scripts, and asset embedding; remove workflow skill loading and legacy command call sites.
5. Enable first-access migration, preserve legacy tables/files, and add conflict/repair diagnostics.
6. Remove legacy CLI handlers/shim assumptions and run strict OpenSpec validation, full Bun suite, shell smoke tests, build, and opt-in installed-runtime smoke tests.

Rollback before migration/effects is binary revert. Migration preserves legacy rows/files, but once new commands produce new revisions/effects old engine must not resume stale legacy state; rollback requires restoring repository/worktree from recorded pre-migration backup or completing explicit reverse/export procedure. Installer/documentation SHALL warn rather than silently start old engine against migrated active workflow.
