# bun-environment-action-engine Specification

## Purpose
Bun owns environment action execution: immutable versioned definitions compiled
from the configured environment, the semantic step tree with deduplicated
execution, the command/process/readiness lifecycle, the script surface and the
run history the TUI renders. The workflow state machine and its durable outbox
stay separate, and the remaining Go runtime capabilities are reached through
narrow private adapters that allocate no run tree of their own.
## Requirements
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

### Requirement: Symlinked definition sources resolve to their real path

A *build* definition whose source file is a symbolic link SHALL execute: the engine SHALL resolve the container tool's `-f` argument to the symlink's real path (or pass the definition as a plain file) so that a Dockerfile reached through a symlink outside the build context is read, and a link that cannot be resolved SHALL be reported as an error naming it rather than as a missing file.

A *compose* source keeps the path as given, deliberately: `docker compose` derives its project directory from the compose file path as written, so resolving a symlinked compose file to its real path would silently change how that file's relative mounts and `include:` targets resolve. The compose file is read through the link, which is what the link is for.

#### Scenario: Symlinked Dockerfile outside the build context

- **WHEN** `apps/build/<app>-build.Dockerfile` is a symlink to a file in another directory and the default build action runs with the checkout as its build context
- **THEN** the container tool SHALL be invoked with the resolved real path and the build SHALL proceed instead of failing with `failed to read dockerfile`

#### Scenario: Symlinked compose source

- **WHEN** `apps/compose/<app>-compose.yml` is a symlink to a definition elsewhere, or a staged run target is started from a staged configuration root whose compose file `include:`s a shared infrastructure definition
- **THEN** the compose command SHALL be invoked with the compose file's own path (inside the staged root when the run resolves one), the file it names SHALL be read through that path, and the start SHALL reach readiness

### Requirement: Default target selection is deterministic and reported

When a request does not name a build, test or run target, the engine SHALL select the default-profile target deterministically, SHALL refuse rather than silently pick when several candidates share the default profile, and SHALL make the selection readable by callers so a listing or report can name the default target per action.

#### Scenario: Two default-profile build targets

- **WHEN** an app declares a Dockerfile build target and a script build target, both without a profile, and a caller runs the build without naming one
- **THEN** the engine SHALL fail with an error naming both candidate targets instead of picking one

#### Scenario: Named default is reported

- **WHEN** a caller asks which build target is the default for an app with exactly one default-profile build target
- **THEN** the answer SHALL name that target and the request SHALL run it

### Requirement: Build context preparation does not emit spurious errors

The build-context preparation step SHALL NOT write an error for an absent optional input, so a successful build's log carries no `No such file or directory` line for a directory the configuration does not have.

#### Scenario: Configuration has no templates directory

- **WHEN** the default build action runs for a configuration without a `templates` directory
- **THEN** the preparation step SHALL complete successfully with empty stderr

