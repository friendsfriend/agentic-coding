## Why

`add-stage-testing-foundation` logs a stage session in through the browser: a form recipe, HTTP basic, or the developer in a window (`add-stage-interactive-login`). A stage test also needs standard OAuth 2.0 with bearer tokens: the stage's backend and any API-first application are called with `Authorization: Bearer <access token>`, and a test should be able to prepare data and check backend state through those APIs independently of the UI. The same mechanism is the natural **unattended** login for the later server and test-automation use case: a client-credentials grant needs no person, no window and no MFA. Today nothing in the stage plan can obtain, hold, renew or use an OAuth 2.0 token.

## What Changes

- **Login recipe `oauth2`.** A stage declares named OAuth 2.0 providers (token endpoint, optional authorization endpoint, client id, optional client secret, scopes, audience) and a role selects one with a grant: `client_credentials` or `refresh_token`. The implicit and password grants are not supported. Every credential is a single `${VAR}` reference, as elsewhere.
- **Server-held tokens.** The server acquires, holds and renews tokens (single-flight, renewed shortly before `exp`, refresh-token rotation honoured). Tokens live in server memory only, under the identity cache's bounds (absolute lifetime, entry cap, forget action); nothing is written to disk. The model never sees an access token, a refresh token, a client secret or a JWT segment of them. The agent may learn only the expiry, scopes, audience and issuer (`stage_token_info`).
- **`stage_api_request`.** The server performs a request to a stage application of kind `api` with the role's token attached, enforcing the origin allow-list, the read-only method guard, the action rate limit and bounded request/response sizes, with the response redacted and journaled. This lets a stage test set up preconditions and verify backend state.
- **Bearer header for the browser (opt-in).** A role may declare `bearerOrigins`; the server adds `Authorization: Bearer` to browser requests to exactly those origins and never to another. It helps pages that call an API directly. It does not log in an application that keeps its own client-side token (an MSAL SPA), which stays a browser or hand-off login.
- **Server seam.** With `interactiveLogin: "never"`, `client_credentials` and `refresh_token` roles still work unattended. Unattended UI testing of client-side-token applications remains a separate, later design.

## Capabilities

### New Capabilities

- `stage-oauth2-auth`: stage OAuth 2.0 providers, token acquisition and renewal, in-memory token handling, `stage_api_request`, `stage_token_info` and the scoped browser bearer header.

### Modified Capabilities

None.

## Impact

- New `src/server/stages/oauth2.ts` (grants, token store), stage routes and agent tools (`stage_api_request`, `stage_token_info`), `src/server/stages/schema.ts` and `catalog.ts` (providers, `oauth2` recipe, `bearerOrigins`), `src/server/browser/pool.ts` and the context route guard (scoped header), `src/contracts/`, `src/agent-host/` tools.
- Docs: `docs/agent-environments.md` ("Hosted stages"), `docs/config-inventory.md`.
- No store schema change, no new dependency (`fetch`, `node:crypto`). Depends on `add-stage-testing-foundation` (stages, redaction, origin guard, limits). The token store shares its bounds and forget action with `add-stage-identity-cache` and may be built on it; implement in either order, the second adapts.
