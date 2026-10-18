# stage-browser-sessions Specification

## Purpose
TBD - created by archiving change add-stage-testing-foundation. Update Purpose after archive.
## Requirements
### Requirement: Opening a stage-bound session
`browser_open` SHALL accept `stage`, `stageApp` and an optional `path` instead of `url` or `app`+`endpoint`. The server SHALL resolve the URL from the stage catalog and bind the session to that stage for its whole life. An unknown or excluded stage SHALL be refused with `stage-not-configured`, an unknown application key with `stage-app-unknown`. A stage-bound session SHALL NOT be re-bound to another stage (`stage-mismatch`). A raw `url` opened in a stage-bound session SHALL be refused with `origin-not-allowed` unless its origin is in the stage's allow-list. Sessions that are not stage-bound SHALL keep the existing open behaviour.

#### Scenario: Open a stage application
- **WHEN** an agent calls `browser_open({ stage: "grid-int", stageApp: "clerk", session: "clerk" })`
- **THEN** the session SHALL open the clerk application's configured URL and SHALL be bound to `grid-int`

#### Scenario: Excluded stage
- **WHEN** an agent opens a stage whose definition failed validation
- **THEN** the call SHALL be refused with `stage-not-configured` and no session SHALL be created

#### Scenario: Raw URL in a stage session
- **WHEN** an agent opens `https://elsewhere.example.org` in a session bound to `grid-int`
- **THEN** the call SHALL be refused with `origin-not-allowed`

### Requirement: Stage sessions stay on allow-listed origins
The allow-list of a stage SHALL be the origins of its application URLs together with its `allowedOrigins`. A stage-bound session SHALL abort every main-frame document navigation to an origin outside the allow-list, whatever triggered it (a tool, a script, a page redirect or a link), and the next tool result on that session SHALL report `origin-not-allowed` with the sanitized URL. Requests that are not main-frame navigations SHALL NOT be blocked by this guard.

#### Scenario: Page redirects off the allow-list
- **WHEN** a page in a stage session redirects the main frame to an origin outside the stage's allow-list
- **THEN** the navigation SHALL be aborted
- **AND** the next tool result on that session SHALL report `origin-not-allowed`

#### Scenario: Identity provider origin is allowed
- **WHEN** a stage declares its SSO origin in `allowedOrigins` and the application redirects there to log in
- **THEN** the navigation SHALL proceed

### Requirement: Read-only stages refuse state-changing requests
For a stage with `access: "read-only"` the session SHALL abort every request whose method is not GET, HEAD or OPTIONS unless a `readOnlyExceptions` entry matches its origin, path prefix and method, and the next tool result SHALL report `stage-read-only` with the sanitized URL and method.

#### Scenario: Form submit on a read-only stage
- **WHEN** a page in a session bound to a read-only stage sends a POST to an application endpoint not covered by an exception
- **THEN** the request SHALL be aborted and the next tool result SHALL report `stage-read-only`

#### Scenario: Login POST is an exception
- **WHEN** the stage declares a `readOnlyExceptions` entry for the identity provider's login path and the login form posts there
- **THEN** the request SHALL proceed

### Requirement: Stage session limits
The server SHALL bound stage use per workflow: at most `limits.maxSessions` concurrent stage-bound sessions per stage (within `browser.max_sessions`), and at most `limits.maxActionsPerMinute` browser tool calls on a stage's sessions per rolling minute, refusing excess calls with `stage-rate-limit` and a `retryAfterMs`. A stage with `exclusive: true` SHALL be leased to the first workflow that opens a session on it until that workflow's last stage session on it closes; another workflow's open SHALL be refused with `stage-held` naming the holder workflow. The lease SHALL be held in memory only.

#### Scenario: Rate limit
- **WHEN** a workflow issues more browser calls on a stage's sessions within one minute than `maxActionsPerMinute`
- **THEN** the excess call SHALL be refused with `stage-rate-limit` and a positive `retryAfterMs`

