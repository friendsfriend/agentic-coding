# Spec Delta

## Purpose

The developer reviews screenshots, videos and repro scripts produced by agents
directly from the workflow dashboard.

## ADDED Requirements

### Requirement: Evidence panel lists workflow evidence

The workflow dashboard SHALL show an evidence panel listing every manifest entry of the workflow with kind, caption, producing step or role and time, grouped by debug request when present, and SHALL offer no mutating action.

#### Scenario: Debug request evidence

- **WHEN** a workflow has evidence from two debug requests
- **THEN** the panel SHALL group the entries under each request

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
