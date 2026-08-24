## Purpose

Lets users open a verifier's results directly from the dash Agents panel: pressing `v` on a verification agent immediately shows its findings or verdict report, with no intermediate verification overview step.

## ADDED Requirements

### Requirement: Direct verifier result popup on Agents panel
The workflow dash SHALL open the selected verification agent's result popup directly when the user presses `v` while the Agents panel is focused on an agent whose role is a verification role. The popup SHALL show committed verifier findings when available, otherwise the verifier's report content.

#### Scenario: Findings exist for the selected verifier
- **WHEN** `v` is pressed on a focused verification agent that has committed verifier findings
- **THEN** the findings popup opens immediately showing those findings
- **AND** no intermediate verification overview or timeline modal is shown first

#### Scenario: No committed findings for the selected verifier
- **WHEN** `v` is pressed on a focused verification agent that has no committed verifier findings
- **THEN** the verdict popup opens directly showing the verifier's report content
- **AND** no intermediate verification overview or timeline modal is shown first

### Requirement: Result access restricted to verification agents
The `v` binding SHALL be effective only when the focused agent is a verification agent. For any non-verification agent, pressing `v` SHALL NOT open any popup and SHALL NOT surface an error or hint message.

#### Scenario: Pressing v on a non-verification agent
- **WHEN** `v` is pressed while the Agents panel focuses an agent whose role is not a verification role
- **THEN** no popup opens and no message about verifier selection is displayed

### Requirement: No verification overview surface
The workflow dash SHALL NOT render a standalone Verification overview panel among its overview panels and SHALL NOT provide a keybinding path to a verification timeline modal.

#### Scenario: Overview panels exclude verification summary
- **WHEN** the workflow dash overview is rendered
- **THEN** no panel titled "Verification" summarizing run/pass/fail counts is present
- **AND** panel cycling never focuses such a panel

#### Scenario: Enter cannot open a verification overview
- **WHEN** Enter is pressed on each focusable overview panel
- **THEN** none of them opens a verification timeline modal
