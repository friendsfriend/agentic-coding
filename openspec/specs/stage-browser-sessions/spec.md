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

### Requirement: Login hand-off trigger

`stage_login({ session, app, role })` SHALL decide in this order:

1. While the session records, it SHALL be refused with `recording-active`, and no hand-off SHALL start.
2. When the session already lives in the interactive browser, the recipe declares a success condition and the effective mode is `local`, the silent SSO check SHALL run before anything else is attempted, and a condition that holds SHALL answer `ok` with `via: "existing-session"` and start no hand-off.
3. When the role's credential status is `set` and its recipe is automatable, the automated recipe SHALL run unchanged.
4. When the effective interactive-login mode is `local`, the server SHALL start a login hand-off in either of these cases:
   - `reason: "no-credentials"`: the role's credential status is `none` or `missing <VAR>`;
   - `reason: "unautomatable-step"`: the recipe is of kind `interactive`, or the automated recipe ended in `login-mfa-required`. In that case the headless attempt SHALL be discarded, and the hand-off SHALL restart from the application's login URL.
5. When the effective mode is `never`:
   - a missing variable SHALL answer `credential-missing` naming the variable;
   - a role with status `none` or an `interactive` recipe SHALL answer `login-user-unavailable`;
   - an MFA step SHALL answer `login-mfa-required`.
   No window SHALL open.

An `http-basic` role SHALL NOT hand off. The browser's own authentication dialog does not appear in a window this server launched (spike 0.2), so a hand-off could never be answered: such a role SHALL keep the foundation's results — `credential-missing` naming the missing variable, `login-user-unavailable`, and the automated `http-basic` recipe when its variables are set — under either policy, and no window SHALL open for it.

#### Scenario: Configured credentials keep the automated path

- **WHEN** every referenced variable of the role is set and its `form` recipe succeeds
- **THEN** the result SHALL be `ok` from the automated recipe, and no window SHALL open

#### Scenario: Missing credentials hand off under the local policy

- **WHEN** the role's password variable is absent and the effective mode is `local`
- **THEN** the result SHALL be `login-needs-user` with `reason: "no-credentials"`

#### Scenario: Missing credentials under the never policy

- **WHEN** the role's password variable is absent and the effective mode is `never`
- **THEN** the result SHALL be `credential-missing` naming the variable, and no window SHALL open

#### Scenario: Role without references under the never policy

- **WHEN** the role's credential status is `none` and the effective mode is `never`
- **THEN** the result SHALL be `login-user-unavailable`

#### Scenario: Unanswerable MFA hands off with a fresh login

- **WHEN** the automated recipe reaches a number-matching prompt and the effective mode is `local`
- **THEN** the result SHALL be `login-needs-user` with `reason: "unautomatable-step"`, and the hand-off context SHALL start at the application's login URL

#### Scenario: Recording session is refused

- **WHEN** `stage_login` is called on a session that is recording and the role has no credentials
- **THEN** the result SHALL be `recording-active`, and no hand-off SHALL start

### Requirement: Hand-off runs in the session's own interactive context

A login hand-off SHALL promote the session into the interactive browser. The server SHALL create a fresh context there, attach the stage's origin and read-only guards before the first navigation, open the application's login URL, and close the session's headless context. No cookies, storage or URL SHALL be carried over. After the hand-off, the agent SHALL continue in that same context. So cookies, localStorage and sessionStorage written during the login SHALL stay available to later agent actions. A session that already lives in the interactive browser SHALL NOT be promoted again.

#### Scenario: Agent continues with the developer's login

- **WHEN** the developer completes an Entra login in the window, and the app stores its tokens in sessionStorage
- **THEN** the next `browser_snapshot` of the session SHALL show the logged-in application without a further login

#### Scenario: Guards apply in the window

- **WHEN** the developer navigates the hand-off window to an origin outside the stage's allow-list
- **THEN** the navigation SHALL be blocked exactly as for an agent-driven session

### Requirement: Hand-off outcome contract

