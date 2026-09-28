## MODIFIED Requirements

### Requirement: Every completed classification pass exports one decision record

The system SHALL export exactly one `routing.classified` event per completed
classifier routing pass on the engine telemetry layer. The event SHALL identify
the workflow, the routing step that issued the pass, the pass phase (`plan` or
`apply`), and the effect id, and SHALL report, for every step the pass asked:
the label the classifier selected, the reported confidence, whether that step
fell back to a pool's tagged default, and the model profile(s) pinned for the
step by that pass. A step SHALL be reported as a fallback only when the pass
applied the tagged default because the answer carried no usable choice, so a
below-floor confidence that is applied is not a fallback. A field the classifier
or the pass did not produce SHALL be omitted rather than reported as a
placeholder, and the event SHALL report the pass's fallbacks as a count so a
silently defaulted pass is visible in one row.

#### Scenario: Single-selection pass records the applied profile

- **WHEN** a plan-phase pass asks `core.plan` and the classifier answers with the
  label `high-cost-smart`
- **THEN** the `routing.classified` event SHALL report step `core.plan` with that
  label, its reported confidence, no fallback, and the model profile pinned for
  `core.plan`
- **AND** the event SHALL report the phase `plan` and the pass's effect id

#### Scenario: Below-floor confidence is applied, not a fallback

- **WHEN** the classifier answers `core.plan` with a chosen label at a
  confidence below 0.5
- **THEN** the `routing.classified` event SHALL report that label and confidence
  and SHALL NOT mark `core.plan` as a fallback
- **AND** it SHALL report the profile the pass pinned from that answer

#### Scenario: Roster pass records the selected planner set

- **WHEN** a pass asks a roster step and the classifier's probabilities select
  three distinct planner profiles
- **THEN** the `routing.classified` event SHALL report that step's selected count
  of 3 and the profiles pinned for the roster roles

#### Scenario: Answer-free pass still exports a record

- **WHEN** a step's answer collapses to a `noul` answer because the provider
  returned no usable decision for it
- **THEN** the `routing.classified` event SHALL still report that step and its
  applied profile and fallback flag
- **AND** it SHALL omit the label and confidence it never received

#### Scenario: Pass that never completed exports no decision record

- **WHEN** the classifier call fails, times out, or the pass is retried
- **THEN** no `routing.classified` event SHALL be exported for that attempt
- **AND** the failure SHALL remain observable through the pass's provider-call
  response event
