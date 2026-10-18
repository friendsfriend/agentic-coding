## ADDED Requirements

### Requirement: Stage OAuth 2.0 providers are configured by reference and validated
A stage SHALL be able to declare named OAuth 2.0 providers with a token endpoint, an optional authorization endpoint, a client id, an optional client secret, scopes and an audience, and a role SHALL select a provider and one of the grants `client_credentials`, `refresh_token` or `authorization_code`. Every credential field SHALL be exactly one `${VARIABLE}` reference. A provider whose endpoint is not `https` (except on loopback), whose endpoint origin is not in the stage's `allowedOrigins`, or whose grant is `implicit` or `password` SHALL be refused with a value-free diagnostic and the stage excluded from the allow-list.

#### Scenario: Unsupported grant
- **WHEN** a role declares the `password` grant
- **THEN** the stage SHALL be excluded with a diagnostic naming the file and field and no value

#### Scenario: Endpoint outside the allow-list
- **WHEN** a provider's token endpoint origin is not in `allowedOrigins`
- **THEN** the stage SHALL be refused

### Requirement: Tokens are acquired, held and renewed by the server only
The server SHALL obtain access tokens with the role's grant, hold them in server memory only under the lifetime ceiling, entry cap and forget action of the identity cache, and renew a token when less than the skew interval remains, once at a time per entry, honouring a rotated refresh token. A failed renewal SHALL evict the entry and answer `login-failed` with the provider's `error` code only. The server SHALL NOT write tokens to disk, to the workflow store, to telemetry, evidence, wiki or reports.

#### Scenario: Silent renewal
- **WHEN** a call needs a token that expires within the skew interval
- **THEN** the server SHALL renew it before the call and the caller SHALL see no difference

#### Scenario: Unattended grant
- **WHEN** the policy is `interactiveLogin: "never"` and the role uses `client_credentials`
- **THEN** `stage_login` SHALL succeed without a window or developer prompt

### Requirement: Tokens never reach a model or a log
Access tokens, refresh tokens, client secrets, authorization codes and every base64url segment of a JWT-shaped token of at least 20 characters SHALL be in the run's redaction set. An `Authorization` header value SHALL NOT appear in any tool result, `browser_network` output, console line, telemetry, log, evidence or report. The agent SHALL be able to learn only the token's `expiresAt`, scopes, audience and issuer through `stage_token_info`.

#### Scenario: Header masked
- **WHEN** the agent reads the network log of a session whose requests carried a bearer token
- **THEN** the `Authorization` header SHALL show a placeholder instead of its value

### Requirement: stage_api_request calls stage APIs with the role's token
`stage_api_request` SHALL accept an application of kind `api`, a method, a path and optional query, headers and body, and SHALL send the request to that application's configured origin with `Authorization: Bearer <token>` attached by the server. It SHALL refuse an absolute URL, an agent-supplied `Authorization` header, a state-changing method on a `read-only` stage, a request or response above the configured size bounds (a response is truncated and flagged), and calls above the stage action rate. A `401` SHALL cause one renewal and one retry. The response SHALL be redacted.

#### Scenario: Read-only stage refuses a write
- **WHEN** an agent sends `POST` through a `read-only` stage
- **THEN** the call SHALL be refused with the foundation's read-only code and nothing SHALL be sent

#### Scenario: Host is fixed
- **WHEN** an agent passes a full URL as the path
- **THEN** the call SHALL be refused

### Requirement: The browser bearer header is origin-exact and opt-in
A role MAY declare `bearerOrigins`. The server SHALL add `Authorization: Bearer` only to browser requests whose origin is exactly one of them, only when the request carries no `Authorization` header, and never after a redirect to another origin.

#### Scenario: Other origin untouched
- **WHEN** the page calls a third-party origin
- **THEN** no `Authorization` header SHALL be added

### Requirement: Authorization code with PKCE uses the hand-off window
For the `authorization_code` grant the server SHALL create a PKCE verifier and challenge and a `state`, open the authorization URL through the interactive-login hand-off, receive the code on a single-use loopback receiver on `127.0.0.1` that validates `state`, and exchange it at the token endpoint. The code, verifier and tokens SHALL stay in the server. A deadline, abort or `state` mismatch SHALL end the hand-off without a token.

#### Scenario: State mismatch
- **WHEN** the receiver gets a callback with a different `state`
- **THEN** the exchange SHALL NOT happen and the login SHALL fail with a value-free code
