## MODIFIED Requirements

### Requirement: Bun owns canonical environment configuration
Bun SHALL provide app/library/infrastructure loading, catalog projection and runtime path resolution with compatible configuration precedence, stable identities and validation. Environment configuration SHALL use the shared canonical root, defaulting to `~/.config/agentic-coding`, preserving its JSON definition layout and `.env` credential references. Runtime state SHALL remain separate from static configuration files and SHALL NOT relocate as a side effect of configuration migration.

#### Scenario: Active worktree is missing
- **WHEN** a configured active linked worktree no longer exists
- **THEN** Bun SHALL apply the captured managed-path fallback behavior and report availability consistently with the established catalog contract
- **AND** it SHALL NOT rewrite the static app definition with runtime fields

#### Scenario: Configuration reload fails
- **WHEN** a new configuration snapshot cannot be validated
- **THEN** callers SHALL receive a diagnostic and SHALL NOT observe a partially published catalog/registry configuration
