## MODIFIED Requirements

### Requirement: One UI preference authority
All feature surfaces SHALL share one local UI preferences adapter and active theme store. The adapter SHALL use only `tui.json` under the shared canonical configuration root, defaulting to `~/.config/agentic-coding/tui.json`, and SHALL keep workflow execution configuration separate. It SHALL NOT import preferences from a workflow config or historical file.

#### Scenario: Existing selection takes precedence
- **WHEN** canonical `tui.json` contains a valid theme and another file contains a different theme
- **THEN** the canonical selection SHALL win for every feature
- **AND** startup SHALL NOT overwrite either source file merely to read the selection

#### Scenario: Old preference is ignored
- **WHEN** no canonical selection exists and an old workflow config contains a theme
- **THEN** startup SHALL use the normal current default and SHALL NOT import or persist the old selection

#### Scenario: Canonical saves remain atomic
- **WHEN** a preference is changed
- **THEN** subsequent saves SHALL use the canonical file atomically and preserve unrelated current JSON keys
