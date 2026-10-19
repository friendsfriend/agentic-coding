## MODIFIED Requirements

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

## ADDED Requirements

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