A started hand-off SHALL make `stage_login` return immediately with the non-terminal `login-needs-user`. That result SHALL carry `handoffId`, `stage`, `app`, `role`, `reason`, `state` (`queued` or `active`), `queuePosition` when queued, and `deadlineAt`. `stage_login_wait({ session, timeoutSec? })` SHALL block in the server for at most the smaller of the remaining deadline and 600 s. It SHALL return either the non-terminal shape again or exactly one terminal outcome:

- `ok`, with `via: "handoff"`, `verified`, and the landing URL as origin plus path;
- `login-handoff-unverified`;
- `login-handoff-timeout`;
- `login-handoff-aborted`, with `by` set to `developer`, `agent`, `window-closed` or `run-ended`.

When no headed-capable browser or no display exists, `stage_login` SHALL return `login-handoff-unavailable`. The server SHALL detect success by evaluating the recipe's success condition against the session's page about once per second, and only a boolean SHALL leave that check. A second `stage_login` on a session whose hand-off is pending SHALL return the pending `login-needs-user` and SHALL NOT start a second hand-off. No hand-off result SHALL contain page content, a credential, typed input, or a URL query or fragment.

#### Scenario: Success is detected without the developer confirming

- **WHEN** the developer logs in, and the recipe's success condition holds on the app origin
- **THEN** the pending `stage_login_wait` SHALL return `ok` with `verified: true` and the landing URL without its query or fragment

#### Scenario: Done without a success condition

- **WHEN** the role's recipe declares no success condition and the developer chooses Done
- **THEN** `stage_login_wait` SHALL return `ok` with `verified: false`

#### Scenario: Done before the login succeeded

- **WHEN** the developer chooses Done, but the declared success condition does not hold within 10 s
- **THEN** `stage_login_wait` SHALL return `login-handoff-unverified`

#### Scenario: Deadline passes

- **WHEN** the hand-off deadline passes before success or an answer
- **THEN** `stage_login_wait` SHALL return `login-handoff-timeout`, the window SHALL be closed, and the session SHALL be released from the hold

#### Scenario: Developer closes the window

- **WHEN** the developer closes the hand-off window
- **THEN** `stage_login_wait` SHALL return `login-handoff-aborted` with `by: "window-closed"`

#### Scenario: Run ends during the hand-off

- **WHEN** the owning run ends while its session is held
- **THEN** the hand-off SHALL end as `login-handoff-aborted` with `by: "run-ended"`, and the window SHALL be closed

### Requirement: Held session lock

While a hand-off is queued or active, the session SHALL be held by the user. Every agent route that reads or drives the session SHALL be refused with `session-held-by-user`, carrying the `handoffId` and `deadlineAt`. That covers:

- `browser_open` of that session;
- snapshot, click, fill, press, select, hover, wait, eval, console and network reads;
- screenshot, record start and record stop;
- script runs;
- the stage step and wait tools.

`browser_close` of a held session SHALL be allowed and SHALL abort the hand-off with `by: "agent"`. Refusals with `session-held-by-user` SHALL NOT count against `limits.maxActionsPerMinute`. At promotion, the session's console and network buffers SHALL be cleared, and events SHALL NOT be buffered while the session is held. Snapshot refs taken before the hand-off SHALL be invalid afterwards. A session listing SHALL report a held session with `heldByUser: true` and only the origin of its current URL.

#### Scenario: Agent cannot read the login page

- **WHEN** an agent calls `browser_snapshot` or `browser_screenshot` on a held session
- **THEN** the call SHALL be refused with `session-held-by-user`, and no page content SHALL be returned

#### Scenario: Hand-off network traffic is not readable later

- **WHEN** the IdP requests made during the hand-off carry a `login_hint` with the developer's account, and the agent calls `browser_network` after the hand-off
- **THEN** the result SHALL contain none of the requests made while the session was held

#### Scenario: Agent aborts by closing

- **WHEN** an agent calls `browser_close` on a held session
- **THEN** the hand-off SHALL end as `login-handoff-aborted` with `by: "agent"`, and the session's slot SHALL be released

### Requirement: Hand-off leaves no secret trace

