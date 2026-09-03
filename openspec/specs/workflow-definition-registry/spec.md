# workflow-definition-registry Specification

## Purpose
Defines rigid, versioned workflow and step contracts that remain easy to compose and can later be registered by trusted workflow plugins without changing runtime semantics.

## Requirements

### Requirement: Registered step contract
The system SHALL represent every workflow step as a registered, versioned definition with a stable identifier, actor kind, input and output contract, permitted outcomes, entry and completion validation, instruction assets when applicable, allowlisted external effects, and a declarative step behavior block that carries the step's own engine-internal semantics. The behavior block SHALL cover the step's agent role selection, entry guards, arrival semantics, entry effects, developer actions, and assignment inputs. The behavior block SHALL NOT contribute to the step digest or the workflow definition digest, so declaring or changing behavior SHALL NOT invalidate any existing pinned workflow.

#### Scenario: Built-in step is registered
- **WHEN** engine initializes its built-in step catalog
- **THEN** every step SHALL expose all required contract fields
- **AND** no command handler SHALL provide an unregistered lifecycle path around the step contract

#### Scenario: Step output is incompatible
- **WHEN** a run submits output that does not satisfy its pinned step output contract
- **THEN** engine SHALL reject completion without changing workflow state
- **AND** rejection SHALL identify the failed contract

#### Scenario: Behavior is declared without moving a digest
- **WHEN** the built-in step catalog is registered with declared step behavior
- **THEN** every registered workflow definition digest and every step digest SHALL be identical to the value produced before behavior was declared
- **AND** an existing workflow pinned to that definition SHALL continue to dispatch without repair or migration

#### Scenario: Behavior declares no agent roles for an agent step
- **WHEN** a step whose actor kind is `agent` is registered with a behavior block that resolves to no roles
- **THEN** registration SHALL be rejected identifying the offending step
- **AND** no partially registered catalog SHALL be exposed

### Requirement: Explicit workflow composition
The system SHALL define each workflow as an explicit, versioned graph of registered steps and legal outcomes rather than deriving behavior from phase names or array position. The catalog SHALL include explicit `openspec-propose`, `openspec-fusion-propose`, `wiki`, and `research` graphs that reference the registered steps needed for their respective execution, while excluding implementation, verification, archive, delivery, and pull-request action/effect paths from proposal-only, wiki, and research lifecycles.

#### Scenario: Workflow graph is explicit
- **WHEN** a workflow definition is registered
- **THEN** the system SHALL expose its new technical ID, UI label, initial step, terminal steps, registered steps, legal outcome targets, declared loops, retry bounds, actor requirements, and requested effects as an explicit validated graph

#### Scenario: Standard proposal definition is explicit
- **WHEN** the built-in catalog is initialized
- **THEN** `openspec-propose` SHALL contain `core.plan`, `core.plan-approval`, `core.completed`, and `core.closed`
- **AND** its successful path SHALL be `core.plan → core.plan-approval → core.completed → core.closed`
- **AND** its planning `blocked` and `failed` outcomes SHALL retain bounded loops
- **AND** its reachable lifecycle SHALL not launch implementation, verification, archive, delivery, or pull-request effects

#### Scenario: Fusion proposal definition is explicit
- **WHEN** the built-in catalog is initialized
- **THEN** `openspec-fusion-propose` SHALL contain `fusion.plan`, `fusion.consolidate`, `core.plan-approval`, `core.completed`, and `core.closed`
- **AND** its successful path SHALL be `fusion.plan → fusion.consolidate → core.plan-approval → core.completed → core.closed`
- **AND** its fusion planning and consolidation `blocked` and `failed` outcomes SHALL retain bounded loops
- **AND** its reachable lifecycle SHALL not launch implementation, verification, archive, delivery, or pull-request effects

#### Scenario: Wiki-only definition is explicit
- **WHEN** the built-in catalog is initialized
- **THEN** `wiki` SHALL contain `core.wiki`, `core.wiki-approval`, `core.completed`, and `core.closed`
- **AND** its successful path SHALL be `core.wiki → core.wiki-approval → core.completed → core.closed`
- **AND** its documentation and review `blocked`, `failed`, and `comments` outcomes SHALL retain bounded loops
- **AND** its reachable lifecycle SHALL not launch implementation, verification, archive, delivery, or pull-request effects

