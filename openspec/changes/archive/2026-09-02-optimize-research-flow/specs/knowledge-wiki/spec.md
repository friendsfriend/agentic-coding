## MODIFIED Requirements

### Requirement: Wiki authoring is isolated to the dedicated role
Managed workflow invocations SHALL permit wiki draft writes for the `wiki` role (openspec/implementation and wiki-only workflows, discovery-based drafting) and the dedicated `research-wiki` role (the research workflow's wiki drafting stage, directive-first drafting) only when executing an authenticated `core.wiki` run. The system SHALL reject wiki draft writes from researcher, planner, consolidator, fusion-planner, worker, triage, verifier, and archive roles. Neither wiki-writing role SHALL be able to set a stable status or supply a machine or human verification event. The existing administrative `wiki verify` operation MAY set `status: stable` with a `process:herdr-archive` machine verification event, but SHALL reject human or arbitrary actors. Human-reviewed promotion SHALL remain an engine-owned effect of developer approval.

#### Scenario: Dedicated wiki role is permitted to write
- **WHEN** `wiki write` runs with the managed `wiki` role or the managed `research-wiki` role
- **THEN** the concept is installed as an unverified draft

#### Scenario: Research wiki stage is permitted only after explicit request
- **WHEN** `wiki write` runs with an authenticated `research-wiki` role on `core.wiki` after the researcher dispatches a valid research-handoff command for an explicit user request
- **THEN** the concept is installed or updated as an unverified centralized draft
- **AND** the research workflow remains pending developer approval in `core.wiki-approval`

#### Scenario: Researcher cannot write implicitly or from another step
- **WHEN** a researcher or wiki write lacks an authenticated `core.wiki` capability or originates from another step
- **THEN** the operation exits non-zero and the bundle remains unchanged

#### Scenario: Planning and archive roles cannot write
- **WHEN** `wiki write` runs with a managed planner, consolidator, or archive role
- **THEN** the operation exits non-zero and the bundle remains unchanged

#### Scenario: Other implementation roles cannot write
- **WHEN** `wiki write` runs with a managed worker, triage, verifier, or fusion-planner role
- **THEN** the operation exits non-zero and the bundle remains unchanged

#### Scenario: Wiki role cannot self-verify
- **WHEN** the `wiki` or `research-wiki` role, or the `researcher` role, attempts to set stable status or provide a verification actor
- **THEN** the operation rejects the request or stores only a draft without verification

#### Scenario: Administrative process verification remains machine-confirmed
- **WHEN** an unmanaged administrator or archive role invokes `wiki verify` with a `process:` actor
- **THEN** the operation records that process verification and sets `status: stable` with machine-confirmed trust, without granting human-reviewed trust

#### Scenario: Human approval grants human-reviewed trust
- **WHEN** the developer approves reviewed wiki content through an applicable workflow gate
- **THEN** the engine-owned `wiki.verify` effect adds the human verification event and leaves the concept `status: stable` with human-reviewed trust