No agent result, error, telemetry span, log line, evidence entry, journal entry, wiki content or report SHALL contain a value typed during a hand-off, page content from the hand-off, or a URL query or fragment observed during it. Telemetry and logs about a hand-off SHALL carry only stage, app, role, reason, state, outcome, queue time and duration. Interactive contexts SHALL use a temporary profile. The server SHALL NOT persist a held or promoted session's cookies or tokens to disk or to evidence.

#### Scenario: Leak check over a completed hand-off

- **WHEN** a hand-off completes in a test where the developer types a sentinel username and password, and the IdP redirect carries a sentinel `code` parameter
- **THEN** none of the sentinels SHALL appear in the agent results, the server logs, the exported telemetry or the workflow record

#### Scenario: No profile remains on disk

- **WHEN** a promoted session is closed
- **THEN** no browser profile or storage-state file for it SHALL remain under the configuration directory

### Requirement: Recording and evidence during a hand-off

A held session SHALL produce no video, poster, screenshot or saved script. Recording SHALL be allowed after the hand-off has ended. The recording context of a promoted session SHALL be created inside the interactive browser.

#### Scenario: Recording cannot start during a hand-off

- **WHEN** an agent calls `browser_record_start` on a held session
- **THEN** the call SHALL be refused with `session-held-by-user`, and no recording context SHALL be created

#### Scenario: Recording after the hand-off stays in the interactive browser

- **WHEN** an agent starts a recording on a promoted session after a successful hand-off
- **THEN** the recording context SHALL be created in the interactive browser, and the agent SHALL stay logged in

### Requirement: Hand-off window identity and focus

While the hand-off is active, the hand-off window SHALL show a non-interactive agentic-coding banner. The banner SHALL name the stage, application and role, and SHALL tell the developer that the agent waits and that closing the window aborts. The banner SHALL contain no controls and SHALL be removed when the hand-off ends, so no later agent snapshot or screenshot shows it. When a hand-off becomes active, the server SHALL bring its window to the front once. On macOS, it SHALL also activate the browser application, as a bounded best effort. The server SHALL NOT raise or minimize the window at any other time.

#### Scenario: Banner during hand-off only

- **WHEN** a hand-off becomes active and later ends with `ok`
- **THEN** the window SHALL show the banner while the hand-off is active, and the agent's next `browser_snapshot` SHALL NOT contain it

#### Scenario: Window is not raised by agent actions

- **WHEN** the agent clicks in a promoted session after the hand-off
- **THEN** the server SHALL NOT bring the window to the front

### Requirement: Hand-off queue, deadline and silent SSO reuse

At most one hand-off SHALL be active per server. Further hand-offs SHALL wait in FIFO order and report their queue position. The next window SHALL open only when the active hand-off ends. Each hand-off's deadline SHALL be its request time plus the stage's effective `maxLoginHandoffSeconds`, with queue time included. A held session SHALL keep its pool slot and count against `browser.max_sessions` and the stage's `maxSessions`. Each `stage_login_wait` call SHALL count as one stage action. Before starting a hand-off on a session that already lives in the interactive browser, the server SHALL do a silent check when the recipe declares a success condition: it SHALL open the application and wait up to 10 s for that condition. If the condition holds, the server SHALL return `ok` with `via: "existing-session"` and no hand-off. The hand-off and the silent check SHALL NOT copy login state from one session to another.

#### Scenario: Second hand-off waits its turn

- **WHEN** two sessions need a hand-off at the same time
- **THEN** the first SHALL be `active`, the second SHALL be `queued` with `queuePosition: 1`, and the second window SHALL open only after the first hand-off ends

#### Scenario: Queue time counts against the deadline

- **WHEN** a queued hand-off's deadline passes before it becomes active
- **THEN** it SHALL end as `login-handoff-timeout` without opening a window

#### Scenario: Second app on the same IdP

- **WHEN** a session that completed an Entra hand-off for the customer app calls `stage_login` for the clerk app on the same IdP, as the same role, and the clerk app's success condition holds within 10 s
- **THEN** the result SHALL be `ok` with `via: "existing-session"`, and no hand-off SHALL start

