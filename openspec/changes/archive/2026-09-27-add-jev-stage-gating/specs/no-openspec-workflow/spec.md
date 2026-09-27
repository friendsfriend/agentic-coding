# Spec Delta

## MODIFIED Requirements

### Requirement: No-openspec documents through wiki before delivery
No-OpenSpec definition SHALL run a developer review gate after every passing verification round, and a developer approval or a review-gate skip SHALL proceed to the wiki gate when the definition is wiki-gated, or directly to delivery when it is not. A wiki gate run SHALL proceed through the wiki documentation step and wiki approval gate before delivery, and a wiki gate skip SHALL proceed to delivery. No-OpenSpec definition SHALL NOT include an OpenSpec archive step because no OpenSpec change exists to archive, and no gate step SHALL stand in front of delivery as its only path. The wiki approval `approve` outcome SHALL enqueue the engine-owned wiki human-verification effect when concepts were touched and advance to delivery; the `comments` outcome SHALL return the workflow to the wiki documentation step under a bounded loop. These wiki steps apply to the wiki-gated definition versions; legacy non-gated definition versions SHALL retain the prior archive-free, wiki-free path directly from developer review to delivery.

#### Scenario: Developer approves no-OpenSpec review
- **WHEN** developer-review action approves verified no-OpenSpec change under a wiki-gated definition version
- **THEN** definition SHALL enter the wiki gate rather than delivery
- **AND** no archive agent SHALL launch

#### Scenario: A skipped review gate still reaches the wiki gate
- **WHEN** the review gate of a wiki-gated no-OpenSpec definition reports a skip
- **THEN** the definition SHALL enter the wiki gate without offering the developer review actions
- **AND** no archive agent SHALL launch

#### Scenario: A skipped wiki gate reaches delivery
- **WHEN** the wiki gate of a no-OpenSpec definition reports a skip
- **THEN** the definition SHALL enter delivery directly
- **AND** neither the wiki documentation agent nor the wiki approval actions SHALL be offered

#### Scenario: Wiki approval advances to delivery
- **WHEN** the developer approves at the no-OpenSpec wiki approval gate
- **THEN** the engine SHALL promote touched concepts through the wiki human-verification effect and enter delivery to enqueue commit/push effects
- **AND** no archive step SHALL run

#### Scenario: Wiki comments return to documentation
- **WHEN** the developer submits comments at the no-OpenSpec wiki approval gate
- **THEN** the workflow SHALL return to the wiki documentation step under its bounded loop

#### Scenario: Delivery completes
- **WHEN** idempotent delivery confirms commit and push
- **THEN** workflow SHALL enter completed terminal step
