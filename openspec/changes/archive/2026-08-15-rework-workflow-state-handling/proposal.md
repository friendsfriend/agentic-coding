## Why

Workflow state is currently an unvalidated JSON blob mutated by phase-specific commands before and after non-transactional agent, Git, and filesystem effects. Duplicated phase rules, writable database mirrors, stale Pi-only telemetry, and command-heavy agent skills let crashes, retries, concurrent results, or instruction drift leave workflows in states that do not describe reality.

## What Changes

- Replace the descriptive phase/module table with a versioned workflow-definition and step registry whose graphs, actors, validators, legal outcomes, retry bounds, instruction assets, and allowed effects are validated before use.
- Route every lifecycle mutation through one typed command dispatcher: authenticate the actor/run, validate current state and input, apply a pure reducer, validate the result, then atomically persist the revision, audit event, and idempotent outbox work.
- Use one canonical repository SQLite store located consistently from main checkouts and linked worktrees; validate state on every read/write and automatically migrate valid legacy rows without maintaining writable mirrors.
- Replace raw phase override with revision-checked, reasoned, audited repair that expires incompatible runs, rebuilds a valid target step, and pauses until explicit resume.
- Introduce runtime-neutral agent adapters and named agent profiles. Route profiles by stable workflow step with optional per-role overrides and an optional guard requiring implementation and verification to use different runtimes.
- Implement Pi, OpenCode, and official OpenCode V2 (`opencode2`) adapters. Missing configured executables fail preflight and are never installed automatically.
- Remove workflow skill loading. Render trusted Markdown protocol and step instruction assets plus a run-bound assignment into the complete prompt sent through the selected adapter.
- Replace role/phase-specific agent commands with one capability-bound `workflow handoff` contract for `complete`, `blocked`, and `failed` outcomes. Agents never choose workflow, role, phase, or successor step.
- Normalize workflow, adapter, and runtime telemetry across Pi, OpenCode, and OpenCode V2; keep runtime bridges observational and prevent telemetry failures from affecting workflow correctness.
- Make dashboard actions data-driven from the engine's typed workflow view instead of hardcoded phase/action maps.
- **BREAKING** Replace the legacy `planner`, `apply`, `verify`, `dispatch-verifiers`, `verification-result`, `finish-review`, `archive`, `git-operations`, `phase`, `override-phase`, `preflight-archive`, `set-return`, `message`, `create-pr`, and `close` verbs with `start`, `status`, `action`, `handoff`, and `repair`; dashboard-only metadata updates remain in-process.
- **BREAKING** Replace raw status state output with a validated workflow view containing revision, pinned definition, current step, active runs, resolved agent routing, health, and available actions.
- **BREAKING** Rename Pi extension management from ambiguous workflow `plugin` terminology to `agent-extension`; runtime workflow-plugin loading remains deferred while built-ins use the future plugin registration contract.
- Migrate standard, direct-apply, and no-OpenSpec workflows, prompts, instruction assets, dashboard flows, scripts, and tests to the new contracts.

## Capabilities

### New Capabilities

- `workflow-definition-registry`: Versioned step/workflow registration, graph validation, definition pinning, and future workflow-plugin seam.
- `workflow-state-runtime`: Typed command processing, validated canonical persistence, atomic events/outbox, idempotent recovery, legacy migration, and safe repair.
- `agent-runtime-routing`: Runtime-neutral adapters, profile routing, Pi/OpenCode/OpenCode V2 support, capability checks, and optional runtime-diversity constraints.
- `workflow-agent-assignment`: Skill-free Markdown prompt assembly, run-bound assignment/output contracts, and unified capability-bound handoff.

### Modified Capabilities

- `workflow-engine-runtime`: Replace legacy phase verbs and raw state contract with the new command/view runtime.
- `herdr-workflow-state-control`: Replace raw phase overwrite with validated revision-bound repair and explicit resume.
- `herdr-workflow-prompting`: Launch and prompt the configured runtime adapter without Pi skill coupling.
- `herdr-agent-telemetry`: Normalize baseline telemetry for every adapter and deep telemetry through runtime-specific bridges.
- `agent-definition-isolation`: Store workflow instruction assets outside agent discovery and inject their rendered content as prompts rather than skills.
- `dashboard-engine-integration`: Consume engine-provided workflow views and available actions in-process.
- `direct-apply-workflow`: Express direct apply as a validated workflow definition using unified step/run contracts.
- `no-openspec-workflow`: Express no-OpenSpec flow as a validated workflow definition without OpenSpec-only steps.
- `openspec-verification`: Replace verifier-specific completion commands with run-bound generic handoff.
- `herdr-workflow-testability`: Test reducers, schemas, migrations, outbox recovery, adapters, and complete workflow definitions instead of frozen legacy phases and CLI.
- `agentic-coding-consolidation`: Remove the obsolete exact legacy CLI/state compatibility constraint from the target architecture.
- `pi-agent-plugin-system`: Separate Pi agent extensions from the reserved workflow-plugin concept and skill loading.

## Impact

- Major rewrite of `agentic-coding/src/workflow/`, its SQLite schema, CLI, dashboard bridge/view model, role launch, prompt generation, telemetry, and workflow tests.
- All managed instruction assets under `agent-definitions/` change from Pi skills to runtime-neutral Markdown; compiled asset generation and runtime bridges change accordingly.
- `README.md`, install/smoke scripts, configuration examples, and OpenSpec contracts require breaking-command migration.
- External prerequisites remain Herdr plus explicitly installed selected runtimes. OpenCode V2 is beta and must be installed separately as `opencode2`; adapter preflight reports absence or incompatible lifecycle support.
- No new runtime dependency and no external workflow-plugin loader are introduced in this change.
