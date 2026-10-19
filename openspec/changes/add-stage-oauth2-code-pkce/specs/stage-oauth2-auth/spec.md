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

## MODIFIED Requirements

### Requirement: Tokens are acquired, held and renewed by the server only
The server SHALL obtain access tokens with the role's grant, hold them in server memory only under the lifetime ceiling, entry cap and forget action of the identity cache, and renew a token when less than the skew interval remains, once at a time per entry, honouring a rotated refresh token. A failed renewal SHALL evict the entry and answer `login-failed` with the provider's `error` code and, at most, its `error_description` after redaction and bounding. The server SHALL NOT write tokens to disk, to the workflow store, to telemetry, evidence, wiki or reports.

A role whose grant is `authorization_code` SHALL renew only with the refresh token its hand-off's exchange stored: when the provider issued none, or no sign-in has run yet, a request that needs the token SHALL be refused with `login-failed` (`interactive_login_required`) and SHALL make no token request. Only a refusal by the provider SHALL discard that refresh token; a renewal that did not reach the provider SHALL keep it, so a transient failure does not cost a person a second sign-in. An acquisition that is one person's own sign-in SHALL neither join nor be joined by another acquisition of the same entry, and its failure SHALL NOT evict an entry it never read.

#### Scenario: Silent renewal
- **WHEN** a call needs a token that expires within the skew interval
- **THEN** the server SHALL renew it before the call and the caller SHALL see no difference

#### Scenario: Unattended grant
- **WHEN** the policy is `interactiveLogin: "never"` and the role uses `client_credentials`
- **THEN** `stage_login` SHALL succeed without a window or developer prompt

#### Scenario: Rotated refresh token survives a refused access token
- **WHEN** the application answers `401` for a token whose provider rotated the refresh token
- **THEN** the retry SHALL present the rotated refresh token, and only a rewritten credential SHALL discard it

#### Scenario: A code-grant token with no refresh token
- **WHEN** a call needs a token of an `authorization_code` role whose exchange stored no refresh token
- **THEN** the answer SHALL be `login-failed` (`interactive_login_required`) naming `stage_login`, and no token request SHALL be made

#### Scenario: A renewal that did not get through keeps its refresh token
- **WHEN** the renewal's request fails at the transport, times out, or is answered with a server error
- **THEN** the rotated refresh token SHALL stay in the store and the next renewal SHALL present it again

