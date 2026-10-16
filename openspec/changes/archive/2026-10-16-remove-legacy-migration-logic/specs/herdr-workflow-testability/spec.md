## REMOVED Requirements

### Requirement: Legacy migration is tested

**Reason**: Legacy workflow import/migration is removed and no longer constitutes supported application behavior.
**Migration**: Replace conversion fixtures with current-format v6 opening and fail-closed/no-mutation checks; retain all current workflow transition, concurrency and adapter tests.

#### Scenario: Current-format boundary is tested instead
- **WHEN** focused workflow persistence tests run
- **THEN** they SHALL cover fresh v6 creation, existing v6 open, and unsupported-version refusal without mutation

## ADDED Requirements

### Requirement: Unsupported persisted formats are tested without mutation
Focused persistence tests SHALL invoke production readers with disposable fixtures and SHALL verify unsupported workflow, config, environment and telemetry formats are rejected or ignored without being rewritten.

#### Scenario: Historical workflow store is refused
- **WHEN** a disposable non-v6 workflow database is opened
- **THEN** the test SHALL assert the exact unsupported-version error and unchanged schema/data/version

#### Scenario: Current configuration fixture remains loadable
- **WHEN** a copied sanitized current JSON configuration is loaded under temporary HOME and config-root overrides
- **THEN** current config consumers SHALL resolve expected values without reading the real config directory
