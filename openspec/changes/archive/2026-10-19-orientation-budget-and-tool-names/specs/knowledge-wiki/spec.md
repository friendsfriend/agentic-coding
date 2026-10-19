## ADDED Requirements

### Requirement: The wiki role writes early and bounds its discovery

Both wiki instruction assets SHALL state a write budget — the discovery-based
brief for OpenSpec, implementation and ad-hoc documentation runs, and the
directive-first brief for research handoffs: the wiki role SHALL write or
update the first concept as soon as the discovery search has named a target or
the first directive's claim is corroborated, and SHALL extend that concept in
place as the remaining claims are verified, rather than reading further before
writing anything. The budget SHALL bound orientation only and SHALL NOT relax the
authoring contract: searching for related concepts before choosing a write path,
inspecting plausible candidates, updating the canonical existing identifier in
place, and preserving identifiers, unrelated content and unknown frontmatter
SHALL remain required, and the directive-first brief SHALL keep corroboration
targeted at the recorded directives.

#### Scenario: The discovery-based brief writes early

- **WHEN** the wiki assignment for an OpenSpec, implementation or ad-hoc task pins the discovery-based brief
- **THEN** the brief SHALL direct the role to write or update the first concept as soon as the search names a target and to extend it in place

#### Scenario: The directive-first brief bounds corroboration

- **WHEN** the wiki assignment for a research handoff pins the directive-first brief
- **THEN** the brief SHALL direct the role to write the first dictated concept early and to bound the remaining inspection to corroborating the recorded directives

#### Scenario: The update-first contract still holds

- **WHEN** either brief is rendered
- **THEN** it SHALL still require the search-then-inspect sequence, the in-place update of the canonical identifier and the preservation of unrelated content and unknown frontmatter
