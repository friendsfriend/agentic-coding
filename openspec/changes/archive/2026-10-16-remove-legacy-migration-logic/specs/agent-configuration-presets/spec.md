## REMOVED Requirements

### Requirement: Preset pool hard-break migration and notification

**Reason**: The application no longer edits stored configuration to migrate or strip historical preset shapes. Current JSON presets remain supported as written.
**Migration**: Keep current presets and profile data in `config.json`; obsolete-format configuration is not imported or rewritten by this build.

#### Scenario: Current presets are not rewritten on load
- **WHEN** a valid current JSON configuration containing custom presets is loaded
- **THEN** the loader SHALL preserve those presets and SHALL NOT run a hard-break conversion or notification migration
