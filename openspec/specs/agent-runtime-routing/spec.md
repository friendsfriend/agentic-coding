# agent-runtime-routing Specification

## Purpose
Routes each workflow run through a pinned, capability-checked agent-runtime profile while supporting Pi, OpenCode, and OpenCode V2 without coupling workflow semantics to any one agent product.
## Requirements
### Requirement: Named agent profiles
Configuration SHALL define named agent profiles containing runtime identifier and runtime-specific model/options, plus default profile.

#### Scenario: Profile is valid
- **WHEN** configuration defines profile for registered runtime with supported options
- **THEN** profile SHALL be available for workflow routing
- **AND** resolved profile SHALL expose normalized runtime and model metadata in workflow view

#### Scenario: Profile is invalid
- **WHEN** profile names unknown runtime or unsupported option
- **THEN** configuration validation SHALL fail before workflow starts
- **AND** engine SHALL identify profile and invalid field

### Requirement: Step and role routing
The system SHALL resolve agent profile using optional exact role override within step, then step route, then workflow/default profile.

#### Scenario: Verification role override exists
- **WHEN** verification step creates run for role with explicit role route
- **THEN** role SHALL use override profile
- **AND** sibling role without override SHALL use verification step profile

#### Scenario: No explicit route exists
- **WHEN** agent step has no role or step route
- **THEN** engine SHALL use definition default or configured default profile
- **AND** resolution SHALL remain deterministic

### Requirement: Routing pinning
Workflow SHALL resolve and pin effective profile routing when created, including runtime, executable identity, model/options, adapter capabilities, and profile digest.

#### Scenario: Configuration changes after start
- **WHEN** profile or route configuration changes while workflow active
- **THEN** existing workflow and active runs SHALL keep pinned routing
- **AND** new configuration SHALL apply only to newly started workflow unless validated repair/migration changes pin

#### Scenario: Run is retried
- **WHEN** failed run retries within same workflow state
- **THEN** retry SHALL use pinned profile unless operator performs validated routing repair
- **AND** engine SHALL NOT silently switch runtime or model

### Requirement: Runtime adapter capability checks
Each agent step SHALL declare required runtime capabilities and routing SHALL fail before launch when selected adapter cannot provide them.

#### Scenario: Restricted verifier route is supported
- **WHEN** verifier step requires read-only policy, interactive prompting, run environment, and lifecycle observation
- **THEN** selected adapter SHALL declare and enforce those capabilities before run starts

#### Scenario: Adapter lacks required capability
- **WHEN** routed adapter cannot enforce step's required interaction or permission capability
- **THEN** workflow start or repaired resume SHALL fail preflight
- **AND** agent SHALL NOT launch with weaker policy

### Requirement: Pi, OpenCode, and OpenCode V2 adapters
The system SHALL provide adapters for Pi, stable OpenCode `opencode`, and official OpenCode V2 beta `opencode2`, all using Herdr-managed agent lifecycle and common assignment/handoff protocol.

#### Scenario: Pi run launches
- **WHEN** run routes to Pi profile and Pi is installed
- **THEN** engine SHALL launch Pi through Herdr agent lifecycle
- **AND** send rendered assignment message through detected agent

#### Scenario: OpenCode run launches
- **WHEN** run routes to stable OpenCode profile and `opencode` is installed
- **THEN** engine SHALL launch Herdr OpenCode agent with profile model/options
- **AND** use same rendered assignment and handoff contracts as Pi

#### Scenario: OpenCode V2 run launches
- **WHEN** run routes to OpenCode V2 profile and official `opencode2` is installed
- **THEN** engine SHALL launch detected OpenCode V2 process through Herdr-managed OpenCode lifecycle using isolated executable resolution
- **AND** use same rendered assignment and handoff contracts as other adapters

#### Scenario: Configured executable is missing
- **WHEN** selected Pi, OpenCode, or OpenCode V2 executable is absent
- **THEN** preflight SHALL fail with runtime/profile diagnostic before state advances or pane is created
- **AND** engine SHALL NOT install executable automatically

