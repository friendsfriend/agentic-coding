## ADDED Requirements

### Requirement: Provider and CI feature parity
Bun SHALL preserve existing provider configuration, repository search, GitHub/GitLab issues, change requests, discussions, approvals, references and CI job/test/log operations. Provider-specific identifiers and diff positions SHALL NOT be lost through normalization.

#### Scenario: Paged issue query is filtered
- **WHEN** a client requests a searched, filtered and sorted page
- **THEN** filtering/search/sort SHALL apply before pagination and totals SHALL match the established provider contract

#### Scenario: Inline review comment is submitted
- **WHEN** a user submits a supported inline comment against a change-request version
- **THEN** Bun SHALL preserve provider-specific position/version data and return compatible success or validation diagnostics

### Requirement: Safe compatible Git operations
Git inspection and mutations SHALL preserve configured repository/worktree identity, credential and cancellation behavior. User inputs SHALL be validated and passed through safe argument boundaries. Migrated operations invoked by the old action owner SHALL retain one command-history owner.

#### Scenario: Existing workflow uses another checkout
- **WHEN** an environment Git operation changes its active checkout
- **THEN** existing workflow repository/worktree pins SHALL remain unchanged

#### Scenario: Go action invokes Bun Git operation
- **WHEN** an unported action invokes a migrated command capability
- **THEN** exact run/step identity, cancellation and actual command output SHALL cross the private adapter
- **AND** only the existing action owner SHALL record the command in its run tree

### Requirement: Scoped AI streaming and session discovery
Bun SHALL preserve supported Pi session discovery, streamed log analysis and change-request AI review. Callback authorization SHALL be bounded to the active review/project/change request; owned temporary worktrees and processes SHALL be cleaned up without deleting pre-existing resources.

#### Scenario: Review stream disconnects
- **WHEN** the controlling review stream closes or is cancelled
- **THEN** callback authorization SHALL expire, owned work SHALL stop, and owned temporary checkout cleanup SHALL run
- **AND** secret values SHALL NOT enter logs/history and unrelated worktrees SHALL remain untouched

#### Scenario: Callback targets wrong review
- **WHEN** a callback presents an expired token or a different review/project target
- **THEN** Bun SHALL reject it without posting provider content

#### Scenario: Session file is malformed or oversized
- **WHEN** session discovery reads invalid or excessive JSONL content
- **THEN** parsing SHALL remain bounded and report/skip the invalid record without executing content or crashing the entire list

### Requirement: Single route and mutation ownership
Each integration route/capability SHALL have exactly one runtime owner at cutover. Compatibility evidence SHALL use fixtures or isolated test systems rather than duplicate real mutations.

#### Scenario: Response is lost after provider write
- **WHEN** a provider write may have committed before transport failure
- **THEN** the client/backend SHALL reconcile using operation semantics rather than automatically submit the same mutation to both runtimes
