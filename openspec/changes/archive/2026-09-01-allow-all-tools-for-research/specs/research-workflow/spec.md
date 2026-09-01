## MODIFIED Requirements

### Requirement: Researcher follows evidence-oriented web research behavior
The dedicated researcher instructions SHALL require use of only tools and extensions exposed by the selected runtime/profile, without requiring a specific browser, search engine, MCP server, provider, or new dependency. Every tool name and extension explicitly configured by the user for the selected research profile SHALL remain available to that runtime according to its own tool-loading semantics; research SHALL NOT apply an additional hard-coded tool-name allowlist. When web or external sources are used, the researcher SHALL identify source URLs, distinguish sourced facts from synthesis, and disclose uncertainty or conflicting evidence. For repository-context research, configured tools and extensions are user-trusted integrations, while the workflow's source-isolation guard remains authoritative and repository mutations SHALL still be rejected or blocked before the research result is accepted.

#### Scenario: Runtime tool availability is respected
- **WHEN** a research runtime exposes a configured web, browser, search, or other user-defined tool or extension
- **THEN** the researcher may use that configured integration within the runtime's declared permissions
- **AND** the workflow does not reject it merely because its name is absent from a built-in allowlist
- **AND** the workflow does not assume an unconfigured integration exists

#### Scenario: Configured research extensions are retained
- **WHEN** a user selects a research profile with configured runtime extensions that provide research tools
- **THEN** those extensions remain part of the research launch configuration for runtimes that support profile extensions
- **AND** the workflow does not silently remove them as a side effect of research read-only routing

#### Scenario: Research cites web evidence
- **WHEN** a response relies on web research
- **THEN** it identifies the relevant source URLs and labels conclusions that are synthesis rather than directly sourced facts

#### Scenario: Conflicting evidence is found
- **WHEN** credible sources disagree or evidence is incomplete
- **THEN** the researcher reports the conflict or uncertainty instead of presenting an unsupported conclusion as fact

#### Scenario: User-trusted integration mutates repository context
- **WHEN** a configured research tool or extension changes the supplied source repository
- **THEN** the workflow's source-isolation validation rejects or blocks the research result
- **AND** the source repository is not presented as unchanged or as a valid research result