### Requirement: No implicit runtime fallback
Agent launch or execution failure SHALL NOT silently switch profile, runtime, model, or executable.

#### Scenario: Runtime launch fails
- **WHEN** selected adapter cannot launch configured runtime
- **THEN** run SHALL become blocked or effect SHALL remain failed according to retry policy
- **AND** alternate runtime SHALL require explicit configured retry policy or validated operator repair

### Requirement: Model availability preflight
At workflow start, the system SHALL validate that each routed profile's configured model is offered by the profile's execution environment, using the runtime CLI's model enumeration. Validation SHALL run during start-time routing preflight before any agent launches.

#### Scenario: Configured model is unavailable
- **WHEN** a routed profile names a model that the runtime's model enumeration does not include
- **THEN** workflow startup SHALL fail before any agent launches
- **AND** the error SHALL identify the profile, the runtime, the invalid model, and reference the available models

#### Scenario: Model with thinking suffix on pi
- **WHEN** a pi profile's model carries a `:<thinking>` suffix whose base id is available
- **THEN** the model SHALL pass availability validation

#### Scenario: Runtime model enumeration fails
- **WHEN** the runtime CLI cannot enumerate its models during preflight
- **THEN** workflow startup SHALL fail closed with the underlying command error rather than starting agents unvalidated

### Requirement: Repository-scoped configuration context
Workflow startup and related configuration reads/edits SHALL resolve project overlays from an explicit selected canonical repository context, not the host process working directory. Configuration provenance SHALL identify the effective sources. An explicit HERDR_WORKFLOW_CONFIG replacement SHALL retain precedence over user defaults and project overlays.

#### Scenario: Another repository is selected
- **WHEN** a process launched from repository A starts a workflow targeting repository B
- **THEN** repository B's canonical project overlay SHALL be selected over user defaults
- **AND** repository A's project overlay SHALL not influence that start

#### Scenario: Startup targets a linked worktree
- **WHEN** startup targets a linked worktree of a repository
- **THEN** its project overlay SHALL resolve from the same canonical repository context used for that repository's workflow configuration

#### Scenario: Repository-independent workflow has no repository context
- **WHEN** research or internal wiki startup has no explicitly selected repository context
- **THEN** configuration SHALL use the explicit replacement or user defaults without an ambient cwd project overlay

#### Scenario: Explicit configuration replacement is supplied
- **WHEN** HERDR_WORKFLOW_CONFIG selects a configuration file
- **THEN** it SHALL replace the user/project configuration selection for that operation
- **AND** no project overlay SHALL shadow it

#### Scenario: Dashboard edits selected configuration
- **WHEN** the dashboard edits profiles or presets for an explicit repository context
- **THEN** reads and write-back SHALL resolve the same effective source and preserve layered-source conflict checks
- **AND** the UI SHALL identify that source without treating repository executable settings as untrusted inert data

### Requirement: Pinned non-secret execution settings
Workflow creation SHALL persist the accepted non-secret settings required by later configuration-sensitive effects, including the delivery remote and PR executable selection or its explicit unavailability. Later effects SHALL use those settings rather than rereading the drainer's ambient configuration. Credentials SHALL not be persisted in this record.

#### Scenario: Delivery configuration changes after start
- **WHEN** configuration changes or another process drains an already-started workflow from another directory
- **THEN** delivery and PR effects SHALL retain that workflow's accepted settings
- **AND** no new remote or executable SHALL be selected implicitly

#### Scenario: Legacy workflow lacks execution settings
- **WHEN** a workflow without accepted execution settings reaches a configuration-sensitive effect
- **THEN** that effect SHALL stop with an actionable settings-adoption diagnostic
- **AND** status SHALL remain readable without choosing settings on the user's behalf

#### Scenario: Operator adopts legacy settings
- **WHEN** an operator previews and confirms validated settings against the current workflow revision through repair or migration
- **THEN** the engine SHALL atomically record the accepted settings and an audit event
- **AND** a stale or invalid adoption SHALL leave settings and effects unchanged

