# unified-json-configuration Specification

## Purpose
TBD - created by archiving change unify-json-configuration-directory. Update Purpose after archive.
## Requirements
### Requirement: One canonical configuration root
All application-owned global configuration consumers SHALL share one resolver, defaulting to `~/.config/agentic-coding`. Existing explicit config-dir arguments SHALL take precedence over `AGENTIC_CODING_CONFIG_DIR`, then deprecated `DEVENV_CONFIG_DIR`, then the default. The legacy variable SHALL select one root rather than add a second authority. Resolved roots SHALL propagate consistently to application subprocesses; root selection SHALL NOT depend on the root's `.env` contents.

#### Scenario: Both variables are set
- **WHEN** both root environment variables are present
- **THEN** the new variable SHALL win and consumers SHALL report deprecation without reading or writing both roots

#### Scenario: Legacy files without migrated canonical configuration
- **WHEN** startup finds applicable unmigrated legacy global configuration
- **THEN** it SHALL explain explicit migration rather than silently initialize a shadowing empty setup or permanently combine both roots

### Requirement: Structured configuration uses JSON with preserved scope
Application-owned structured configuration SHALL use validated JSON, including global workflow configuration in `config.json`. Existing environment JSON layout and domain semantics SHALL remain intact. New repository overlays SHALL use `.pi/herdr-workflow.json`; existing TOML overlays and explicit legacy replacement files SHALL be read-only compatibility inputs requiring explicit conversion before edits. Global migration SHALL NOT silently modify repositories. Simultaneous formats at the same scope SHALL produce an ambiguity diagnostic.

#### Scenario: Project overrides global defaults
- **WHEN** a canonical-repository JSON overlay supplies agent settings
- **THEN** effective resolution and write/conflict rules SHALL preserve existing project-over-base behavior and unrelated fields

#### Scenario: Explicit replacement
- **WHEN** `HERDR_WORKFLOW_CONFIG` selects a supported config file
- **THEN** that file SHALL retain full-replacement semantics without an implicit project overlay

#### Scenario: Independent workflow
- **WHEN** repository-independent wiki or research settings are resolved
- **THEN** cwd configuration SHALL NOT become a project overlay

### Requirement: Shared .env secret references
The selected root's `.env` SHALL support existing devenv bootstrap and provider usage and workflow credential references. Secret-bearing JSON fields SHALL store `${VARIABLE}` references rather than literal secrets. Explicit process variables SHALL override root `.env` values, including empty values. Resolution SHALL occur on parsed schema-approved fields without raw JSON substitution, recursive secret expansion, arbitrary cwd `.env` loading or shell execution.

#### Scenario: Secret contains JSON delimiters
- **WHEN** a referenced secret contains quotes, backslashes or newlines
- **THEN** the consumer SHALL receive the exact string without corrupting JSON or persisting the expanded value

#### Scenario: Required variable is missing
- **WHEN** an operation requires an unresolved credential reference
- **THEN** that operation SHALL fail with the variable/field identity but no secret value; unrelated available configuration SHALL remain inspectable

### Requirement: Credentials remain confined to their owner
Credential edits SHALL use the authenticated owning-server boundary and preserve unrelated `.env` lines. Secret files and backups SHALL have owner-only protection. Expanded secrets SHALL NOT appear in ordinary config files, Settings read responses, route state, logs, traces, migration output or durable configuration pins. Child processes SHALL receive only credentials required by their existing operation policy. Ephemeral workflow answers and external harness credential stores SHALL NOT be persisted/imported automatically.

#### Scenario: Attached Settings saves a credential
- **WHEN** an attached client updates a supported workflow/provider secret
- **THEN** the server SHALL update its protected `.env` and persist only the reference in JSON without modifying client-local configuration

#### Scenario: Persist a workflow configuration snapshot
- **WHEN** workflow state pins configuration using a secret reference
- **THEN** it SHALL retain the reference and non-secret settings without serializing its resolved secret value

### Requirement: Migration is explicit and non-destructive
Migration SHALL preview by default, require explicit apply, preserve current effective precedence, and identify conflicting target files, definition IDs, variable values, symlinks and unsupported conversions without exposing secrets. Apply SHALL use writer exclusion, source fingerprints, protected backups/staging and validation before journaled publication. Interrupted publication SHALL block normal reads of a mixed snapshot until resume or rollback. Source files and unrelated target files SHALL remain preserved.

#### Scenario: Duplicate secret key differs
- **WHEN** source and destination `.env` contain different values for the same variable
- **THEN** migration SHALL require conflict resolution without displaying either value or applying last-write-wins

#### Scenario: Migration interrupts publication
- **WHEN** apply stops after publishing only some staged files
- **THEN** normal startup SHALL refuse the mixed configuration and explicit resume/rollback SHALL recover a validated consistent state

#### Scenario: Migration reruns
- **WHEN** an already completed migration is requested again
- **THEN** it SHALL verify its state without duplicating entries or overwriting newer canonical edits

### Requirement: Configuration relocation does not relocate runtime data
Migration SHALL retain supported native-format assets and preserve stable project identities, absolute runtime/checkouts/wiki locations, databases and existing workflow pins. Only known configuration-asset references SHALL be rebased where necessary. Global migration SHALL NOT replace the entire target directory or treat all contained files as configuration.

#### Scenario: Wiki exists under destination
- **WHEN** `~/.config/agentic-coding/wiki` already contains knowledge data
- **THEN** configuration migration SHALL leave that content and its existing location unchanged

#### Scenario: Active workflow has old provenance
- **WHEN** an active workflow records pre-migration source paths or pinned checkout settings
- **THEN** migration SHALL NOT rewrite its durable execution records merely to match the new configuration layout

