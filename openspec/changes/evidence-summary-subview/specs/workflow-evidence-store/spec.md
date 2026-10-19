# Spec Delta

## ADDED Requirements

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
