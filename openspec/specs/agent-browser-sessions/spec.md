# agent-browser-sessions Specification

## Purpose
TBD - created by archiving change add-agent-browser-sessions. Update Purpose after archive.
## Requirements
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

Every durable run SHALL be offered the browser tools; `browser_snapshot` SHALL return an accessibility tree with element refs that action tools accept, and `browser_open` SHALL resolve an app endpoint only when the calling workflow holds that app, otherwise failing with `app-not-held` naming the holder.

#### Scenario: Click by ref

- **WHEN** an agent takes a snapshot and calls `browser_click` with a ref from it
- **THEN** the referenced element SHALL be clicked

#### Scenario: App held by another workflow

- **WHEN** an agent opens the `customer-fe` endpoint while another workflow holds `customer-fe`
- **THEN** `browser_open` SHALL fail with `app-not-held` naming the holding workflow

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

### Requirement: The browser is the server's own, not a configured service

The browser tools SHALL drive one browser owned by the workflow server process — a system Chrome or a Chromium installed under the configuration, launched locally through Playwright — and SHALL NOT depend on a configured `playwright-server` infrastructure service or any remote browser endpoint.

#### Scenario: No configured browser service

- **WHEN** a workflow with no `playwright-server` infrastructure opens a session
- **THEN** `browser_open` SHALL launch the server's own browser and the tool description SHALL say so

### Requirement: A scripted page reports the surface it supports

`browser_run_script` SHALL hand the script an allow-list facade of the session's page and context, SHALL fail an unknown method with a message naming the supported ones, and SHALL state the supported page, context and locator operations in the tool description. Results that would reach another session or the shared browser SHALL be refused.

#### Scenario: An unsupported method

- **WHEN** a script calls a page method outside the allow-list
- **THEN** the call SHALL fail with a message that names the method and lists the supported ones

### Requirement: Browser tool outputs carry no declared secret
Every browser route response returned to an agent — open, snapshot, action, wait, eval, console, network, screenshot metadata, recording, script result and every error message — SHALL pass through the shared environment redactor (every non-empty value of the configuration root `.env`, plus the resolved credentials and their URL-encoded forms for a stage-bound session) before it leaves the server. Every URL in such a response SHALL have the values of token-like query and fragment parameters (`token`, `access_token`, `id_token`, `refresh_token`, `code`, `state`, `session`, `sid`, `sig`, `signature`, `password`, `secret`, `key`, `auth`, case-insensitive) replaced by a redaction marker. This SHALL apply to every session, whether stage-bound or not.

#### Scenario: Secret in page text
- **WHEN** a page renders a string equal to a `.env` value and an agent calls `browser_snapshot`
- **THEN** the snapshot SHALL contain a redaction marker instead of the value

#### Scenario: Token in a URL
- **WHEN** a session lands on `https://app.example.com/callback#access_token=abc123&state=xyz`
- **THEN** the URL in the tool result SHALL NOT contain `abc123` or `xyz`

#### Scenario: Eval returns an input value
- **WHEN** an agent evaluates JavaScript that returns the value of a field filled by `stage_login`
- **THEN** the result SHALL contain a redaction marker instead of the credential

