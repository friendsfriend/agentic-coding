## ADDED Requirements

### Requirement: Session state is cached in memory per stage and role
After a stage session's login succeeds, by an automated recipe or by the developer, the server SHALL capture the cookies, localStorage and sessionStorage of the stage's application origins and declared login origins — which is where an application's JWT or cached tokens live — and keep them in server memory under the key `(stage, role)`. For an HTTP-basic login typed by the developer in the browser's own dialog, the server SHALL capture the Basic credential the browser sent to the application's origin only where the driver exposes that request header; where it does not, such a role SHALL be documented and treated as non-cacheable and its login SHALL run per session. The server SHALL NOT capture any other origin, SHALL NOT write the cache to disk, to the workflow store, to a snapshot, to telemetry or to evidence, and SHALL lose the cache when the server process ends.

#### Scenario: Capture after a successful login
- **WHEN** a login of role `clerk` on stage `grid-int` meets its success condition
- **THEN** the cookies and storage of the stage's application and login origins SHALL be held under `(grid-int, clerk)` and nothing from any other origin

#### Scenario: Application token captured
- **WHEN** a login leaves a JWT in the application's `sessionStorage`, `localStorage` or an `HttpOnly` cookie
- **THEN** that state SHALL be captured and no tool result or log SHALL contain it

#### Scenario: Basic credential typed by the developer
- **WHEN** the developer completes an HTTP-basic login in the browser's own dialog and the driver exposes the `Authorization` header
- **THEN** the credential SHALL be captured in memory for `(stage, role)` and SHALL later be installed only as HTTP credentials for the application's origin, sent only in answer to a `401`

#### Scenario: Basic login the driver cannot observe
- **WHEN** the driver cannot observe the `Authorization` header the browser's dialog generates
- **THEN** no Basic credential SHALL be cached, the role SHALL be reported as non-cacheable, and its next login SHALL run the normal path

#### Scenario: Nothing survives a restart
- **WHEN** the server restarts
- **THEN** the cache SHALL be empty and the next login SHALL run the normal path

### Requirement: The cached state follows the live session
While a stage session lives, the server SHALL replace the entry with a fresh capture after each successful login, at a bounded interval and on clean close, so a renewed JWT or rotated refresh token supersedes the stale copy. A session recreated during a run SHALL continue from the latest capture.

#### Scenario: Recreated session stays logged in
- **WHEN** an idle timeout closes a stage session during a run and the agent opens it again within the entry's lifetime
- **THEN** the new session SHALL start from the latest captured state and SHALL reach the success condition without a developer prompt

### Requirement: A cached identity is reused silently but never trusted
When a stage session for `(stage, role)` is created and a live entry exists, the server SHALL install the cached state into the new context before the first navigation using server-internal paths only (cookies and origin-scoped storage initialisation, plus a Basic credential as HTTP credentials limited to the application's origin and sent only on `401` where the driver exposes the header to capture it). The login's success condition SHALL still decide whether the session is logged in. If the login form appears instead, the server SHALL evict the entry and continue with the automated recipe or the developer hand-off.

#### Scenario: Silent sign-in
- **WHEN** a second workflow opens the clerk application on `grid-int` within the entry's lifetime and the identity provider accepts the cached cookie
- **THEN** the session SHALL reach the recipe's success condition without a developer prompt and the login result SHALL report the identity source as `cache`

#### Scenario: Rejected identity
- **WHEN** the identity provider rejects the cached cookie and shows its login form
- **THEN** the entry SHALL be evicted and the normal login path SHALL run

#### Scenario: Other roles and stages are untouched
- **WHEN** a session is created for `(grid-int, installer)` and only `(grid-int, clerk)` is cached
- **THEN** no cached cookie SHALL be installed

### Requirement: The cache is bounded
Each entry SHALL have an absolute lifetime from its capture, defaulting to 4 hours and capped by `stages/policy.json` `identityCache.ttlMinutes`; reading an entry SHALL NOT extend its lifetime; expired cookies SHALL NOT be installed, and an entry whose application reports an unauthenticated state SHALL be evicted; the number of entries SHALL be capped by `identityCache.maxEntries`, evicting the oldest. A stage with `identityCache: false` SHALL never capture or install an entry.

#### Scenario: Expired entry
- **WHEN** an entry is older than its lifetime
- **THEN** it SHALL NOT be installed and a login SHALL run the normal path

#### Scenario: Opt-out
- **WHEN** a stage declares `identityCache: false`
- **THEN** no cookie of that stage SHALL be captured or installed

### Requirement: Identities can be listed and forgotten without exposing values
The system SHALL offer a value-free listing of `(stage, role, capturedAt, expiresAt)` and a forget action per stage, per role or for all entries, through the stage route, the dashboard and the CLI. A listing SHALL NOT contain cookie or storage names, values or tokens.

#### Scenario: Forget one role
- **WHEN** the developer forgets `(grid-int, clerk)`
- **THEN** the entry SHALL be removed and the next clerk login SHALL run the normal path

### Requirement: Cached values never reach a model or a log
Cached values (cookies, storage values, tokens, Basic credentials) SHALL NOT appear in any tool result, telemetry, log, evidence file, wiki page, report or workflow snapshot. Every cached value SHALL be in the redactor's secret set, and the agent-facing script facade SHALL keep refusing cookie access on stage sessions.

#### Scenario: Echoed value is masked
- **WHEN** a page title or console line contains a cached value
- **THEN** the tool result SHALL carry the masked placeholder instead