#### Scenario: Research definition is explicit
- **WHEN** the built-in catalog is initialized
- **THEN** it exposes the `research` definition with `core.research` as initial and `core.closed` as terminal
- **AND** `core.research` SHALL route to the `researcher` role and require persistent interactive session capabilities
- **AND** the developer-only research actions and reachable lifecycle SHALL remain unchanged

#### Scenario: Workflow graph is invalid
- **WHEN** a definition contains a missing step, dangling outcome, unreachable terminal, undeclared cycle, unbounded retry, unknown actor, or unavailable effect
- **THEN** registration SHALL fail before any workflow can use that definition
- **AND** a partial definition SHALL NOT remain registered

### Requirement: Explicit extension selection
A registered step or workflow extension SHALL affect only definitions that explicitly reference it.

#### Scenario: Additional step is registered
- **WHEN** a new step becomes available in registry
- **THEN** existing workflow definitions SHALL remain unchanged
- **AND** step SHALL run only in a definition that explicitly includes its stable identifier

#### Scenario: Multiple extensions target same workflow area
- **WHEN** developer composes multiple registered steps around same built-in step
- **THEN** explicit workflow graph order SHALL determine execution
- **AND** engine SHALL NOT infer plugin insertion order from discovery order

### Requirement: Definition pinning
Each workflow SHALL pin exact workflow-definition identifier, version, and digest for its lifetime unless a validated migration changes that pin.

#### Scenario: Workflow starts
- **WHEN** start command accepts a workflow definition
- **THEN** persisted workflow SHALL record exact definition identifier, version, and digest
- **AND** all later commands SHALL evaluate against that pinned definition

#### Scenario: Registry definition changes
- **WHEN** registered definition digest no longer matches active workflow pin
- **THEN** workflow SHALL become blocked before further mutation
- **AND** engine SHALL require matching definition restoration or validated migration rather than reinterpret state

### Requirement: Plugin-grade built-in registry seam
Built-in steps and workflows SHALL register through the same public definition contract reserved for future trusted workflow plugins, while this release SHALL NOT automatically discover or execute external workflow plugin code.

#### Scenario: Built-in workflows initialize
- **WHEN** the engine starts
- **THEN** `openspec-full`, `openspec-apply`, `no-openspec`, `openspec-fusion-full`, `openspec-propose`, `openspec-fusion-propose`, `wiki`, and `research` definitions SHALL be registered through the public registry contract
- **AND** the UI-only `wiki-comments` definition SHALL also be registered for its internal start path
- **AND** the engine SHALL validate them identically to later registered definitions

#### Scenario: External package is present
- **WHEN** an unconfigured package or file exports workflow definitions
- **THEN** the engine SHALL NOT load or execute it automatically
- **AND** no filesystem discovery order SHALL affect registered workflows
### Requirement: Step-owned agent role selection
Agent role selection for a step SHALL be a property of that step's registered definition and SHALL have exactly one source of truth. The engine, the command-line surface, and the dashboard SHALL each read roles from the registered step definition rather than deriving, duplicating, or re-implementing role logic. Resolution MAY depend only on the workflow snapshot supplied to it — its pinned definition identity and its resolved routing — so the same step and snapshot SHALL always resolve the same roles regardless of which consumer asks.

#### Scenario: Every consumer resolves the same roles
- **WHEN** the engine, the command-line surface, and the dashboard each resolve roles for the same step of the same workflow
- **THEN** all three SHALL return the identical ordered role list
- **AND** no consumer SHALL contain its own role table

#### Scenario: Roles remain definition-sensitive
- **WHEN** roles are resolved for a step whose role list depends on the pinned definition
- **THEN** verification for the `no-openspec` definition SHALL omit the OpenSpec verifier role while other definitions retain it
- **AND** wiki drafting for the `research` definition SHALL resolve the research wiki drafting role while other definitions resolve the standard wiki role

#### Scenario: Roles remain routing-sensitive
- **WHEN** roles are resolved for the fusion planning step of a workflow whose routing configures a planner count
- **THEN** the resolved roles SHALL be exactly the configured number of distinct planner roles
- **AND** changing the configured planner count SHALL change the resolved roles without any consumer change

#### Scenario: Registered step is missing its behavior
- **WHEN** a workflow manifest references a registered step for which no behavior is declared
- **THEN** registry construction SHALL fail identifying the step
- **AND** the failure SHALL occur at catalog construction rather than when a workflow reaches that step

