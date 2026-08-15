# agentic-coding-consolidation Specification

## Purpose
TBD - created by archiving change architecture-checkup-round-1. Update Purpose after archive.

## Requirements

### Requirement: Target architecture — single `agentic-coding` binary
The catalog SHALL define one TypeScript `agentic-coding` binary providing transactional workflow engine and dashboard/observability views, with dashboard importing engine in-process and managed agents using runtime-neutral handoff command.

#### Scenario: Reader reviews target surface map
- **WHEN** developer opens target architecture
- **THEN** it SHALL enumerate engine `agentic-coding workflow`, per-workflow dashboard `agentic-coding dash`, workflow list `agentic-coding home`, and launcher `agentic-coding manager`
- **AND** dashboard SHALL import engine rather than spawn/reparse it

#### Scenario: Engine verbs enumerated
- **WHEN** developer reviews engine surface
- **THEN** catalog SHALL list `start`, `status`, `action`, `handoff`, `repair`, `projects`, `config`, and `agent-extension`
- **AND** it SHALL identify old phase/role verbs as intentionally removed

### Requirement: CLI compatibility constraint
The target architecture SHALL permit breaking legacy agent-facing workflow CLI so agents cannot select phase-specific transitions, while requiring all repository call sites to migrate atomically to generic handoff/action contracts.

#### Scenario: Migration keeps agents working
- **WHEN** new engine lands
- **THEN** prompts, instruction assets, dashboard, manager, scripts, README, and tests SHALL use new commands
- **AND** no compatibility shim SHALL translate removed role/phase verbs

#### Scenario: Agent interaction remains runtime-neutral
- **WHEN** Pi, OpenCode, or OpenCode V2 completes assignment
- **THEN** each SHALL use same generic handoff shape
- **AND** engine SHALL derive identity from run capability

### Requirement: Ranked migration backlog
The catalog SHALL reflect workflow-state redesign as replacement for earlier parity-focused consolidation constraints and SHALL keep remaining architecture findings independently actionable.

#### Scenario: Reader reviews the backlog table
- **WHEN** reader reviews consolidation target
- **THEN** R1 SHALL require single binary, in-process dashboard, unified command runtime, typed view, and runtime-neutral agent handoff
- **AND** it SHALL no longer require exact Python-era verb or raw state compatibility

#### Scenario: Each item is independently actionable
- **WHEN** later change selects remaining backlog item
- **THEN** catalog SHALL retain evidence and target invariant sufficient to implement independently
- **AND** no item SHALL require restoring removed legacy workflow compatibility

### Requirement: Contract-drift evidence (R1)
The catalog SHALL identify duplicated phase/state/action/role rules as evidence for registry-driven workflow view and command runtime.

#### Scenario: Phase-list divergence recorded
- **WHEN** developer reads R1 evidence
- **THEN** target invariant SHALL be one registered definition source for steps/transitions/actions, one validated state schema, and one typed dashboard view
- **AND** prompts/adapters SHALL not carry independent transition rules

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
