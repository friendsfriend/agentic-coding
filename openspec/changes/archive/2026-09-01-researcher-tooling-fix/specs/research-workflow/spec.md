## MODIFIED Requirements

### Requirement: Researcher follows evidence-oriented web research behavior
The dedicated researcher instructions SHALL require use of only tools and extensions exposed by the selected runtime/profile, without requiring a specific browser, search engine, MCP server, provider, or new dependency. Research launches SHALL NOT apply an application-level tool-name allowlist or denylist beyond the selected runtime's own default agent-launch semantics; the researcher's runtime SHALL expose the same built-in, extension, and custom tools it would expose to any other agent launched on that profile, so no operator-supplied tool or extension is dropped merely for lacking a matching name in a configuration list, and no built-in tool is withheld by a research-specific tool-name filter. When web or external sources are used, the researcher SHALL identify source URLs, distinguish sourced facts from synthesis, and disclose uncertainty or conflicting evidence. For repository-context research, configured tools and extensions are user-trusted integrations exposed exactly as they would be to any agent, while the workflow's source-isolation guard remains authoritative and repository mutations SHALL still be rejected or blocked before the research result is accepted.

#### Scenario: Runtime tool availability is respected
- **WHEN** a research runtime exposes any built-in, extension, or custom tool for the selected profile
- **THEN** the researcher may use that tool exactly as it would be available to any other agent launched on the same runtime/profile
- **AND** the workflow does not withhold the tool because its name is absent from an allowlist or matched by a research-specific tool restriction
- **AND** the workflow does not assume an unconfigured integration exists

#### Scenario: Configured research extensions are retained
- **WHEN** a user selects a research profile with configured runtime extensions that provide research tools
- **THEN** those extensions remain part of the research launch configuration for runtimes that support profile extensions
- **AND** the workflow does not silently remove them as a side effect of research read-only routing

#### Scenario: Mutating built-in tools remain available like any other agent
- **WHEN** the selected runtime/profile would normally expose file-editing or shell tools to an agent
- **THEN** the researcher launch also exposes those tools rather than filtering them out by name
- **AND** the read-only repository boundary and source-isolation validation, not tool-name gating, remain the mechanism that rejects or blocks an accepted repository mutation

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
