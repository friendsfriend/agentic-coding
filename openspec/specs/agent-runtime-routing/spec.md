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

### Requirement: Optional runtime diversity constraints
Configuration SHALL allow workflow to require selected steps or roles to use different runtime identifiers.

#### Scenario: Implementation and verification differ
- **WHEN** workflow requires runtime diversity and routes implementation to Pi and verification to OpenCode V2
- **THEN** routing validation SHALL pass
- **AND** pinned view SHALL expose satisfied constraint

#### Scenario: Diversity constraint is violated
- **WHEN** constrained implementation and verification resolve to same runtime
- **THEN** workflow start SHALL fail before any role launches
- **AND** error SHALL name conflicting routes

### Requirement: No implicit runtime fallback
Agent launch or execution failure SHALL NOT silently switch profile, runtime, model, or executable.

#### Scenario: Runtime launch fails
- **WHEN** selected adapter cannot launch configured runtime
- **THEN** run SHALL become blocked or effect SHALL remain failed according to retry policy
- **AND** alternate runtime SHALL require explicit configured retry policy or validated operator repair
