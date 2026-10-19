## Why

A stage test logs in per role (customer, clerk, installer). With Microsoft Entra ID, with HTTP basic auth the developer typed into the browser, or with any login that needs the developer (`add-stage-interactive-login`), every new workflow starts a fresh browser context and the developer would be asked to sign in again for every run. Two things would let the next run continue silently: the identity provider's single-sign-on cookie, and the token the application keeps once it is logged in (a JWT in a cookie, `localStorage` or `sessionStorage`, as MSAL.js does). `add-stage-testing-foundation` deliberately persists no session state, because live tokens on disk are a risk. A bounded, **in-memory** cache closes the gap without writing anything to disk.

## What Changes

- **Identity cache, server memory only.** After a successful login of a stage session (automated recipe or developer hand-off), the server captures the **session state of the stage's origins** under the key `(stage ident, role)`: cookies, `localStorage` and `sessionStorage` of the identity-provider origins and of the application's own origin (this is where the application's JWT and, for MSAL, the cached tokens live), plus, for an HTTP-basic login the developer typed in the browser's own dialog, the Basic credential the browser sent (captured from the request's `Authorization` header, which a page never sees).
- **Staying active.** The state is refreshed while the session lives (after each successful login, periodically, and on clean close), so a rotated refresh token or a renewed JWT replaces the stale copy. A session that is recreated mid-run (idle timeout, crash) continues from the latest state instead of asking for a new login. Token expiry is handled by the application itself (it refreshes with its refresh token); when the application can no longer refresh, the entry is evicted and the normal login path runs.
- **Silent reuse.** When a later stage session for the same `(stage, role)` is created, the server installs that state into the new context before the first navigation (cookies and storage through a server-internal init script scoped to each origin; a Basic credential as origin-scoped HTTP credentials answering `401` only). The application finds its token (or redirects to the identity provider, which recognises its cookie), and the recipe's success condition is met without a prompt. The cache is never trusted by itself: the existing success condition decides whether the login worked; a rejected or expired cookie falls through to the normal path (automated recipe, else developer hand-off).
- **Bounds.** An absolute time-to-live per entry from the last successful login (default 4 hours, ceiling set in `stages/policy.json`; a JWT whose own `exp` has passed and that has no refresh path is not a reason to keep an entry), a maximum number of entries, expired cookies dropped, a per-stage opt-out (`identityCache: false`). Entries die with the server process.
- **Forgetting.** A manual forget (dashboard action and CLI) per stage, role or all; a session whose reused identity was rejected evicts its entry.
- **Never exposed.** Cached values (cookies, storage values, tokens, Basic credentials) are never returned to a tool, written to disk, logged, put in telemetry, evidence, wiki or reports, or included in workflow snapshots; the agent's script facade keeps refusing cookie access.

## Capabilities

### New Capabilities

- `stage-identity-cache`: capture, refresh, origin-scoped reuse, bounds and forgetting of the session state (identity-provider and application cookies, storage and tokens, and a typed Basic credential) per stage and role, in memory only.

### Modified Capabilities

None (the stage configuration gains the `identityCache` field and the policy gains the TTL ceiling through this change's tasks; the field requirements live in the new capability).

## Impact

- `src/server/browser/pool.ts` (capture after login, install at context creation), a new `src/server/stages/identity-cache.ts`, `src/server/stages/schema.ts` and `catalog.ts` (field and policy), the stage routes (forget), the dashboard stage actions and the CLI.
- Docs: `docs/agent-environments.md` ("Hosted stages"), `docs/config-inventory.md`.
- No store schema change, no new dependency. Depends on `add-stage-testing-foundation` (stage sessions, login recipes, redaction) and benefits from `add-stage-interactive-login`; implement after both.
- The server/CI version (unattended identity injection) is out of scope; the cache is the natural seam to seed from a service identity later.
