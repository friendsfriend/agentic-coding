## MODIFIED Requirements

### Requirement: Login hand-off trigger

`stage_login({ session, app, role })` SHALL decide in this order:

1. While the session records, it SHALL be refused with `recording-active`, and no hand-off SHALL start.
2. When the session already lives in the interactive browser, the recipe declares a success condition and the effective mode is `local`, the silent SSO check SHALL run before anything else is attempted, and a condition that holds SHALL answer `ok` with `via: "existing-session"` and start no hand-off.
3. When the role's credential status is `set` and its recipe is automatable, the automated recipe SHALL run unchanged.
4. When the effective interactive-login mode is `local`, the server SHALL start a login hand-off in any of these cases:
   - `reason: "no-credentials"`: the role's credential status is `none` or `missing <VAR>`;
   - `reason: "unautomatable-step"`: the recipe is of kind `interactive`, or the automated recipe ended in `login-mfa-required`. In that case the headless attempt SHALL be discarded, and the hand-off SHALL restart from the application's login URL.
   - `reason: "user-identity"`: the role's grant is `authorization_code`, whose sign-in is the developer's own identity at the provider. The hand-off SHALL open the provider's authorization URL, and no automated attempt SHALL be made first.
5. When the effective mode is `never`:
   - a missing variable SHALL answer `credential-missing` naming the variable;
   - a role with status `none` or an `interactive` recipe SHALL answer `login-user-unavailable`;
   - an `authorization_code` role SHALL answer `login-user-unavailable`, even when one of the references it needs is unset: naming a variable whose setting still could not open a window would send the developer to a dead end;
   - an MFA step SHALL answer `login-mfa-required`.
   No window SHALL open.

A refusal that names a missing variable SHALL name the variable that is actually unset among the role's own credential references, which for an `authorization_code` role are the provider's client id and, when the provider declares one, its client secret.

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

#### Scenario: A person's own identity hands off without an automated attempt

- **WHEN** the role's grant is `authorization_code` and the effective mode is `local`
- **THEN** the result SHALL be `login-needs-user` with `reason: "user-identity"`, the window SHALL stand on the provider's authorization URL, and no automated recipe SHALL have run

#### Scenario: An unset provider credential is named

- **WHEN** the provider declares a client id that is set and a client secret that is not, and `stage_login` is called for that role
- **THEN** the result SHALL be `credential-missing` naming the client secret's variable, and no window SHALL open

#### Scenario: A provider that declares no client id never reaches a login

- **WHEN** a stage file's provider declares no client id reference at all
- **THEN** the stage SHALL be refused at load with a value-free diagnostic naming `oauth2.providers.<name>.clientId`, so no role of it is reachable and `stage_login` never has to name a variable that does not exist

### Requirement: Hand-off outcome contract

A started hand-off SHALL make `stage_login` return immediately with the non-terminal `login-needs-user`. That result SHALL carry `handoffId`, `stage`, `app`, `role`, `reason`, `state` (`queued` or `active`), `queuePosition` when queued, and `deadlineAt`. `stage_login_wait({ session, timeoutSec? })` SHALL block in the server for at most the smaller of the remaining deadline and 600 s. It SHALL return either the non-terminal shape again or exactly one terminal outcome:

- `ok`, with `via` set to `"handoff"`, `"existing-session"` or `"token"`, `verified`, and the landing URL as origin plus path;
- `login-handoff-unverified`;
- `login-handoff-timeout`;
- `login-handoff-aborted`, with `by` set to `developer`, `agent`, `window-closed` or `run-ended`;
- `login-failed`, carrying the code and message of the server's own value-free refusal (the code grant's exchange).

When no headed-capable browser or no display exists, `stage_login` SHALL return `login-handoff-unavailable`. The server SHALL detect success by evaluating the recipe's success condition against the session's page about once per second, and only a boolean SHALL leave that check. A second `stage_login` on a session whose hand-off is pending SHALL return the pending `login-needs-user` and SHALL NOT start a second hand-off. No hand-off result SHALL contain page content, a credential, typed input, or a URL query or fragment.

A hand-off whose login ends off-page SHALL carry a completion source that the server polls on the same tick before any page-based success condition, and `ok` SHALL be reported only once that source reports the credential held. Such a hand-off SHALL offer no *Done*: neither its dashboard record nor the window's banner SHALL present an answer whose text promises a verification the hand-off cannot perform, and *Abort* SHALL be its only developer answer.

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

#### Scenario: The provider refuses the exchange

- **WHEN** the off-page completion reports that the provider refused the token request
- **THEN** `stage_login_wait` SHALL return `login-failed` with the refusal's own code and no value from the exchange

#### Scenario: A completion-driven hand-off offers no Done

- **WHEN** the developer opens the dashboard record of a hand-off whose login ends off-page
- **THEN** the record SHALL offer *Abort* alone, and the window's banner SHALL NOT offer *Done*

#### Scenario: A signed-in role signs in again when asked

- **WHEN** `stage_login` is called for a role whose token the store already holds and the grant is `authorization_code`
- **THEN** the hand-off SHALL run its own exchange rather than answering `ok` from the stored token
