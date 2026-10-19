## 1. Configuration

- [x] 1.1 Stage schema and catalog: `oauth2.providers` and the `oauth2` role recipe (`provider`, `grant`, `bearerOrigins`); validation (https, endpoint origins in `allowedOrigins`, single `${VAR}` references, supported grants only, `bearerOrigins` are stage app origins); value-free diagnostics; tests.

## 2. Tokens

- [x] 2.1 `src/server/stages/oauth2.ts`: `client_credentials` and `refresh_token` grants over `fetch`, client authentication (basic or body), scope/audience, bounded timeouts, provider error mapping to `error`/`error_description` after redaction; unit tests against a local fake token endpoint.
- [x] 2.2 In-memory token store keyed `(stage, role, provider, scope-set)`: absolute lifetime, entry cap, single-flight renewal at `skewSeconds`, refresh-token rotation, forget; share bounds and forget action with the identity cache (reuse its store when present); tests (renewal, concurrent callers, failed renewal evicts, no value in `list()`/JSON).
- [x] 2.3 Redaction: add access/refresh tokens, client secret, authorization code and JWT segments to the run's secret set; `Authorization` header values are never logged or shown by `browser_network`/console; tests that no response, telemetry line, log or evidence file contains a token.

## 3. Using tokens

- [x] 3.1 `stage_api_request` route + agent tool: path-only requests on `api` apps, role token attached, agent-supplied `Authorization` refused, origin guard, read-only method guard, rate limit, size and time bounds, allow-listed response headers, one renewal retry on `401`, journal entry when the journal exists; tests (read-only refusal, oversize truncation, host fixed, `401` retry).
- [x] 3.2 `stage_token_info` tool returning only `expiresAt`, `scopes`, `audience`, `issuer`; tests that nothing else is returned.
- [x] 3.3 Browser: scoped bearer header for `bearerOrigins` in the context route guard (exact origin, never on a request that already carries `Authorization`, never after a cross-origin redirect); tests with the fake driver.
- [x] 3.4 `stage_login` for the `oauth2` recipe returns `ok` after the first successful token acquisition (value-free), `credential-missing` naming the variable, `login-failed` with the provider's error code; works with `interactiveLogin: "never"` for the two unattended grants.

## 4. Docs and verification

- [x] 4.1 Docs: `docs/agent-environments.md` ("Hosted stages": OAuth 2.0 providers, grants, token handling, `stage_api_request`, the client-side-token limit, the unattended seam), `docs/config-inventory.md`.
- [x] 4.2 `bun run type-check` 0 errors, `bun run test`, biome, `openspec validate --changes --strict`.
