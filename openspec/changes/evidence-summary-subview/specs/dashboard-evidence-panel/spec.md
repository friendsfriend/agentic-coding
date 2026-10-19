# Spec Delta

## MODIFIED Requirements

### Requirement: Evidence panel lists workflow evidence

The workflow dashboard SHALL show an evidence panel that summarises the workflow's manifest as one line of kind counts (for example `3 screenshots · 10 logs · 1 video`), covering every evidence kind, using singular and plural labels, omitting zero-count kinds, and SHALL offer no mutating action.

#### Scenario: Summary counts by kind

- **WHEN** a workflow attached two screenshots, one video and no trace
- **THEN** the panel SHALL show `2 screenshots · 1 video` and SHALL NOT mention traces or any zero-count kind

#### Scenario: Debug request evidence

- **WHEN** a workflow has evidence from two debug requests
- **THEN** the evidence subview's sidebar SHALL group the entries under each request

#### Scenario: A long manifest

- **WHEN** the workflow attached many entries
- **THEN** the panel's height SHALL stay at its title row plus one summary row and SHALL NOT grow with the manifest

#### Scenario: A read that did not succeed

- **WHEN** the manifest has not been read yet, or the read failed
- **THEN** the panel SHALL say so and SHALL NOT present the summary as "no evidence attached"

#### Scenario: Nothing attached

- **WHEN** the read succeeded with no entries
- **THEN** the panel SHALL show its neutral empty state and SHALL NOT show a summary line

### Requirement: Inline images when supported

When the renderer reports kitty graphics support, a screenshot cited by the run's report SHALL render inline in the report pane; otherwise the cited entry SHALL show its text and metadata fallback instead, and no image bytes SHALL be sent to the terminal.

#### Scenario: Terminal without kitty graphics

- **WHEN** the report cites a screenshot and the terminal does not support kitty graphics
- **THEN** the cited entry SHALL be shown as its caption, size and path text and no image escape sequences SHALL be written

#### Scenario: Cited screenshot with kitty graphics

- **WHEN** kitty graphics are supported and a cited screenshot's bytes have loaded
- **THEN** the report pane SHALL mount the image renderable for that entry beneath the block that cites it

### Requirement: External open

Pressing the open key on the focused evidence sidebar entry SHALL open that entry's stored file with the platform's system opener, and video SHALL always open externally.

#### Scenario: Open a video

- **WHEN** the developer opens a video entry from the sidebar
- **THEN** the WebM file SHALL be passed to the system opener

#### Scenario: The highlighted entry is the one acted on

- **WHEN** the sidebar lists several entries and the developer presses the open key on one of them
- **THEN** the file handed to the system opener SHALL be that highlighted entry's

#### Scenario: Copy the highlighted entry's path

- **WHEN** the developer presses the copy key in the evidence subview
- **THEN** the copied value SHALL be the focused sidebar entry's stored file path

## ADDED Requirements

### Requirement: Evidence panel opens the evidence subview

Pressing Enter while the Evidence panel is focused SHALL open the evidence subview as a page of the dashboard body, and Esc SHALL return to the panel grid with its keys.

#### Scenario: Enter opens the subview

- **WHEN** the Evidence panel is focused and the developer presses Enter
- **THEN** the evidence subview SHALL replace the panel grid and take the keyboard

#### Scenario: Esc returns to the grid

- **WHEN** the evidence subview is open and the developer presses Esc
- **THEN** the panel grid SHALL be shown again with its own keys

#### Scenario: No evidence at all

- **WHEN** the read succeeded with no entries and the developer presses Enter
- **THEN** the subview SHALL open with an empty sidebar and the left pane's short message, not an error

### Requirement: Evidence subview shows the report beside all evidence

The evidence subview SHALL render the workflow's optional markdown report in a left pane and a sidebar in a right pane that lists every manifest entry of the workflow, newest first and grouped by debug request, and every sidebar entry SHALL be openable.

#### Scenario: Report and full sidebar

- **WHEN** a run attached a report and five entries of which two are cited
- **THEN** the left pane SHALL render the report and the sidebar SHALL list all five entries, the three uncited ones included

#### Scenario: No report

- **WHEN** the workflow has evidence but no report entry
- **THEN** the left pane SHALL show a short neutral message and the sidebar SHALL list every entry and stay usable

#### Scenario: Report cannot be read

- **WHEN** the report entry is recorded but its file cannot be read
- **THEN** the left pane SHALL say so and the sidebar SHALL stay usable

### Requirement: Report citations resolve against the manifest

An evidence report SHALL cite evidence with the wiki's inline citation marker `[^<evidence-id>]`, and the report pane SHALL resolve each marker against the workflow's manifest, keeping the marker for a resolved id and rendering a citation to an id the manifest does not hold as a visibly broken marker that is also reported as unknown, never as a failure.

#### Scenario: Resolved citation

- **WHEN** the report cites an id the manifest holds
- **THEN** the report pane SHALL resolve it to that entry and list it, with the entry's kind and caption, in the report's sources section

#### Scenario: Unknown citation

- **WHEN** the report cites an id the manifest does not hold
- **THEN** that citation SHALL render as a visibly marked unknown and the rest of the report SHALL still render
