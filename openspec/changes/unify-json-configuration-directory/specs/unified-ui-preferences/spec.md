## MODIFIED Requirements

### Requirement: One UI preference authority
All feature surfaces SHALL share one local UI preferences adapter and active theme store. The adapter SHALL use `tui.json` under the shared canonical configuration root, defaulting to `~/.config/agentic-coding/tui.json`, and SHALL keep workflow execution configuration separate.

#### Scenario: Existing selection takes precedence
- **WHEN** canonical UI preferences already contain a valid theme and legacy workflow preferences differ
- **THEN** the canonical selection SHALL win for every feature
- **AND** startup SHALL NOT overwrite either source file merely to read the selection

#### Scenario: Legacy theme is imported
- **WHEN** no canonical selection exists and explicit migration finds a valid legacy UI selection
- **THEN** the explicit migration SHALL import that selection without losing unrelated canonical preference keys
- **AND** subsequent saves SHALL use the canonical file atomically
