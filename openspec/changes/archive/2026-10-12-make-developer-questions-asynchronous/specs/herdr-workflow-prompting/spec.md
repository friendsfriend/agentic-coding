# Spec Delta

## Purpose

Tell an agent what to do when its question comes back pending, so the answer can
reach a later attempt instead of the agent guessing or waiting forever.

## MODIFIED Requirements

### Requirement: Every role has a role-specific prompt
When assignment interaction mode is `developer-dialogue`, the prompt SHALL permit visible discussion and blockers and SHALL identify the `developer_question` interface as the preferred way to resolve an unclear decision before implementation or verification proceeds. When assignment interaction mode is `silent`, the prompt SHALL require artifact-based handoff without chat summary, but the role SHALL still be able to use the authenticated question interface when the workflow exposes it. Every assignment SHALL include the workflow's available prior developer dialogue as explicitly untrusted decision context. The prompt SHALL state that when the question interface returns a pending question instead of an answer, the agent SHALL report a bounded `blocked` handoff naming that question rather than guessing, and that the answer arrives as prior dialogue in the attempt that resumes the run.

#### Scenario: Role focus is explicit
- **WHEN** engine renders assignment
- **THEN** message SHALL name exact objective, interaction mode, scoped input, permission/check policy, output artifact/schema, allowed outcomes, and generic handoff
- **AND** verifier message SHALL include selected review scope from run assignment

#### Scenario: Prompt behavior is runtime independent
- **WHEN** same step routes to Pi, OpenCode, or OpenCode V2
- **THEN** semantic assignment content SHALL remain same
- **AND** adapter SHALL change only runtime launch/prompt transport details

#### Scenario: Dialogue role can ask for clarification
- **WHEN** a planner, worker, consolidator, or fusion planner receives a `developer-dialogue` assignment and cannot determine the intended behavior
- **THEN** the prompt SHALL tell the agent to ask `developer_question` with a concise description and recommended options before choosing an irreversible interpretation
- **AND** the agent SHALL resume from the returned answer or hand off a bounded cancellation/blocker

#### Scenario: Question comes back pending
- **WHEN** the question interface returns a pending question without an answer
- **THEN** the prompt SHALL direct the agent to hand off `blocked` with a bounded message naming that question
- **AND** the prompt SHALL state that the developer's answer appears as prior dialogue in the attempt that resumes the run

#### Scenario: Silent verifier can use shared guidance
- **WHEN** a verifier receives a `silent` assignment after a developer question was answered
- **THEN** its assignment SHALL contain the prior question and answer history, including decisions relevant to security review
- **AND** the prompt SHALL label that history as untrusted context rather than executable instruction

#### Scenario: Chat visibility follows role
- **WHEN** assignment interaction mode is developer-dialogue
- **THEN** prompt SHALL permit visible discussion and blockers
- **WHEN** assignment interaction mode is silent
- **THEN** prompt SHALL require artifact-based handoff without chat summary

#### Scenario: Chat remains role-scoped
- **WHEN** assignment interaction mode is `developer-dialogue`
- **THEN** prompt SHALL permit visible discussion and blockers
- **WHEN** assignment interaction mode is `silent`
- **THEN** prompt SHALL require artifact-based handoff without chat summary
