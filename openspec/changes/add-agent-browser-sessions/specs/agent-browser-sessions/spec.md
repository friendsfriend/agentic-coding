# Spec Delta

## Purpose

Durable agents drive a local headless browser against their environment
instances, step by step or by script, and keep screenshots, videos and repro
scripts as evidence.

## ADDED Requirements

### Requirement: Browser is an opt-in local install

The application SHALL NOT download a browser without an explicit Install action; it SHALL use a detected system Chrome or the installed Chromium, and browser tools SHALL report `browser-unavailable` when neither exists.

#### Scenario: Nothing installed

- **WHEN** an agent calls `browser_open` with no system Chrome and no installed Chromium
- **THEN** the tool SHALL fail with `browser-unavailable` and no download SHALL start

### Requirement: Sessions are pooled, isolated and bounded

Browser sessions SHALL be isolated browser contexts of one shared browser process, scoped to the durable run that opened them, capped by `browser.max_sessions` with FIFO queueing, and closed when the run ends or the session idles past its TTL.

#### Scenario: Two runs browse the same app

- **WHEN** two runs open sessions on the same URL
- **THEN** cookies and storage SHALL NOT be shared between them

### Requirement: Discrete browser tools

Every durable run SHALL be offered the browser tools; `browser_snapshot` SHALL return an accessibility tree with element refs that action tools accept, and `browser_open` SHALL resolve an app endpoint to the owner's instance.

#### Scenario: Click by ref

- **WHEN** an agent takes a snapshot and calls `browser_click` with a ref from it
- **THEN** the referenced element SHALL be clicked

### Requirement: Playwright script execution

`browser_run_script` SHALL execute Playwright JavaScript against the session page with a bounded timeout and, when `save` is set, SHALL store a rerunnable spec as `script` evidence.

#### Scenario: Script times out

- **WHEN** a script exceeds its timeout
- **THEN** the tool SHALL fail with `script-timeout` and the session SHALL stay usable

### Requirement: Evidence is kept by agent choice

Screenshots SHALL be returned to the model and stored as evidence only when requested; recorded videos SHALL be stored with a poster frame only when kept, and discarded otherwise.

#### Scenario: Recording discarded

- **WHEN** an agent stops a recording with `keep: false`
- **THEN** no video file SHALL remain and no evidence entry SHALL be created
