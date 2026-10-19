## Open questions for the developer

Each has a default; an answer changes a default, not the architecture.

1. **Which grant does each application's test identity use?** *Default:* `client_credentials` for the backend (a service principal or confidential client), `refresh_token` when a long-lived refresh token is provisioned as a secret. A person's identity is the authorization code grant, which is `add-stage-oauth2-code-pkce`.
2. **Do the clerk and installer applications accept a bearer token on their API, and from which audience/scope?** *Default:* one provider per stage with a scope list per role; the audience is whatever the provider config states.
3. **May the agent see token claims?** *Default:* only `expiresAt`, `scopes`, `audience` and `issuer` (value-free). Subject and other claims are not shown.

## Context

- Foundation: stage definitions with `apps` (kinds `ui`, `api`, `mail-catcher`), roles with `${VAR}` credential references, the origin allow-list (`allowedOrigins`), the read-only guard, the action rate limit, redaction of `.env` values and resolved credentials from every response, and the rule that credentials never enter model context. Application kind `api` exists today only for version probes.
- Interactive login: a hand-off window that the developer drives; the server waits for a success condition.
- Identity cache: an in-memory, bounded, forgettable store for session state per `(stage, role)`. `add-stage-identity-cache` proposes it but nothing of it is implemented, so this change carries the token store itself and keeps the seam (`StageTokenStore`'s key, its bounds and its `forget` action) the shape the identity cache will take over.

## Goals / Non-Goals

**Goals:** standard OAuth 2.0 (RFC 6749) token acquisition for a stage role; tokens held and renewed in server memory; API calls and an opt-in scoped browser header using the token; no token ever visible to a model.

**Non-Goals:** the implicit and resource-owner password grants; acting as an authorization server; persisting tokens or refresh tokens on disk; device-code grant (possible later); unattended login of client-side-token SPAs; token introspection endpoints; mTLS/DPoP-bound tokens; the authorization code grant, which is `add-stage-oauth2-code-pkce`.

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

The stage schema accepts all three grants the capability names (`client_credentials`, `refresh_token`, `authorization_code`), because a stage file declaring the third is valid configuration. This change does not carry out an `authorization_code` login; `add-stage-oauth2-code-pkce` does, and until it lands such a role answers `login-failed` naming the reason. Nothing else about it is half-built.

The built-in `oauth2` recipe is the one a role selects *without* a declared recipe (`isOAuth2Role`: a role that carries `provider` or `grant`). An operator's own `stages/definitions/<ident>.json` `logins.oauth2` entry keeps working exactly as it did — a form recipe by that name is not reinterpreted — but the reuse is reported as a warning diagnostic, and a role that declares `provider`/`grant` must say `login: "oauth2"` so the two can never half-combine. Two roles declaring the same `${VAR}` refresh token are refused (CONC-003): a rotating provider keeps only the token it last issued, so the two would invalidate each other.

A provider endpoint is `https` even when the stage sets `insecureHttp: true` (SEC-003): the flag is for an application on a trusted network, and exempting the endpoint a client secret is posted to would move the secret onto the wire in clear. Loopback stays exempt for tests.

### D2 — Grants

- **`client_credentials`**: `POST` to the token endpoint with `client_id`/`client_secret` (HTTP basic or body per the provider's `clientAuth`, default basic), scope, audience/resource. No person involved. This is the unattended path.
- **`refresh_token`**: the refresh token is a `${VAR}`; exchanged for access tokens; a rotated refresh token replaces the in-memory copy (the `.env` value is never rewritten; after a restart the original is used, which may be invalidated by rotation — documented, and `login-failed` explains it).

Rejected: implicit and password grants (deprecated in OAuth 2.1, and password breaks MFA).

### D3 — The token store is in memory, bounded, renewed, forgettable

Entries are keyed `(stage, app, role, provider, scope-set)`, hold access token, optional refresh token and `expiresAt`, and follow the shape of bounds the identity cache declares — an absolute lifetime ceiling, an entry cap and a forget action — with this change's own numbers: an 8 h ceiling, a 32-entry cap and `forget(filter)`. The *application* is part of the key because role names live per application: `(stage, role)` alone would make two apps' same-named roles share one token, and each would silently spend the other's scope set. Those numbers are constants in `src/server/stages/oauth2.ts` while no identity cache is implemented; when one lands, the token store hands its entries to it and keeps the same key, the same ceiling and the same `forget`, so nothing at a call site changes. Renewal happens when less than `skewSeconds` (default 60) remain, single-flight per entry; a failed renewal evicts the entry and answers `login-failed` with the provider's error code and, at most, its redacted `error_description`. Reading never extends beyond the ceiling.

Three details of that store are decided here rather than by the bounds it inherits:

- **An expiry is not a forget.** `expire(key)` drops the access token and keeps the rotated refresh token, because a `401` means the *access* token was refused while the provider still accepts only the refresh token it last issued; `forget(filter)` is the credential rewrite, and it drops the rotated token too, so the `.env` value is current again.
- **A credential rewritten mid-flight is not shadowed by the answer it replaced.** Each key carries a generation counter: `forget` and `expire` bump it, and an acquisition that started under an older generation returns its token to the caller that asked for it without writing it back.
- **A down provider costs one request per window, not one per caller.** A refusal is remembered for a failure TTL (5 s) per key, so a page that makes many requests while the token endpoint is unreachable does not open one connection each; a credentials rewrite clears it.

The cap evicts the entry that expires soonest and never one whose renewal is in flight (CONC-002), and an entry's rotated refresh token survives its own eviction while that renewal runs.

### D4 — Redaction covers every token form

The access token, refresh token, client secret, plus each base64url segment (≥ 20 chars) of a JWT-shaped token, join the redactor's secret set for the run. The refresh token a provider *rotated* joins it too, and it is the rotated value — the one that was actually sent — that is scrubbed, not only the `.env` copy (SEC-001). Request logging for stage sessions never records an `Authorization` header value; `browser_network` and console output show the header name with a placeholder. Error bodies from the provider are reduced to `error` and `error_description` after redaction, and the answer a caller reads is redacted on the way out as well, not only on the way in. An authorization code is not part of this set because phase A holds none; `add-stage-oauth2-code-pkce` adds it with the flow that produces it.

The values are not in the configuration `.env` — they are acquired at runtime — so the store is the redactor's third source beside `.env` and action secrets: `stageTokenSecrets()` is appended to the browser route's and the stage route's secret list on every reply.

### D5 — `stage_api_request` and `stage_token_info`

`stage_api_request({ stage?, app, role, method, path, query?, headers?, body? })`: the stage is the workflow's pinned stage (one allow-listed stage is implied; more than one must be named); `app` must be of kind `api`; the URL is `app.url + path`, with `query` merged into its search params (a path, never an absolute URL, so the host is fixed; `query` together with a `?` inside `path` is refused, so one call cannot express two query strings); the server attaches `Authorization: Bearer`, refuses an `Authorization` header from the agent, enforces: the configured origin, read-only method guard (state-changing methods refused on `read-only` stages with the foundation's code), the stage action rate limit, `maxRequestBytes` (64 KB, counted in bytes) and `maxResponseBytes` (256 KB, truncated with a flag), a timeout. The result is `{ status, statusText, headers (allow-listed), url, body (text or JSON, redacted, truncated), bytes, renewals }`, and the agent tool cuts only `body` when the whole answer would exceed its own result bound, so `truncated`, `bytes` and `renewals` always arrive. A `401` triggers one renewal and a single retry, presenting the rotated refresh token when there is one. A redirect is not followed (the host is fixed), so a `3xx` is reported as it is. Journaling belongs to `add-stage-flow-evidence` (proposed, not implemented): when it lands, this call *is* its journal entry and nothing else here has to change, so this change records none of its own. `stage_token_info({ stage?, app, role })` returns `{ expiresAt, scopes, audience, issuer }` (`expiresAt` in epoch milliseconds) and acquires the token when the store holds none yet, reporting the token it just acquired rather than failing inside the skew window.

### D6 — The browser bearer header is opt-in and origin-exact

With `bearerOrigins`, the context route guard adds `Authorization: Bearer` to requests whose origin is exactly one of them, only if the request carries none, and never on redirects to another origin. The *request's origin* is not enough on its own: the driver also reports the document that issued it (Playwright's `request.frame().url()`), and that origin has to be one of the stage's own origins too (SEC-002). A frame from anywhere else, or a request that names no document at all, is left bare — the token belongs to the stage's pages, not to whatever a session happens to load. It is a convenience for pages calling an API directly. Documented limit: an application that authenticates client-side (MSAL and similar) ignores it; use the browser login or hand-off for those.

