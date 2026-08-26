# tui-input-responsiveness Specification

## Purpose
TBD - created by archiving change check-tui-freezing. Update Purpose after archive.
## Requirements
### Requirement: Wizard text input has one editing owner
The new-workflow wizard SHALL route insertion, deletion, cursor movement, and paste for the focused Change ID and other single-line fields through the focused OpenTUI input exactly once, without replaying the same key through a modal handler. The focused field and its summary value SHALL update promptly for rapid typing, without waiting on workflow-start work.

#### Scenario: Rapid Change ID entry remains responsive
- **WHEN** the user types a sequence of Change ID characters rapidly while the Change ID input is focused
- **THEN** each character SHALL appear in the focused input during the next rendered updates
- **AND** the corresponding Change ID summary value SHALL contain the same sequence exactly once
- **AND** no workflow completion callback SHALL run before the user confirms the wizard

#### Scenario: Single-line field editing is not duplicated
- **WHEN** the user types, deletes, moves the cursor, or pastes text in a focused single-line wizard field
- **THEN** the editor SHALL apply each editing operation once
- **AND** the rendered field value and summary SHALL remain equal after the operation

### Requirement: Task textarea stays synchronized and visible
The task step SHALL use the focused OpenTUI textarea as the source of displayed text while synchronously mirroring its content into the wizard state used by the summary and final submission. Updating the summary SHALL NOT replace or blank the textarea's internal edit buffer on each keystroke.

#### Scenario: Task text is visible while typing
- **WHEN** the user types task text while the task textarea is focused
- **THEN** the typed text SHALL be visible in the textarea without a multi-second input delay
- **AND** the task entry in the summary SHALL show the same text

#### Scenario: Multiline task text is preserved
- **WHEN** the user inserts a newline and continues typing in the task textarea
- **THEN** the textarea SHALL display both lines
- **AND** the summary SHALL preserve the newline and both lines in the same order

#### Scenario: Final task text is submitted unchanged
- **WHEN** the user advances from the task step after entering multiline text
- **THEN** the wizard SHALL submit the exact textarea content, including newlines, once
- **AND** the task editor SHALL not contribute duplicated characters or stale content

### Requirement: Wizard controls remain distinct from text editing
The wizard SHALL preserve its existing navigation and transition semantics while ensuring a text-editing key cannot both edit the focused field and execute a second modal edit operation. Plain Enter in the task textarea SHALL insert a newline, while the existing Alt+Enter action SHALL advance once to the next step. Enter in a single-line field SHALL advance once, and Escape SHALL retain its existing back/cancel behavior.

#### Scenario: Task newline does not advance
- **WHEN** the user presses plain Enter in the focused task textarea
- **THEN** a newline SHALL be inserted in the task
- **AND** the wizard SHALL remain on the task step

#### Scenario: Alt+Enter advances the task step once
- **WHEN** the user presses Alt+Enter in the task textarea
- **THEN** the wizard SHALL advance once to the next step
- **AND** the task value SHALL include all text entered before the transition

#### Scenario: Single-line Enter advances once
- **WHEN** the user presses Enter in a focused single-line wizard field
- **THEN** the wizard SHALL advance once with the current field value
- **AND** the field value SHALL not be duplicated or lost

### Requirement: Input regressions are covered at the renderer boundary
Automated tests SHALL exercise the OpenTUI renderer's focused-input path for both a single-line field and the task textarea, and SHALL verify rendered editor content, synchronized summary content, exact submitted values, and responsive step transitions. Existing list selection, filter, cancellation, and workflow creation behavior SHALL remain covered.

#### Scenario: Renderer test covers Change ID and task independently
- **WHEN** the focused renderer test enters a Change ID and a multiline task through mock input events
- **THEN** the test SHALL assert the field/editor frames and summary before advancing
- **AND** the test SHALL assert the final `onComplete` payload contains the exact Change ID and task values

#### Scenario: Renderer test distinguishes input from creation work
- **WHEN** the renderer test types into a wizard field while the completion callback is unresolved
- **THEN** input and rendering SHALL continue to settle before confirmation
- **AND** the creation progress behavior SHALL begin only after confirmation and remain unchanged while the callback is in flight

