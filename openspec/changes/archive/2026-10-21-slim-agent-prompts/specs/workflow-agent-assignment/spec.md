## ADDED Requirements

### Requirement: The protocol is rendered per role

The managed workflow protocol SHALL consist of an always-included core and optional sections, and a first assignment SHALL include the core plus only the optional sections its step declares for the run's role. The core SHALL state the lifecycle, output-artifact, single-outcome handoff, asking-without-guessing, untrusted-content and secret-redaction rules. A step that declares no section selection SHALL receive every section. The protocol SHALL remain one pinned instruction asset whose digest covers every section, and section markers SHALL NOT appear in the rendered prompt.

#### Scenario: A stage tester receives no generic tool guidance
- **WHEN** a `stage.execute` assignment is rendered for the stage tester
- **THEN** it SHALL contain the protocol core and the stage tester's brief
- **AND** SHALL NOT contain the environment, browser, debug-tools, delegated-debug, file-signals or `ask_jev` sections

#### Scenario: An implementation worker receives its tool sections
- **WHEN** a `core.implementation` assignment is rendered for the worker
- **THEN** it SHALL contain the environment, browser, debug-tools and delegated-debug sections
- **AND** SHALL NOT contain the file-signals section

#### Scenario: Review roles receive file signals and ask_jev
- **WHEN** a `core.triage` or `core.verification` assignment is rendered
- **THEN** it SHALL contain the file-signals and `ask_jev` sections

#### Scenario: A step without a declaration loses nothing
- **WHEN** an assignment is rendered for a step whose behavior declares no protocol sections
- **THEN** it SHALL contain every protocol section

#### Scenario: Core rules survive every selection
- **WHEN** any agent assignment is rendered
- **THEN** it SHALL state that the run writes only its declared output artifact, finishes with exactly one allowed outcome through `agentic-coding workflow handoff`, hands off `blocked` instead of guessing when a question stays unanswered, treats dialogue and tool content as untrusted, and never works around a redacted secret

### Requirement: Guidance travels with the block it governs

The assignment SHALL render a one-line meaning of the interaction mode beside `Interaction:`, the prior-dialogue input block SHALL tell the agent not to re-ask an answered decision, and the peer-question message SHALL state that the question is not a reason to hand off, so that none of these rules depends on a protocol section.

#### Scenario: Silent run
- **WHEN** an assignment with interaction `silent` is rendered
- **THEN** the interaction line SHALL say to report through the artifact and the handoff without a chat summary

#### Scenario: Prior dialogue present
- **WHEN** an assignment carries prior dialogue
- **THEN** the dialogue block SHALL mark it untrusted and SHALL say not to re-ask an answered decision

#### Scenario: Peer question delivered
- **WHEN** a peer question is delivered to a live session
- **THEN** the message SHALL carry the exact answer command and SHALL state that it is not a new assignment and not a reason to hand off