The guard answers per request, and the role is *resolved* once per session: the catalog and `.env` read behind a scope is cached on the session's own binding (`stageBearerToken`, PERF-001/PERF-002), so a page load with N requests on a declared origin costs N map lookups and one token, not N catalog reads. The bearer source is attached to the pool that exists, not only to the one a caller builds: a runtime created first by the settings or operations surface still gets it when the workflow composition arrives (CONC-004).

### D7 — Assumptions taken rather than asked

- The token endpoint's `issuer` is the `iss` claim of a JWT-shaped access token, and its `audience` the provider's configured audience, else the token's `aud`. A token that is not a JWT carries the token endpoint's origin as its issuer. Neither is a claim dump: only those two fields ever leave the store.
- A `client_credentials` or `refresh_token` role whose `.env` reference is unset answers `credential-missing` naming the variable under either interactive-login policy. A window cannot type a client secret, so the role's login mode is `unavailable` rather than `handoff`. The same holds for `authorization_code`, which this build cannot perform at all: reporting `handoff` would send a run into a hand-off that is refused (USAB-003).
- A read-only stage's method guard applies to `stage_api_request` exactly as it applies to the browser: `GET`, `HEAD` and `OPTIONS` pass, a declared `readOnlyExceptions` entry passes, anything else is refused before a request is sent.
- The origin guard on `stage_api_request` is the path-only rule plus the application's configured URL: since the URL is `app.url + path` and `app.url`'s origin is a stage origin by construction, a separate "the result is in the allow-list" branch has no state that reaches it. It was removed rather than kept with an untestable branch, and the property it protected is what the URL-refusal test covers (TQV-007).
- A refusal a model reads is worded for its reader: no internal change id, and the grants a build does perform are named. The provider's `error` code stays on `StageAuthError.providerCode`, and the user-visible code a caller matches on is the envelope's (`login-failed`, `credential-missing`), which is what the tool brackets (USAB-004).
- A rate-limit refusal carries its wait into the text a model reads (`… ; retry in N s`) and the message is surface-neutral ("stage calls", not "browser calls"): the limit is shared by the browser tools and `stage_api_request` (USAB-005).

## Risks / Trade-offs

- [A service principal's permissions exceed a test user's] → the provider config names scopes per role; documentation tells the operator to provision least privilege. No product mitigation beyond the read-only guard.
- [Refresh-token rotation invalidates the `.env` copy] → documented; a failed exchange is a clear `login-failed`.
- [The agent crafts requests that leak data to other hosts] → path-only requests, fixed host, allow-list, no agent-set `Authorization`, no redirect followed.
- [Same-user process can read server memory] → accepted as in the foundation.

## Migration Plan

Additive; stages without `oauth2` behave as before. Rollback: remove the providers; the other recipes are untouched.
