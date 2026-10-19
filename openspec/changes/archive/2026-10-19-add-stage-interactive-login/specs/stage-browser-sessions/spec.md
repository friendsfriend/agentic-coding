## ADDED Requirements

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
