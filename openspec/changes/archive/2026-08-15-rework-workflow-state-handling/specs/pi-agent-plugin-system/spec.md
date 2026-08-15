## ADDED Requirements

### Requirement: Agent extensions are runtime-scoped
User-installed Pi extensions SHALL be modeled as Pi profile options named agent extensions and SHALL not be treated as workflow step plugins, instruction assets, or portable behavior.

#### Scenario: Pi profile enables extensions
- **WHEN** unrestricted Pi profile explicitly permits user extensions
- **THEN** Pi adapter MAY load configured extensions subject to exclusions
- **AND** workflow semantics SHALL remain unchanged when extensions absent

#### Scenario: Non-Pi profile is routed
- **WHEN** step routes to OpenCode or OpenCode V2
- **THEN** Pi extension configuration SHALL be ignored for that run
- **AND** engine SHALL not attempt to translate extension into another runtime plugin

### Requirement: Agent extension management naming
CLI SHALL expose `agent-extension` management for legacy Pi extension list/install operations and SHALL reserve `plugin` terminology for future workflow-definition plugins.

#### Scenario: User lists Pi extensions
- **WHEN** user runs `agentic-coding workflow agent-extension list`
- **THEN** command SHALL display discovered Pi extensions and Pi profile assignments/exclusions
- **AND** it SHALL not claim they extend workflow registry

#### Scenario: User installs Pi extension
- **WHEN** user explicitly runs `agent-extension install` or `install-local`
- **THEN** manager SHALL perform existing Pi install/copy behavior and record Pi profile assignment
- **AND** no workflow definition SHALL change automatically

### Requirement: Runtime policy is profile-driven
Restricted/unrestricted behavior SHALL be expressed as adapter capability and profile policy, not global role classification tied to Pi commands.

#### Scenario: Verification uses Pi
- **WHEN** verifier routes to restricted Pi profile
- **THEN** adapter SHALL disable unapproved skills/extensions and enforce declared tool policy

#### Scenario: Verification uses OpenCode
- **WHEN** same verifier routes to restricted OpenCode profile
- **THEN** OpenCode adapter SHALL enforce equivalent declared capabilities using its runtime policy
- **AND** absence of equivalent enforcement SHALL fail routing preflight

## REMOVED Requirements

### Requirement: Agent role classification
**Reason**: Global Pi-specific role classes cannot describe per-step multi-runtime profiles and workflow skills are removed.
**Migration**: Step declares required capabilities; selected profile and adapter enforce policy.

### Requirement: Extension exclusion
**Reason**: Exclusion remains Pi profile configuration, not cross-runtime workflow plugin behavior.
**Migration**: Move global/per-role exclusions into named Pi agent profiles and routes.

### Requirement: Plugin discoverability
**Reason**: `plugin` name is reserved for future workflow-definition plugins; current operations only manage Pi agent extensions.
**Migration**: Use `agentic-coding workflow agent-extension list|install|install-local`.

### Requirement: Backward compatibility
**Reason**: Command/config contract is intentionally breaking to remove ambiguous plugin and Pi role coupling.
**Migration**: Existing assignments are migrated into default Pi profile where unambiguous; otherwise configuration validation requests explicit profile.
