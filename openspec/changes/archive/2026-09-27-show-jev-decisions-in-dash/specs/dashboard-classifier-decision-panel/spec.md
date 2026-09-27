# Spec Delta

## Purpose

Gives the workflow dashboard a focusable panel that lists the classifier
decisions of the displayed workflow and a scrollable detail view for the
selected decision, so a developer can see what the classifier was asked, what it
was offered, and what it actually decided.

## ADDED Requirements

### Requirement: Classifier decision panel lists the workflow's decisions

The workflow dashboard detail view SHALL render a Classifier panel in the
left column when the displayed workflow exposes at least one decision, and SHALL
render no Classifier panel when it exposes none. The panel SHALL present one row
per decision, oldest first, with the decision's integration, the question it
answered, and the result that was applied. The panel SHALL show a bounded number
of rows at a time while retaining every decision as a selectable row, and its
body SHALL NOT print keybinding instructions.

#### Scenario: One row per decision

- **WHEN** the workflow exposes three decision records
- **THEN** the Classifier panel SHALL show one row per record, oldest first
- **AND** each row SHALL name the decision's integration, question, and applied result

#### Scenario: Panel is absent without decisions

- **WHEN** the workflow exposes no decision records
- **THEN** the Classifier panel SHALL NOT be rendered
- **AND** the remaining detail panels SHALL be laid out as they are without it

#### Scenario: More decisions than visible rows

- **WHEN** the workflow exposes more decisions than the panel's visible rows
- **THEN** the panel SHALL show exactly its visible-row count
- **AND** decisions beyond the last visible row SHALL remain selectable

### Requirement: Focused Classifier panel supports decision-list navigation

When the Classifier panel is focused, unshifted `j`/`k` and `↑`/`↓` SHALL move
the decision selection one row in the requested direction within the complete
decision list without changing panel focus. The list SHALL scroll to keep the
selected decision visible, and the selection SHALL stay within the list when the
decision list shrinks.

#### Scenario: Navigate below the visible rows

- **WHEN** the focused Classifier panel has more decisions than visible rows and the user presses `j` or `↓` from the last visible row
- **THEN** the next decision SHALL become selected
- **AND** the list SHALL scroll so the selection is visible
- **AND** focus SHALL remain on the Classifier panel

#### Scenario: Navigate upward and stop at the first decision

- **WHEN** the focused Classifier panel's selection is below the first decision and the user presses `k` or `↑`
- **THEN** the preceding decision SHALL become selected
- **AND** pressing it again on the first decision SHALL leave the first decision selected

### Requirement: The selected decision opens a scrollable detail view

Activating the selected decision while the Classifier panel is focused SHALL open
a scrollable detail view for that decision. The detail view SHALL show the
decision's integration, question, classifier model, the options that were
offered with the model's answer for each, the result that was applied including
any attention note, and the classifier input. The classifier input SHALL be
shown as its own scrollable, verbatim section, and the detail view SHALL state
when the stored input was truncated. The detail view SHALL close back to the
dashboard without changing the decision selection.

#### Scenario: Detail view shows input, options, and result

- **WHEN** the user activates a decision in the focused Classifier panel
- **THEN** a scrollable detail view SHALL open for that decision
- **AND** it SHALL show the offered options, the model's answer, and the applied result
- **AND** it SHALL show the classifier input in its own verbatim section

#### Scenario: Truncated input is stated in the detail view

- **WHEN** the selected decision's classifier input was truncated when it was recorded
- **THEN** the detail view SHALL state that the input is truncated

#### Scenario: Fallback decision explains the result

- **WHEN** the selected decision was not applied and carries an attention note
- **THEN** the detail view SHALL show that the answer was not applied, the profiles that were kept, and the note

#### Scenario: Closing returns to the panel

- **WHEN** the decision detail view is closed
- **THEN** the Classifier panel SHALL still hold the same selected decision

### Requirement: The classifier decision binding is documented

The dashboard keybind catalog SHALL document the decision activation binding
with the Classifier panel as its context, so the footer shows it only while that
panel is focused, and the `?` help modal SHALL list it. The catalog SHALL NOT
document the binding while the Classifier panel is not rendered.

#### Scenario: Footer names the binding only while the panel is focused

- **WHEN** the Classifier panel is rendered
- **THEN** focusing it SHALL show the decision binding in the footer
- **AND** focusing another panel SHALL not

#### Scenario: Help lists the binding

- **WHEN** the `?` help modal is open in the detail view
- **THEN** it SHALL list the decision activation binding

#### Scenario: Unrendered panel is not advertised

- **WHEN** the Classifier panel is not rendered
- **THEN** the keybind catalog SHALL not contain its panel section
