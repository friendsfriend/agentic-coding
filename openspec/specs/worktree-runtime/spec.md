# worktree-runtime Specification

## Purpose
TBD - created by archiving change introduce-worktree-port. Update Purpose after archive.
## Requirements
### Requirement: Effect-native worktree port

The system SHALL define one runtime-neutral worktree port whose operations are
required Effect effects covering worktree listing, resolution by branch,
create-or-reuse, and removal. Port operations SHALL accept
and return normalized intents and identities, and SHALL NOT accept raw vendor
argument vectors, expose a raw-command escape hatch, mark operations optional,
or gate behavior behind capability flags. Port failures SHALL distinguish
confirmed absence, unavailability, conflict, and an unusable reply.

#### Scenario: Callers never build worktree commands

- **WHEN** an environment route, an action definition, or workflow setup needs
  worktree behavior
- **THEN** every worktree action SHALL be performed through port operations
- **AND** the caller SHALL NOT construct `wt` or `git` worktree arguments

#### Scenario: Confirmed absence is distinguishable

- **WHEN** no worktree exists for a branch
- **THEN** resolution SHALL report absence as an empty result
- **AND** a transport failure or a conflicting state SHALL remain
  distinguishable from that absence

#### Scenario: Conflicts are permanent, transport failures are transient

- **WHEN** a worktree operation fails because the branch is checked out
  elsewhere, the target path is occupied, or the primary worktree is the target
- **THEN** the failure SHALL be reported as a conflict that retrying cannot fix
- **AND** an unavailable worktrunk binary, a failed subprocess, or an
  unparseable reply SHALL be reported as unavailable or as an unusable reply

### Requirement: Worktrunk-backed worktree lifecycle

The port SHALL implement the worktree lifecycle over the installed worktrunk
CLI, decoding its structured output rather than its human-readable text, and
SHALL address worktrees by branch. Creation and reuse SHALL be one operation
that reports the resolved path whether the worktree already existed or was
created. Removal SHALL keep the branch unless the caller asks for its deletion,
SHALL support removing a worktree with uncommitted changes, and SHALL resolve a
worktree whose directory no longer exists. The primary worktree SHALL NOT be
removable through the port.

#### Scenario: Create-or-reuse returns one identity

- **WHEN** a caller ensures a worktree for a branch that has none, and again
  for a branch that already has one
- **THEN** both calls SHALL return the same normalized path and branch
- **AND** only the first call SHALL report that it created the worktree

#### Scenario: New branch starts at the requested base

- **WHEN** a caller ensures a worktree for a branch that does not exist yet and
  supplies a base commit
- **THEN** the created branch SHALL start at that base
- **AND** the same request SHALL succeed identically on every supported
  multiplexer

#### Scenario: Removal keeps the branch and refuses the primary worktree

- **WHEN** a caller removes a linked worktree
- **THEN** the branch SHALL still exist unless the caller asked for deletion
- **AND** removal of the primary worktree SHALL fail as a conflict

#### Scenario: A stale worktree is reclaimed

- **WHEN** a worktree's directory has been deleted outside the port
- **THEN** removal SHALL reclaim the worktree record instead of failing

### Requirement: One worktree layout for both layers

The system SHALL compute linked worktree paths from one shared template of the
form `<root>/<ident>/<ident>.<sanitized branch>`, where the root and identifier
are supplied by the caller. The environment layer SHALL keep its existing
configuration root and directory names unchanged, and the workflow layer SHALL
use the same shape under its own root.

#### Scenario: Layout is caller-owned

- **WHEN** an environment worktree is created for an app whose configuration
  root is `$DEVENV_HOME`
- **THEN** the worktree directory SHALL be
  `$DEVENV_HOME/<ident>/<ident>.<sanitized branch>`
- **AND** the port SHALL NOT read ambient configuration to decide the path

#### Scenario: Branch separators are sanitized identically

- **WHEN** a worktree is created for a branch whose name contains `/`
- **THEN** the directory name SHALL replace the separators with `-`
- **AND** both layers SHALL produce the same directory name for the same branch

### Requirement: Worktree hooks never run from the port

Every port invocation SHALL disable worktrunk hooks and directory changes and
SHALL run non-interactively, so a repository-configured project hook can never
execute because an environment action or a workflow asked for a worktree.

#### Scenario: Project hooks are skipped

- **WHEN** a repository configures project hooks and a caller creates a
  worktree through the port
- **THEN** no hook SHALL run
- **AND** the calling process's working directory SHALL be unchanged

### Requirement: Bounded worktrunk dependency

Worktree operations SHALL validate that the configured worktrunk executable
exists and satisfies a minimum version before use, and SHALL fail loudly with
the binary name and the required version. Credentials SHALL NOT be passed to
worktrunk, and a fetch that needs credentials SHALL remain the caller's step.

#### Scenario: Missing or outdated worktrunk fails loudly

- **WHEN** the worktrunk executable is absent or older than the supported
  version
- **THEN** the operation SHALL fail with a diagnostic naming the binary and the
  required version
- **AND** no other worktree implementation SHALL be substituted

#### Scenario: No credential crosses the port

- **WHEN** a caller needs a credentialed fetch before ensuring a worktree
- **THEN** the fetch SHALL run outside the port
- **AND** the port SHALL NOT receive or forward a credential

