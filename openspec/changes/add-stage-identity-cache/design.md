## Open questions for the developer

Each has a default; an answer changes a default, not the architecture.

1. **Default time-to-live.** *Default:* 4 hours, ceiling 24 hours in `stages/policy.json`. Entra's own sign-in frequency and conditional access can end a session earlier; then the normal login path runs.
2. **Share one identity across roles of the same identity provider?** *Default:* no — the key is `(stage, role)` because roles are different users.
3. **Cache across stages?** *Default:* no; a stage is the trust boundary.

## Context

- Foundation (`add-stage-testing-foundation`): stage-bound sessions in isolated browser contexts, login recipes, credential-safe redaction, and the rule that no session state is persisted (live tokens at rest rejected). The script facade refuses `context.cookies`, `context.storageState` and `context.addCookies` for stage sessions.
- Interactive login (`add-stage-interactive-login`): the developer completes the login in a visible window when no credentials are configured.
- Entra ID applications typically keep their own tokens in `sessionStorage` (lost with the context) or `localStorage`; other applications keep a JWT in a cookie or storage after a basic-auth or form login. A new context can reuse the identity provider's sign-on cookie (silent redirect round trip) and, when restored, the application's own token.
- HTTP basic typed into the browser's native dialog is not page state: it lives in the browser's HTTP auth cache and is invisible to `storageState`. The browser then sends it as an `Authorization: Basic` request header, which Playwright can read on the request.
- The existing recording swap already carries cookies, localStorage and the current origin's sessionStorage between contexts of one session (`pool.ts`), so cookie install at context creation is a known operation.

## Goals / Non-Goals

**Goals:** one hand-off (or one automated login) serves later runs within a bounded time and keeps a long run logged in across a recreated session; nothing on disk; no value ever visible to the model.

**Non-Goals:** persistent browser profiles or `storageState` files on disk; capturing origins outside the stage's own application and login origins; unattended/CI identity injection (a later server design may seed this cache); sharing across stages or users; bypassing MFA — the cache only reuses a session the developer or recipe already established.

## Decisions

### D1 — In memory, owned by the server, keyed `(stage, role)`

A `Map` inside the server process (`identity-cache.ts`), not in the workflow store, not in `config`, not in snapshots. It is lost on restart; that is the point. Rejected: encrypted file (key management for a local single-user tool, same-user readable anyway), OS keychain (platform-specific dependency), persistent browser profile (full tokens at rest, large surface).

### D2 — Capture the stage origins' session state, refresh it while the session lives

After the login's success condition is met, capture, for each origin of the stage's applications and declared login origins only (never a third-party host the page happened to call):

- cookies whose domain matches those origins,
- `localStorage` and `sessionStorage` of those origins (`storageState()` for cookies and localStorage; `sessionStorage` through the same origin-scoped `page.evaluate` read that the recording swap already uses),
- for a role whose login recipe is `http-basic` and was completed by the developer in the browser's own dialog: the Basic credential, taken from the `Authorization` request header the browser sends to the stage application's origin. This is a task-1 spike: verify that the driver exposes the header (`request.allHeaders()`), otherwise the Basic hand-off is documented as non-cacheable and the developer is prompted each run (the configured-credentials path is unaffected).

**Refresh.** The capture is repeated after each successful `stage_login`, every `identityCache.refreshSeconds` (default 120, bounded) while the session lives, and on clean close, so a rotated refresh token or a renewed JWT replaces the stale copy. A session recreated mid-run (idle timeout, crash) restarts from the latest capture. Tokens are never parsed to decide anything except a bounded, server-side read of a JWT's `exp` for the listing's `expiresAt` hint; the success condition is the only judge of whether a state still works.

### D3 — Install before first navigation; the success condition stays the judge

On creating a stage session for `(stage, role)` with a live entry, the server installs the state before the first navigation, through server-internal paths only: cookies by `addCookies`, storage by an origin-scoped init script that writes the captured keys on first document creation of that origin, and a Basic credential as HTTP credentials limited to the application's origin and sent only in answer to a `401` (never `send: "always"`, never to another origin). `stage_login` still runs the declared success condition. If the page shows the login form or the application reports an unauthenticated state, the cache is treated as rejected: the entry is evicted, and the automated recipe or developer hand-off continues. A cache never answers "logged in" by itself. A token that expired but has a working refresh path is handled by the application itself and needs no special case.

### D4 — Bounds

`identityCache` per stage (`true` default, `false` opt-out); `stages/policy.json` `identityCache: { ttlMinutes, maxEntries }` ceilings; per-cookie expiry honoured (session cookies live until the entry TTL); entries beyond `maxEntries` evict the oldest. Reading an entry never extends its TTL beyond the policy ceiling (absolute lifetime from capture, refreshed only by a new successful login).

### D5 — Forgetting

`stage identity forget <stage> [--role R]` via the stage route, a dashboard stage action, and CLI. Also automatic on rejection (D3). No bulk export or listing of values; a listing shows `(stage, role, capturedAt, expiresAt)` only.

### D6 — Never exposed

Cached values (cookies, storage values, JWTs and the Basic credential) pass only between the Playwright context and the cache. Every captured value, and each token-shaped substring of it, is added to the redactor's secret set for the session, so an accidental echo in a page title, URL or console line is masked. Cache contents are excluded from heap-diagnostic and telemetry surfaces by construction (no logging of the structure). The residual same-user risk (a process the developer runs can read server memory) is the same as for provider tokens and is accepted, as in the foundation.

### D7 — Concurrency

Parallel runs on the same `(stage, role)` share the entry read-only (each gets its own copy of the cookies at install); the entry is replaced by the newest successful login. No exclusivity (decided for stage tests).

## Risks / Trade-offs

- [A stale identity masks that a login flow is broken] → the first step of a stage test records whether the login was silent or interactive in the journal, so a regression in the sign-in flow is not hidden; `identityCache: false` or a forget gives a cold start.
- [Cookies outlive the intended TTL in the browser] → contexts are discarded; the cache enforces its own absolute TTL.
- [A test user's session is shared by parallel runs] → acceptable, the sessions belong to the same test identity.
- [Server restart drops the cache] → by design; costs one hand-off.
- [Refresh-token rotation makes an older copy unusable] → the entry is replaced by every capture, the newest wins; a parallel run that used a stale copy sees the login form, evicts, and logs in normally.
- [An application keeps the JWT in `HttpOnly` cookies only] → cookies are captured by the driver, which sees `HttpOnly` cookies; the page never does.
- [Capture widens the secret surface compared with IdP cookies only] → bounded to the stage's own origins, in memory, absolute TTL, redacted, forgettable; the residual same-user risk is accepted as in the foundation.

## Migration Plan

Additive; the field and policy keys are optional, the cache is empty on start. No store or config migration. Rollback: remove the cache; every run logs in cold as before.
