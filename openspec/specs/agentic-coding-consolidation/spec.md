# agentic-coding-consolidation Specification

## Purpose
TBD - created by archiving change architecture-checkup-round-1. Update Purpose after archive.
## Requirements
### Requirement: Target architecture — single `agentic-coding` binary
The catalog SHALL define one TypeScript umbrella binary, `agentic-coding`, that provides the workflow engine and the dashboard terminal views, with the Python engine retired and `otel-tui` remaining a separate binary.

#### Scenario: Reader reviews target surface map
- **WHEN** a developer opens the catalog's target-architecture section
- **THEN** it SHALL enumerate these surfaces of the `agentic-coding` binary:
  | Surface | Invocation | Replaces |
  |---------|-----------|----------|
  | Engine | `agentic-coding workflow <verb>` | `pi/bin/herdr-workflow` + `pi/lib/herdr_workflow/` (Python) |
  | Per-workflow dashboard | `agentic-coding dash --repo … --change …` | `agent-dash --repo … --change …` |
  | Workflow list | `agentic-coding home` | `agent-dash --home` |
  | Launcher | `agentic-coding manager` | `pi/bin/herdr-manager` |
- **AND** it SHALL state that `otel-tui` remains a standalone binary (not a subcommand)
- **AND** it SHALL state that the dashboard imports the engine in-process rather than spawning it and reparsing JSON

#### Scenario: Engine verbs enumerated
- **WHEN** a developer reviews the ported engine surface
- **THEN** the catalog SHALL list the preserved verbs: `start`, `planner`, `apply`, `verify`, `dispatch-verifiers`, `verification-result`, `finish-review`, `archive`, `close`, `phase`, `override-phase`, `preflight-archive`, `set-return`, `message`, `status`, `projects`, `config`, and `plugin`

### Requirement: CLI compatibility constraint
The catalog SHALL record that any migration preserves the exact agent-facing `herdr-workflow` CLI surface, because agent skills, prompts, and the `PLAN_REJECTED` loop invoke it literally.

#### Scenario: Migration keeps agents working
- **WHEN** a developer plans the consolidation
- **THEN** the catalog SHALL require a thin `herdr-workflow` executable that forwards `argv` to `agentic-coding workflow`
- **AND** it SHALL state that `herdr-workflow verify --repo . --change <id>`, `dispatch-verifiers`, `verification-result`, and `phase proposed` continue to work unchanged
- **AND** it SHALL name mass-renaming call sites up front as the rejected alternative

### Requirement: Ranked migration backlog
The catalog SHALL enumerate findings R1–R8, each with a severity tier, an effort estimate, concrete source evidence, and a target-state invariant.

#### Scenario: Reader reviews the backlog table
- **WHEN** a developer opens the backlog
- **THEN** it SHALL list these items with tier (High/Med/Low) and effort (S <1d / M 1–3d / L ~1w / XL >1w):
  | # | Tier | Effort | Item |
  |---|------|--------|------|
  | R1 | High | XL | Consolidate engine + dashboard into one TS `agentic-coding` binary; retire Python; in-process engine; `herdr-workflow` shim; `otel-tui` separate |
  | R2 | High | L | Decompose `commands.py` god module (orchestration / git-ssh / layout / tracing / plugins) |
  | R3 | High | M | Keep terminal-layout state out of durable workflow state |
  | R4 | Med | M | Single Herdr CLI client module (one `.result` parser + shared geometry) |
  | R5 | Med | M | Event/watch-based dashboard refresh instead of 5s re-spawn poll |
  | R6 | Low | S | Dedupe otel trace-view code shared between dashboard and `otel-tui` |
  | R7 | Low | S | Fix agent-name mismatch (herdr 32-char truncation vs pi `--name`) |
  | R8 | Low | S | Remove legacy dead paths (`startWorkflowWizard`, `pi_command`) |

#### Scenario: Each item is independently actionable
- **WHEN** a later round selects a backlog item
- **THEN** the catalog entry SHALL provide its evidence location and a target-state invariant precise enough to implement and verify without re-deriving the analysis

### Requirement: Contract-drift evidence (R1)
The catalog SHALL document the concrete drift between the Python engine and the TypeScript dashboard that consolidation removes.

#### Scenario: Phase-list divergence recorded
- **WHEN** a developer reads the R1 evidence
- **THEN** it SHALL note that `transitions.py` `OPERATIONAL_PHASES` orders `…developer-review, committing, archive, completed` while `data.ts` `operationalPhases` orders `…developer-review, archive, committing, completed`
- **AND** it SHALL note that the TS `WorkflowState` interface omits `tabs`, `workflowType`, `developerApproval`, `otelTraceRoot*`, and the verification-layout fields the engine writes
- **AND** the target-state invariant SHALL be a single source of truth for the phase enum, state shape, and phase→action map

### Requirement: God-module decomposition (R2)
The catalog SHALL document that `commands.py` mixes unrelated concerns and SHALL define the target module split.

#### Scenario: Decomposition target recorded
- **WHEN** a developer reads the R2 entry
- **THEN** it SHALL note `commands.py` is ~1298 lines spanning phase orchestration, git/ssh helpers, terminal BSP pane-layout geometry, tracing/telemetry, and plugin management
- **AND** the target-state invariant SHALL be that these concerns live in separate modules after the port

### Requirement: Layout state is not workflow state (R3)
The catalog SHALL document that terminal-geometry fields are persisted in durable workflow state and SHALL require their removal.

#### Scenario: Leaked layout fields recorded
- **WHEN** a developer reads the R3 entry
- **THEN** it SHALL name `verificationSecondRowPane`, `verificationSecondRowRole`, and `verificationPaneOrder` as terminal-layout fields written into `state.json`
- **AND** the target-state invariant SHALL be that `state.json` carries only workflow-meaningful fields and pane layout is reconstructed from live Herdr queries or a non-durable layout store

### Requirement: Duplicated Herdr client and poll model (R4, R5)
The catalog SHALL document the duplicated Herdr CLI access and the re-spawning poll refresh, with their consolidation targets.

#### Scenario: Duplication and poll recorded
- **WHEN** a developer reads the R4 and R5 entries
- **THEN** R4 SHALL note the `.result` envelope is parsed independently in `effects.py`, in `data.ts` (multiple call sites), and in the extension, and that pane geometry is computed in both `launch_role` and `focusAgent`
- **AND** R5 SHALL note the dashboard polls every 5 seconds, re-spawning `herdr agent list`, `herdr workspace list`, and `git` per cycle, despite watchable `telemetry.jsonl` / `traces.jsonl`
- **AND** the target-state invariants SHALL be one shared Herdr client module (R4) and an event/watch-driven refresh (R5)

### Requirement: Otel viewer duplication and small cleanups (R6, R7, R8)
The catalog SHALL document the duplicated otel viewer code and the remaining low-severity cleanups.

#### Scenario: Low-severity items recorded
- **WHEN** a developer reads the R6–R8 entries
- **THEN** R6 SHALL name the trace-view modules duplicated between `agent-dash` and the standalone `otel-tui` project: `otel-tui.tsx`, `TraceBrowser`, `traces.ts`, `receiver`
- **AND** R7 SHALL note the agent-name mismatch: Herdr agent name is truncated to 32 chars (`role_agent_name`) while pi `--name` uses the untruncated `{change}-{role}`
- **AND** R8 SHALL name the legacy dead paths `startWorkflowWizard` and `pi_command` for removal

