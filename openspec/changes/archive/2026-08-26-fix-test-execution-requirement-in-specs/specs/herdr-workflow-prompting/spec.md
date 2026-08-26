## MODIFIED Requirements

### Requirement: Every role has a role-specific prompt
The workflow SHALL render each run message from one common protocol Markdown, registered step instruction assets, and validated dynamic assignment rather than runtime-specific skill documents. Planning-role instructions SHALL distinguish focused, change-relevant validation that belongs in implementation tasks from the complete repository test suite owned by the automatically launched test-verifier.

#### Scenario: Role focus is explicit
- **WHEN** engine renders assignment
- **THEN** message SHALL name exact objective, interaction mode, scoped input, permission/check policy, output artifact/schema, allowed outcomes, and generic handoff
- **AND** verifier message SHALL include selected review scope from run assignment

#### Scenario: Prompt behavior is runtime independent
- **WHEN** same step routes to Pi, OpenCode, or OpenCode V2
- **THEN** semantic assignment content SHALL remain same
- **AND** adapter SHALL change only runtime launch/prompt transport details

#### Scenario: Chat visibility follows role
- **WHEN** assignment interaction mode is developer-dialogue
- **THEN** prompt SHALL permit visible discussion and blockers
- **WHEN** assignment interaction mode is silent
- **THEN** prompt SHALL require artifact-based handoff without chat summary

#### Scenario: Planner assigns focused validation only
- **WHEN** a planning role defines implementation tasks or required validation for an OpenSpec change
- **THEN** its instructions SHALL require focused checks that cover the changed behavior
- **AND** its instructions SHALL prohibit requiring the worker to run the complete repository test suite
- **AND** its instructions SHALL identify the complete suite as owned by the workflow test-verifier after implementation and selected verification runs complete

#### Scenario: Fusion planning preserves test ownership
- **WHEN** a fusion planner or consolidation role proposes or reconciles implementation validation for an OpenSpec change
- **THEN** the resulting plan SHALL preserve focused worker checks for changed behavior
- **AND** it SHALL not add a complete-suite worker task that duplicates the workflow test-verifier run
