# workflow-evidence-store Specification

## Purpose
Durable, captioned, bounded storage of debugging evidence (screenshots, videos,
traces, repro scripts, logs) per workflow and per debug request.
## Requirements
### Requirement: Evidence is stored with a manifest

Every evidence entry SHALL be stored under the workflow's evidence directory (and the debug request's subdirectory when produced for one) and recorded in an atomically written manifest with id, kind, file, caption, creation time, step and role.

#### Scenario: Screenshot attached

- **WHEN** a screenshot is attached with a caption
- **THEN** the manifest SHALL list it with kind `screenshot`, the caption and the producing step

### Requirement: Attach is path-safe and content-checked

Agent-attached files SHALL resolve inside the run's worktree or scratch directory, and the file content SHALL match the declared kind; otherwise the attach SHALL be refused.

#### Scenario: Path outside the worktree

- **WHEN** an agent attaches `/etc/passwd` or a symlink pointing outside its worktree
- **THEN** the attach SHALL be refused and nothing SHALL be stored

### Requirement: Caps refuse and never evict

Evidence over the per-file or per-workflow cap SHALL be refused with `evidence-quota`; existing evidence SHALL NOT be deleted to make room.

#### Scenario: Workflow quota reached

- **WHEN** an attach would exceed the per-workflow cap
- **THEN** it SHALL fail with `evidence-quota` and all earlier entries SHALL remain

### Requirement: Evidence lifecycle follows the workflow

Evidence SHALL be observable through an `evidence` observation and SHALL be deleted when the workflow's workspace is cleaned up.

#### Scenario: Workflow deleted

- **WHEN** a workflow is deleted
- **THEN** its evidence directory SHALL be removed

### Requirement: A report may be attached with the evidence

An evidence attach MAY flag its entry as the workflow's report. The flag SHALL be recorded on that manifest entry, SHALL require markdown text content, SHALL NOT change the entry's id, kind or stored path, and reading a workflow SHALL treat the newest flagged entry as its report while a manifest with no flagged entry SHALL read exactly as before.

#### Scenario: A report is attached

- **WHEN** a run attaches a markdown file with the report flag
- **THEN** the manifest SHALL hold one entry carrying the flag and its stored file SHALL stay inside the workflow's evidence root under the store's own name rule

#### Scenario: A manifest written before the flag

- **WHEN** a manifest with no flagged entry is read
- **THEN** every entry SHALL read unchanged and the workflow SHALL simply have no report

#### Scenario: Content that is not markdown text

- **WHEN** the report flag is set on a file that is not markdown text
- **THEN** the attach SHALL be refused and nothing SHALL be stored

