## ADDED Requirements

### Requirement: Compact codemode prompt section

When `codemode` is registered, its system-prompt section SHALL state the calling convention and the keep-direct rule once and list each callable tool by name with only the first sentence of its description, because the full description already reaches the model in the tool definition. The section SHALL list only tools the run actually offers.

#### Scenario: Full workflow tool set
- **WHEN** a durable workflow run with `codemode` enabled assembles its system prompt
- **THEN** the `codemode` section SHALL name every callable tool as `tools.<name>`
- **AND** SHALL NOT repeat any tool's description beyond its first sentence

#### Scenario: Read-only run
- **WHEN** the run is read-only
- **THEN** the `codemode` section SHALL NOT list `edit` or `write`
