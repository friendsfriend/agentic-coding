# dashboard-evidence-panel Specification

## Purpose
TBD - created by archiving change add-dashboard-evidence-panel. Update Purpose after archive.
## Requirements
### Requirement: Evidence panel lists workflow evidence

The workflow dashboard SHALL show an evidence panel listing every manifest entry of the workflow with kind, caption, producing step or role and time, grouped by debug request when present, and SHALL offer no mutating action.

#### Scenario: Debug request evidence

- **WHEN** a workflow has evidence from two debug requests
- **THEN** the panel SHALL group the entries under each request

#### Scenario: A read that did not succeed

- **WHEN** the manifest has not been read yet, or the read failed
- **THEN** the panel SHALL say so and SHALL NOT present the listing as empty

### Requirement: Inline images when supported

When the renderer reports kitty graphics support, the selected screenshot or video poster SHALL render inline; otherwise the preview SHALL show metadata only.

#### Scenario: Terminal without kitty graphics

- **WHEN** the panel runs in a terminal without kitty graphics support
- **THEN** no image escape sequences SHALL be written and metadata SHALL be shown

### Requirement: External open

Pressing the open key on an entry SHALL open its file with the platform's system opener, and video SHALL always open externally.

#### Scenario: Open a video

- **WHEN** the developer opens a video entry
- **THEN** the WebM file SHALL be passed to the system opener

#### Scenario: The highlighted entry is the one acted on

- **WHEN** the panel lists several entries and the developer presses the open key on one of them
- **THEN** the file handed to the system opener SHALL be that highlighted entry's

#### Scenario: Copy the highlighted entry's path

- **WHEN** the developer presses the copy key on the panel
- **THEN** the copied value SHALL be the highlighted entry's stored file path

