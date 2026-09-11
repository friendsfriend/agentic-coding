## ADDED Requirements

### Requirement: Immutable compatible action definitions
Bun SHALL compile immutable action definitions with stable resource/action/runtime/profile IDs, atomically publish registry versions and retain compact versioned definition snapshots on active and historical runs. Labels SHALL resolve through one canonical registry.

#### Scenario: Configuration reloads during execution
- **WHEN** configuration publishes a new registry while a run is active
- **THEN** that run and its later history SHALL retain the original version and definition snapshot
- **AND** labels or checkout paths SHALL NOT silently change its identity

### Requirement: Semantic tree and execution identity remain distinct
Semantic step nodes SHALL retain their tree identity while duplicate dependencies share an execution key. One canonical execution SHALL own commands and references SHALL mirror outcomes without duplicating executed work.

#### Scenario: Two paths depend on same resource
- **WHEN** an action tree reaches the same execution dependency twice
- **THEN** the tree SHALL show both semantic relationships and execute the work once
- **AND** reference nodes SHALL NOT own duplicate command output

### Requirement: Exact command accounting and typed values
Each executed process command SHALL have exactly one leaf step owning its command, stdout, stderr, exit code and error. Composite/SDK steps SHALL remain commandless when they execute no command. Named typed values SHALL preserve declared scope/visibility; secret and ephemeral values SHALL NOT persist.

#### Scenario: Command fails before next step
- **WHEN** a command exits unsuccessfully and later commands are not run
- **THEN** history SHALL retain that command's exact output/result and required cleanup outcomes
- **AND** no placeholder command step SHALL be fabricated for work that did not execute

#### Scenario: Secret value flows to consumer
- **WHEN** an action uses a secret or ephemeral named value
- **THEN** only authorized scoped consumers SHALL receive it
- **AND** snapshots/history/default errors SHALL NOT serialize it

### Requirement: Readiness and resource ownership gate success
Process/resource startup SHALL succeed only after its readiness step. Already-running SHALL be an explicit successful outcome without a fabricated command. Cancellation, leases and recovery SHALL protect adopted or successor-owned resources.

#### Scenario: Process exits before readiness
- **WHEN** a launched process exits before its required readiness condition
- **THEN** the action SHALL fail or report its established non-success outcome rather than mark startup successful

#### Scenario: Resource was already running
- **WHEN** readiness confirms an existing compatible resource
- **THEN** the result SHALL be already-running success and command history SHALL contain no invented startup command

#### Scenario: Late result follows cancellation or ownership transfer
- **WHEN** an old execution returns after ownership changed
- **THEN** it SHALL NOT publish under the new owner or kill an adopted resource

### Requirement: Script and mixed-runtime execution parity
Bun SHALL preserve script metadata, arguments/history, interpreter selection, shell/PowerShell/systemshell execution and tmux/process recovery. Private Go runtime adapters SHALL report actual operations under Bun run ownership, not allocate another action tree.

#### Scenario: Runtime adapter executes commands
- **WHEN** a Bun-owned action invokes an unported container/Kubernetes capability
- **THEN** command lifecycle/output and cancellation SHALL retain exact execution identity
- **AND** Bun SHALL remain sole run/history owner

### Requirement: Quiescent executor cutover
The Go-to-Bun action-owner switch SHALL require old command runs to settle or be cancelled safely. Environment action semantics SHALL NOT be replaced with workflow state transitions or durable-outbox retries.

#### Scenario: Old run is still active at cutover
- **WHEN** an old Go-owned command run remains active
- **THEN** cutover SHALL wait or explicitly cancel it rather than pretend to transfer in-memory process handles
- **AND** its persisted history SHALL remain readable afterward
