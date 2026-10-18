## Open questions for the developer

Each has a default; an answer changes a default, not the architecture.

1. **Which grant does each application's test identity use?** *Default:* `client_credentials` for the backend (a service principal or confidential client), `authorization_code` + PKCE through the hand-off window for a person's identity, `refresh_token` when a long-lived refresh token is provisioned as a secret.
2. **Redirect URI for authorization code + PKCE.** The provider's app registration must allow a loopback redirect (`http://127.0.0.1:<port>/…`). Entra permits loopback redirects for public clients with any port. *Default:* an ephemeral port on `127.0.0.1`; if the registration forbids it, phase B is not usable for that provider and the role falls back to the browser hand-off.
3. **Do the clerk and installer applications accept a bearer token on their API, and from which audience/scope?** *Default:* one provider per stage with a scope list per role; the audience is whatever the provider config states.
4. **May the agent see token claims?** *Default:* only `expiresAt`, `scopes`, `audience` and `issuer` (value-free). Subject and other claims are not shown.

## Context

- Foundation: stage definitions with `apps` (kinds `ui`, `api`, `mail-catcher`), roles with `${VAR}` credential references, the origin allow-list (`allowedOrigins`), the read-only guard, the action rate limit, redaction of `.env` values and resolved credentials from every response, and the rule that credentials never enter model context. Application kind `api` exists today only for version probes.
- Interactive login: a hand-off window that the developer drives; the server waits for a success condition.
- Identity cache: an in-memory, bounded, forgettable store for session state per `(stage, role)`.
- `src/server/environment/agent-routes.ts` already has `http_request` for environment apps with redaction; a stage tool must not reuse it, because it is not stage-allow-listed and not role-aware.

## Goals / Non-Goals

**Goals:** standard OAuth 2.0 (RFC 6749, PKCE RFC 7636) token acquisition for a stage role; tokens held and renewed in server memory; API calls and an opt-in scoped browser header using the token; no token ever visible to a model.

**Non-Goals:** the implicit and resource-owner password grants; acting as an authorization server; persisting tokens or refresh tokens on disk; device-code grant (possible later); unattended login of client-side-token SPAs; token introspection endpoints; mTLS/DPoP-bound tokens.

## Decisions

### D1 — Providers are stage configuration; roles select them

`stages/definitions/<ident>.json` gains `oauth2.providers`:

```json
"oauth2": { "providers": { "idp": {
  "tokenEndpoint": "https://login.example.com/oauth2/v2.0/token",
  "authorizationEndpoint": "https://login.example.com/oauth2/v2.0/authorize",
  "clientId": "${STAGE_GRID_INT_CLIENT_ID}",
  "clientSecret": "${STAGE_GRID_INT_CLIENT_SECRET}",
  "scope": ["api://grid-backend/.default"] } } }
```

and a role selects `{ "login": "oauth2", "provider": "idp", "grant": "client_credentials", "bearerOrigins": ["https://api.int.example.com"] }`. Validation, value-free diagnostics, same refusal style as the foundation: endpoints must be `https` (loopback exception) and their origins must be in `allowedOrigins`; a credential field must be exactly one `${VAR}`; unsupported grants are refused; `bearerOrigins` must be origins of stage apps.

### D2 — Grants

- **`client_credentials`**: `POST` to the token endpoint with `client_id`/`client_secret` (HTTP basic or body per the provider's `clientAuth`, default basic), scope, audience/resource. No person involved. This is the unattended path.
- **`refresh_token`**: the refresh token is a `${VAR}`; exchanged for access tokens; a rotated refresh token replaces the in-memory copy (the `.env` value is never rewritten; after a restart the original is used, which may be invalidated by rotation — documented, and `login-failed` explains it).
- **`authorization_code` + PKCE (phase B)**: the server creates a code verifier/challenge and a `state`, starts a single-use loopback receiver on `127.0.0.1:<ephemeral>`, and opens the authorization URL through the interactive-login hand-off (the record, the window, the deadline and the session lock all as specified there). The receiver validates `state`, takes the `code`, exchanges it at the token endpoint and shows a short "you can close this window" page. Code, verifier and tokens never leave the server.

Rejected: implicit and password grants (deprecated in OAuth 2.1, and password breaks MFA).

### D3 — The token store is in memory, bounded, renewed, forgettable

Entries are keyed `(stage, role, provider, scope-set)`, hold access token, optional refresh token and `expiresAt`, and follow the identity cache's bounds: absolute lifetime ceiling from `stages/policy.json`, entry cap, forget action. Renewal happens when less than `skewSeconds` (default 60) remain, single-flight per entry; a failed renewal evicts the entry and answers `login-failed` with the provider's error code (not its body). Reading never extends beyond the ceiling.

### D4 — Redaction covers every token form

The access token, refresh token, client secret and authorization code, plus each base64url segment (≥ 20 chars) of a JWT-shaped token, join the redactor's secret set for the run. Request logging for stage sessions never records an `Authorization` header value; `browser_network` and console output show the header name with a placeholder. Error bodies from the provider are reduced to `error` and `error_description` after redaction.

### D5 — `stage_api_request` and `stage_token_info`

`stage_api_request({ stage?, app, role, method, path, query?, headers?, body? })`: the stage is the workflow's pinned stage; `app` must be of kind `api`; the URL is `app.url + path` (a path, never an absolute URL, so the host is fixed); the server attaches `Authorization: Bearer`, refuses an `Authorization` header from the agent, enforces: origin allow-list, read-only method guard (state-changing methods refused on `read-only` stages with the foundation's code), the stage action rate limit, `maxRequestBytes` (default 64 KB) and `maxResponseBytes` (default 256 KB, truncated with a flag), a timeout. The result is `{ status, headers (allow-listed), body (text or JSON, redacted, truncated) }`. A `401` triggers one renewal and a single retry. Each call is journaled when `add-stage-flow-evidence` is present, and never logs headers. `stage_token_info({ role })` returns `{ expiresAt, scopes, audience, issuer }`.

### D6 — The browser bearer header is opt-in and origin-exact

With `bearerOrigins`, the context route guard adds `Authorization: Bearer` to requests whose origin is exactly one of them, only if the request carries none, and never on redirects to another origin. It is a convenience for pages calling an API directly. Documented limit: an application that authenticates client-side (MSAL and similar) ignores it; use the browser login or hand-off for those.

### D7 — Phasing

- **Phase A:** providers, `client_credentials`, `refresh_token`, token store and renewal, redaction, `stage_api_request`, `stage_token_info`, the scoped header. Needs only the foundation.
- **Phase B:** `authorization_code` + PKCE with the loopback receiver and the hand-off. Needs `add-stage-interactive-login`.

## Risks / Trade-offs

- [A service principal's permissions exceed a test user's] → the provider config names scopes per role; documentation tells the operator to provision least privilege. No product mitigation beyond the read-only guard.
- [Refresh-token rotation invalidates the `.env` copy] → documented; a failed exchange is a clear `login-failed`.
- [A loopback redirect is not allowed by the registration] → open question 2; the browser hand-off remains.
- [The agent crafts requests that leak data to other hosts] → path-only requests, fixed host, allow-list, no agent-set `Authorization`.
- [Same-user process can read server memory] → accepted as in the foundation.

## Migration Plan

Additive; stages without `oauth2` behave as before. Rollback: remove the providers; the other recipes are untouched.