#### Scenario: Exclusive stage held
- **WHEN** workflow A has an open session on an exclusive stage and workflow B opens a session on it
- **THEN** B's call SHALL be refused with `stage-held` naming workflow A

### Requirement: Credential-safe login
The system SHALL offer `stage_login({ session, app, role })` for a stage-bound session. The server SHALL resolve the role's credential references at call time and run the role's declared login recipe — `form` (fill username and password located by label, role or selector, fill a TOTP code computed from the `totp` reference when declared, submit, and wait for the success condition within a bounded time) or `http-basic`. The result SHALL be `ok` with the sanitized landing URL, or a failure of `login-failed`, `login-mfa-required`, `credential-missing` (naming the variable) or `login-timeout`. `browser_fill` SHALL accept `credential: { app, role, field }` instead of `value` on a stage-bound session and fill the resolved value. Neither tool's arguments, results, errors, telemetry or logs SHALL contain a resolved credential. Both SHALL be refused with `recording-active` while the session records.

#### Scenario: Successful login
- **WHEN** an agent calls `stage_login({ session: "clerk", app: "clerk", role: "sachbearbeiter" })` and the recipe's success condition is met
- **THEN** the result SHALL be `ok` with the landing URL
- **AND** the result, the tool telemetry and the server log SHALL NOT contain the username or password value

#### Scenario: Missing credential variable
- **WHEN** the role's password variable is absent from `.env`
- **THEN** the result SHALL be `credential-missing` naming the variable and no form SHALL be filled

#### Scenario: Login while recording
- **WHEN** an agent calls `stage_login` on a session that is recording
- **THEN** the call SHALL be refused with `recording-active`

#### Scenario: Unsupported second factor
- **WHEN** the login page asks for a second factor the recipe does not provide
- **THEN** the result SHALL be `login-mfa-required` within the bounded wait

### Requirement: Login recipes cover no-auth, multi-page IdP forms and basic auth
A stage application SHALL be usable without any login when it declares no roles, SHALL support a `form` recipe made of an ordered list of steps (each step fills its fields, submits its control and may be marked optional for prompts that do not always appear) so a multi-page identity provider such as Microsoft Entra ID can be driven across the stage's allowed IdP origins, and SHALL support `http-basic` through the session's HTTP credentials. An optional step whose control is absent SHALL be skipped; a required step whose control is absent within the bounded wait SHALL fail the login with `login-step-not-found` naming the step index and no credential value.

#### Scenario: Application without authentication
- **WHEN** an agent opens a stage application that declares no roles
- **THEN** the session SHALL open without a login and `stage_login` SHALL answer `login-not-required`

#### Scenario: Multi-page identity provider
- **WHEN** a role's recipe has an identifier step, a password step and an optional "stay signed in" step on an allowed IdP origin
- **THEN** `stage_login` SHALL run the steps in order, skip the optional step when its control is absent, and answer `ok` with the sanitized landing URL on the application's origin

#### Scenario: Required step missing
- **WHEN** a required step's control does not appear within the bounded wait
- **THEN** the result SHALL be `login-step-not-found` naming the step index and SHALL NOT contain any credential value

### Requirement: Stage-session evidence and scripts cannot expose credentials
A screenshot of a stage-bound session SHALL mask every `input[type=password]` and every element a credential was filled into. On a stage-bound session the `browser_run_script` facade SHALL refuse `context.cookies`, `context.storageState` and `context.addCookies` with `stage-session-restricted`. A repro spec saved from a stage-bound session SHALL begin with a login preamble that reads the credential variable names from the process environment and SHALL NOT contain a resolved credential.

#### Scenario: Screenshot of a login form
- **WHEN** an agent takes a screenshot of a stage session whose username field was filled by `stage_login`
- **THEN** the username field and every password field SHALL be masked in the stored and returned image

#### Scenario: Script reads cookies
- **WHEN** a script on a stage-bound session calls `context.cookies()`
- **THEN** the script SHALL fail with `stage-session-restricted`

