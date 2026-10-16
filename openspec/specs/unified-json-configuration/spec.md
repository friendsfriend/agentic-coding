# unified-json-configuration Specification

## Purpose
TBD - created by archiving change unify-json-configuration-directory. Update Purpose after archive.
## Requirements
### Requirement: One canonical configuration root
All application-owned global configuration consumers SHALL share one resolver, defaulting to `~/.config/agentic-coding`. Explicit config-dir arguments SHALL take precedence over `AGENTIC_CODING_CONFIG_DIR`, then the canonical default. Resolved roots SHALL propagate consistently to application subprocesses; root selection SHALL NOT depend on `.env` contents. The deprecated `DEVENV_CONFIG_DIR` alias SHALL NOT select or warn about an alternate root.

#### Scenario: Explicit root selection
- **WHEN** an explicit config-dir argument or `AGENTIC_CODING_CONFIG_DIR` is present
- **THEN** it SHALL select the single root used by all current configuration consumers
- **AND** the deprecated variable SHALL NOT cause a second read or write

#### Scenario: Legacy files are not selected
- **WHEN** startup finds TOML or another historical configuration file instead of the current JSON file
- **THEN** it SHALL ignore or clearly reject that file without importing, shadow-merging, or rewriting it

### Requirement: Structured configuration uses JSON with preserved scope
Application-owned structured configuration SHALL use validated current JSON, including global workflow configuration in `config.json`. Environment JSON layout and domain semantics SHALL remain intact. New repository overlays SHALL use `.pi/herdr-workflow.json`; TOML overlays and legacy replacement files SHALL NOT be read or converted. Global configuration loading SHALL preserve the established project-over-base scope rules without treating historical formats as a source.

#### Scenario: Project overrides global defaults
- **WHEN** a canonical-repository JSON overlay supplies agent settings
- **THEN** effective resolution and write/conflict rules SHALL preserve existing project-over-base behavior and unrelated fields

#### Scenario: Explicit current JSON replacement
- **WHEN** `HERDR_WORKFLOW_CONFIG` selects a supported current JSON file
- **THEN** that file SHALL retain full-replacement semantics without an implicit project overlay

#### Scenario: Independent workflow
- **WHEN** repository-independent wiki or research settings are resolved
- **THEN** cwd configuration SHALL NOT become a project overlay

#### Scenario: Historical formats are not rewritten
- **WHEN** a configuration lookup encounters a TOML file, deprecated root variable, or migration journal
- **THEN** it SHALL not import, rename, edit, or copy that source into the canonical root

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

### Requirement: Multiplexer runtime selector

Application configuration SHALL accept one runtime-neutral multiplexer selector. The selector SHALL default to `herdr`, the `AGENTIC_CODING_MULTIPLEXER` environment variable SHALL override configured selection, and unsupported values SHALL fail validation with the supported identifiers. Resolution SHALL apply consistently to workflow execution, dashboard observation, and detached workflow subprocesses.

#### Scenario: Selector is absent

- **WHEN** neither configuration nor the environment selects a multiplexer
- **THEN** Herdr SHALL be selected
- **AND** existing configuration files SHALL remain valid without adding the field

#### Scenario: Configuration selects another runtime

- **WHEN** configuration selects a supported multiplexer and the environment override is unset
- **THEN** that runtime SHALL be selected for workflow execution and dashboard observation

#### Scenario: Environment overrides configuration

- **WHEN** the environment override selects a different runtime than configuration does
- **THEN** the environment override SHALL win
- **AND** the effective source SHALL be reportable in diagnostics

#### Scenario: Unsupported selector value

- **WHEN** configuration or the environment names an unsupported multiplexer
- **THEN** validation SHALL fail with a diagnostic naming the supported identifiers
- **AND** no workflow or dashboard operation SHALL run against a defaulted runtime

#### Scenario: Detached drain keeps the same runtime

- **WHEN** a detached workflow drain subprocess is spawned
- **THEN** the multiplexer selector and the selected runtime's connection variables SHALL be forwarded to that subprocess
- **AND** the child SHALL NOT resolve a different runtime than its parent