### Requirement: Step-owned entry guards
A step's entry guard SHALL be declared by that step and evaluated by the engine without the engine identifying the step. A failed guard SHALL reject the transition with an actionable diagnostic and SHALL leave workflow state unchanged.

#### Scenario: Guard rejects incomplete evidence
- **WHEN** a step whose guard requires completed planning artifacts is entered without them
- **THEN** the engine SHALL reject entry with an entry-guard diagnostic naming the missing evidence
- **AND** the workflow SHALL remain at its prior step with no state mutation

#### Scenario: Guard is definition-sensitive
- **WHEN** the implementation step is entered for a definition that does not use OpenSpec planning
- **THEN** the completed-task guard SHALL NOT apply
- **AND** the same guard SHALL apply for every definition that does use OpenSpec planning

#### Scenario: Engine evaluates guards generically
- **WHEN** the engine evaluates a step's entry guard
- **THEN** it SHALL do so through the registered step's declared guard
- **AND** no engine code path SHALL branch on a step identifier to decide which guard applies

### Requirement: Step-owned arrival semantics
Transition-time state derivation — loop and round counters, step mode, selected roles, and step context carry-over — SHALL be declared by the step being entered. The engine SHALL apply the declared edge, produce a fresh step state, and then invoke exactly one declared arrival handler. Context carry-over precedence SHALL be explicit and deterministic rather than dependent on the order of engine-side conditionals.

#### Scenario: Arrival derives step state
- **WHEN** a workflow transitions into a step that declares arrival semantics
- **THEN** the engine SHALL invoke that step's arrival handler exactly once with the inbound outcome, the submitted output, and the prior step's attempt, results, and context
- **AND** the resulting step state SHALL match the state produced before arrival semantics were step-owned

#### Scenario: Context carry-over precedence is preserved
- **WHEN** more than one carry-over rule matches a single transition
- **THEN** the engine SHALL resolve them in a single declared precedence order
- **AND** the resolved step context SHALL be identical to the context produced by the prior implementation for the same transition

#### Scenario: Retry preserves surviving parallel results
- **WHEN** a parallel planning step retries through a self-loop after a partial failure
- **THEN** validated results from roles that already produced output SHALL be preserved
- **AND** only roles without surviving validated output SHALL be relaunched

### Requirement: Step-owned developer actions
The developer actions offered at a step SHALL be declared by that step and SHALL have exactly one definition per action, regardless of how many workflow definitions reach that step. The engine SHALL retain only lifecycle-level action behavior that is not specific to any step.

#### Scenario: Approval step declares its actions once
- **WHEN** the actions available at an approval step are resolved for any workflow definition that reaches it
- **THEN** the offered actions SHALL come from one declaration for that step
- **AND** no step SHALL have its actions declared in more than one place

#### Scenario: Paused workflow overrides step actions
- **WHEN** a workflow is paused
- **THEN** the engine SHALL offer only the resume action regardless of the current step's declared actions

#### Scenario: Terminal action set is definition-sensitive
- **WHEN** actions are resolved at the completed step
- **THEN** a definition whose lifecycle produces no reviewable code change SHALL NOT offer a pull-request action
- **AND** every other definition SHALL offer it

### Requirement: Declarative workflow policy
A workflow manifest SHALL declare its execution policy — the kind of target it operates on, whether it requires a repository checkout, and whether it requires a read-only researcher boundary — as validated data on the definition. The engine SHALL read that policy rather than deriving it from workflow or target identifiers. Introducing or changing policy SHALL be accompanied by a definition version change, because manifest content determines the definition digest.

#### Scenario: Engine reads policy instead of identifiers
- **WHEN** the engine applies start-time target, checkout, or read-only rules
- **THEN** it SHALL read the pinned definition's declared policy
- **AND** no engine code path SHALL branch on a workflow definition identifier to decide those rules

#### Scenario: Policy introduction changes the definition version
- **WHEN** manifests are registered with a declared policy
- **THEN** the affected definitions SHALL be registered under a new version
- **AND** a workflow pinned to a prior version SHALL continue to resolve and dispatch against that prior version

#### Scenario: Invalid policy is rejected
- **WHEN** a manifest declares a policy with an unknown target kind or a contradictory requirement combination
- **THEN** registration SHALL be rejected identifying the manifest
- **AND** no partially registered catalog SHALL be exposed
