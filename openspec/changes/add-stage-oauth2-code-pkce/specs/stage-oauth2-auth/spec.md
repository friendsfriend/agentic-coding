## ADDED Requirements

### Requirement: The authorization code grant is exchanged on a single-use loopback receiver
For a role whose grant is `authorization_code`, the server SHALL create a PKCE code verifier and its S256 challenge and an opaque `state`, open the provider's authorization URL through the interactive-login hand-off, and receive the callback on a single-use loopback receiver on `127.0.0.1` that accepts exactly one request and validates `state` before any exchange. The authorization code, the code verifier and every token SHALL stay in the server. A `state` mismatch, a deadline or an abort SHALL close the receiver and end the login without a token and without a value in the answer.

#### Scenario: State mismatch
- **WHEN** the receiver gets a callback with a different `state`
- **THEN** no exchange SHALL happen, the receiver SHALL be closed and the login SHALL fail with a value-free code

#### Scenario: Deadline ends the login
- **WHEN** the developer does not complete the sign-in before the hand-off's deadline
- **THEN** the receiver SHALL be closed and the login SHALL answer `login-handoff-timeout`

### Requirement: The authorization code hand-off reuses the interactive-login hand-off
The `authorization_code` login SHALL use the interactive-login hand-off's record, window, session lock and deadline instead of a mechanism of its own, SHALL answer the non-terminal `login-needs-user` from `stage_login`, and SHALL be waited for with `stage_login_wait`. It SHALL report `ok` only after the receiver has completed and the token is held in server memory, and it SHALL honour a configuration whose policy is `interactiveLogin: "never"` by refusing the login rather than by opening a window.

#### Scenario: Successful hand-off
- **WHEN** the developer completes the sign-in in the hand-off window and the receiver completes within the deadline
- **THEN** `stage_login_wait` SHALL answer `ok` and the token SHALL be available to `stage_api_request` without a value ever being reported
