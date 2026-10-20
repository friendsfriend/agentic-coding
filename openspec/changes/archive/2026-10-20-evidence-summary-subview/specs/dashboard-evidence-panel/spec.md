# Spec Delta

## RENAMED Requirements

- FROM: `### Requirement: Flow grouping in the evidence panel`
- TO: `### Requirement: Flow grouping in the evidence subview sidebar`

## MODIFIED Requirements

### Requirement: Evidence panel lists workflow evidence

The workflow dashboard SHALL show an evidence panel that summarises the workflow's manifest as one line of kind counts (for example `3 screenshots · 10 logs · 1 video`), covering every evidence kind, using singular and plural labels and omitting zero-count kinds, SHALL mark the row when the run attached a report and when it recorded a stage flow, and SHALL offer no mutating action.

#### Scenario: Summary counts by kind

- **WHEN** a workflow attached two screenshots, one video and no trace
- **THEN** the panel SHALL show `2 screenshots · 1 video` and SHALL NOT mention traces or any zero-count kind

#### Scenario: Report and flow markers

- **WHEN** the run attached a report and recorded a stage flow
- **THEN** the panel's row SHALL carry a `report` marker and a `flow` marker beside the kind counts

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
- **THEN** the panel SHALL show its neutral empty state, SHALL NOT show a summary line, and SHALL still open the evidence subview on Enter

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

### Requirement: Flow grouping in the evidence subview sidebar

When a workflow has a stage step journal, the evidence subview's sidebar SHALL group its entries by flow segment in journal order, show under each segment the journal steps that referenced it with their label, application, role and `mm:ss` offset, and list rows referenced by no segment in a trailing group. The subview SHALL offer an action that opens the workflow's `stage-flow.html` with the system opener, declared in the subview's keybind catalog and listed in its `?` help; opening the workflow's journal step row and pressing the open key SHALL open that page as well. Workflows without a journal SHALL keep the debug-request grouping and SHALL NOT offer the open-flow action, and the action SHALL be unavailable (reporting that the workflow has no flow page) rather than opening a stale one.

#### Scenario: Grouped flow

- **WHEN** the selected workflow has a journal with two kept segments
- **THEN** the subview sidebar SHALL show two segment groups with their steps and offsets, followed by unreferenced rows

#### Scenario: Open the flow page

- **WHEN** the developer triggers the open-flow action in the evidence subview
- **THEN** the system opener SHALL be invoked with the workflow's `stage-flow.html`

#### Scenario: Open the flow page from a step row

- **WHEN** the developer presses the open key on a journal step row
- **THEN** the system opener SHALL be invoked with the workflow's `stage-flow.html`, because a step names no file of its own

#### Scenario: Workflow without journal

- **WHEN** the selected workflow has no journal
- **THEN** the subview sidebar SHALL group by debug request and SHALL NOT advertise the open-flow action

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

The evidence subview SHALL render the workflow's optional markdown report in a left pane and a sidebar in a right pane that lists every manifest entry of the workflow, newest first and grouped by debug request — or by flow segment when the workflow has a stage step journal — and every sidebar entry SHALL be openable. The sidebar SHALL show the read state when it has no rows to list: a manifest read in flight, a read that failed with its reason, and a read that succeeded with nothing attached SHALL be three distinguishable lines, not one blank pane.

#### Scenario: The sidebar states an empty or unfinished read

- **WHEN** the subview is open and the manifest read is in flight, failed, or succeeded with no entries
- **THEN** the sidebar SHALL say `Loading evidence…`, name the read's failure, or say `No evidence attached yet` respectively, and SHALL NOT show an entry count

#### Scenario: Row actions with nothing to act on

- **WHEN** the developer presses the open or copy key and the sidebar has no row
- **THEN** the page SHALL report that no evidence is selected instead of silently ignoring the key

#### Scenario: Report and full sidebar

- **WHEN** a run attached a report and five entries of which two are cited
- **THEN** the left pane SHALL render the report and the sidebar SHALL list all five entries, the three uncited ones included

#### Scenario: No report

- **WHEN** the workflow has evidence but no report entry
- **THEN** the left pane SHALL show a short neutral message and the sidebar SHALL list every entry and stay usable

#### Scenario: Report cannot be read

- **WHEN** the report entry is recorded but its file cannot be read
- **THEN** the left pane SHALL say so and the sidebar SHALL stay usable

#### Scenario: Flow grouping keeps the sidebar

- **WHEN** the workflow recorded a stage flow and the subview is open
- **THEN** the sidebar SHALL group by flow segment in journal order and list the journal steps between the entries they produced

### Requirement: Report citations resolve against the manifest

An evidence report SHALL cite evidence with the wiki's inline citation marker `[^<evidence-id>]`, and the report pane SHALL resolve each marker against the workflow's manifest, keeping the marker for a resolved id and rendering a citation to an id the manifest does not hold as a visibly broken marker that is also reported as unknown, never as a failure. When several entries carry the report flag, the workflow's report SHALL be the flagged entry with the greatest id: the store writes the flag inside its serialized attach and its ids sort into creation order, so the most recently attached report wins without mutating the manifest. Control characters in the report body SHALL be folded out before it is rendered, so a report written by another process can never paint escape sequences into the terminal; line structure (newline, carriage return, tab) SHALL survive.

#### Scenario: A rewritten report

- **WHEN** a run attaches a second flagged report
- **THEN** the report pane SHALL render the newer entry and the older one SHALL stay an ordinary listed entry

#### Scenario: A report body with control characters

- **WHEN** the recorded markdown contains control bytes such as an escape sequence
- **THEN** the report pane SHALL render the text without them and SHALL keep its headings, prose and block structure

#### Scenario: Resolved citation

- **WHEN** the report cites an id the manifest holds
- **THEN** the report pane SHALL resolve it to that entry and list it, with the entry's kind and caption, in the report's sources section

#### Scenario: Unknown citation

- **WHEN** the report cites an id the manifest does not hold
- **THEN** that citation SHALL render as a visibly marked unknown and the rest of the report SHALL still render
