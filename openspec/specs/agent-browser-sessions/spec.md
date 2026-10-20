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

Browser sessions SHALL be isolated browser contexts, scoped to the durable run that opened them, capped by `browser.max_sessions` with FIFO queueing, and closed when the run ends or the session idles past its TTL. Every session SHALL start in one shared headless browser process. The only exception SHALL be a session promoted for a stage login hand-off: it SHALL live in a second, server-owned interactive (headed) browser process that the pool launches lazily on the first promotion and closes once it holds no session. A promoted session SHALL keep its id, owner, name and pool slot. It SHALL stay in the interactive browser for the rest of its life. Its storage SHALL never be shared with another context. A crash of either browser process SHALL mark only the sessions that process served as crashed. Each process SHALL be relaunched single-flight on next use. A session held by the developer for a hand-off SHALL be exempt from the idle TTL sweep until the hand-off ends.

#### Scenario: Two runs browse the same app

- **WHEN** two runs open sessions on the same URL
- **THEN** cookies and storage SHALL NOT be shared between them

#### Scenario: Ordinary sessions stay headless

- **WHEN** a run opens and drives sessions without a login hand-off
- **THEN** no interactive browser process SHALL be launched and no window SHALL appear

#### Scenario: Promotion keeps the session's identity and slot

- **WHEN** a session is promoted into the interactive browser for a hand-off
- **THEN** it SHALL keep its id, name, owner and pool slot, SHALL NOT take a second slot, and its previous headless context SHALL be closed

#### Scenario: Interactive browser closes when unused

- **WHEN** the last session living in the interactive browser is closed
- **THEN** the interactive browser process SHALL be closed

#### Scenario: Held session is not swept

- **WHEN** a session held for a hand-off has seen no agent request for longer than `browser.idle_ttl_minutes`
- **THEN** the idle sweep SHALL NOT close it, and the sweep SHALL apply again once the hand-off ends

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

### Requirement: Browser status reports headed capability

Browser status SHALL report `headed: true` only when the browser the server would launch can open a visible window. That covers a detected system Chrome or the full installed Chromium build of the expected revision. A `headless_shell` executable SHALL report `headed: false`. The opt-in install SHALL keep installing a headed-capable build and SHALL NOT request a shell-only install. A hand-off that would need a window SHALL be refused with `login-handoff-unavailable` in two cases: no headed-capable browser exists (`reason: "headless-only-browser"`, with the Settings → Browser → Install hint), or the platform has no display (`reason: "no-display"`). In neither case SHALL a launch be attempted.

#### Scenario: Shell-only browser cannot hand off

- **WHEN** the only resolvable browser is a `chromium_headless_shell` build and a hand-off is requested
- **THEN** the result SHALL be `login-handoff-unavailable` with `reason: "headless-only-browser"`, and no browser SHALL be launched

#### Scenario: Install keeps the headed build

- **WHEN** the opt-in install command is built
- **THEN** it SHALL NOT contain `--only-shell`

#### Scenario: Status reports headed capability

- **WHEN** Settings → Browser reads the status with system Chrome detected
- **THEN** the status SHALL report `headed: true`

### Requirement: Screenshots can be stored without being viewed
`browser_screenshot` SHALL accept `view: false` together with `evidence: true`; the screenshot SHALL be stored as evidence and the tool result SHALL name the evidence id and caption without returning the image. `view: false` without `evidence: true` SHALL be refused. On a stage-bound session, stored screenshots SHALL count against the stage's `limits.maxScreenshots` per workflow, and a screenshot beyond it SHALL be refused with `stage-screenshot-limit` without storing anything.

#### Scenario: Evidence without context cost
- **WHEN** an agent calls `browser_screenshot({ evidence: true, view: false, caption: "Request in clerk inbox" })`
- **THEN** the screenshot SHALL be stored and the result SHALL contain its evidence id and no image

#### Scenario: Screenshot cap
- **WHEN** a workflow has stored `maxScreenshots` screenshots on a stage and asks for another with `evidence: true`
- **THEN** the call SHALL be refused with `stage-screenshot-limit`

### Requirement: Recording keeps the session's sessionStorage
When a recording starts, the recording context SHALL receive the cookies and localStorage of the session (as today) and the sessionStorage of the current page's origin, installed before the current URL is re-opened, so an application that keeps its login in sessionStorage stays logged in.

#### Scenario: SPA login survives recording
- **WHEN** a session is logged in to an application that keeps its token in sessionStorage and the agent starts a recording
- **THEN** the re-opened page in the recording context SHALL be logged in

