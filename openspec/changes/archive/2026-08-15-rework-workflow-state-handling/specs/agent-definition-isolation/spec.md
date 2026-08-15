## MODIFIED Requirements

### Requirement: Agent definitions outside pi discovery
Workflow-owned instruction and runtime bridge assets SHALL reside outside Pi, OpenCode, and OpenCode V2 automatic skill/plugin discovery unless adapter explicitly references bridge for current run.

#### Scenario: Herdr skill is not auto-discovered
- **GIVEN** workflow protocol or step instruction Markdown asset
- **WHEN** user starts Pi or OpenCode manually without workflow adapter
- **THEN** runtime SHALL not advertise asset as skill, command, or ambient instruction

#### Scenario: Herdr extension is not auto-discovered
- **GIVEN** workflow telemetry bridge asset
- **WHEN** runtime starts outside managed workflow
- **THEN** bridge SHALL not load unless explicitly configured by adapter

#### Scenario: User pi session unaffected
- **GIVEN** no managed workflow adapter launch
- **WHEN** user starts Pi or OpenCode manually
- **THEN** workflow instructions SHALL not appear in prompt
- **AND** workflow bridges SHALL not load

#### Scenario: Managed assignment uses instruction asset
- **WHEN** engine creates managed run
- **THEN** engine SHALL load pinned Markdown itself and copy rendered content into assignment message
- **AND** adapter SHALL not pass instruction asset through runtime skill mechanism

### Requirement: Stow script does not link agent definitions
Stow installation SHALL NOT link workflow instruction or bridge assets into global agent discovery directories.

#### Scenario: Stow skips agent-definitions
- **WHEN** `scripts/stow.sh` runs
- **THEN** workflow instruction Markdown SHALL not appear under global Pi/OpenCode skill directories
- **AND** workflow telemetry/handoff bridges SHALL not become globally auto-loaded plugins/extensions

#### Scenario: Stow cleans stale herdr symlinks
- **GIVEN** stale `herdr-openspec-*` skill symlinks from prior installation
- **WHEN** stow runs
- **THEN** stale symlinks SHALL be removed

## REMOVED Requirements

### Requirement: Herdr workflow loads definitions explicitly
**Reason**: Runtime skill loading couples assignments to Pi and duplicates lifecycle instructions across role skills.
**Migration**: Engine renders common protocol and step Markdown into normal assignment prompt; adapters explicitly load only runtime telemetry bridge when supported.
