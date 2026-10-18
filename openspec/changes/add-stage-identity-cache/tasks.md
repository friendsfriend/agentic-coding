## 1. Cache

- [ ] 1.1 Add `src/server/stages/identity-cache.ts`: in-memory `(stage, role)` map with absolute TTL, `maxEntries`, per-cookie expiry filtering, copy-on-read, `forget(stage, role?)`, and a value-free `list()`; unit tests (TTL, eviction, expiry, no value in `list()`/`toString`/JSON serialisation).
- [ ] 1.2 Stage schema and policy: `identityCache` per stage (boolean, default true) and `stages/policy.json` `identityCache: { ttlMinutes, maxEntries, refreshSeconds }` ceilings capping the stage values; validation diagnostics; tests.

## 2. Capture and reuse

- [ ] 2.0 Spike (write the result into design.md D2 before 2.1): does the Playwright driver expose the `Authorization` request header of a native basic-auth dialog login (`request.allHeaders()`)? If not, document the Basic hand-off as non-cacheable and skip 2.4.
- [ ] 2.1 `pool.ts`: after a stage session's login success (automated or developer hand-off), periodically (`identityCache.refreshSeconds`) and on clean close, capture the cookies, localStorage and sessionStorage of the stage's application and login origins only (nothing from other hosts); replace the entry with each capture; tests with the fake driver (JWT in sessionStorage, in localStorage, in an HttpOnly cookie; third-party origin ignored; rotated refresh token replaces the old).
- [ ] 2.2 Install the cached state into a new stage session's context before the first navigation (cookies via the server-internal `addCookies`, storage via an origin-scoped init script); evict the entry when the success condition fails after a cache install and continue with the normal login path; tests (silent reuse, rejected cookie evicts and falls through, expired entry not installed, other stage/role untouched).
- [ ] 2.3 Journal/result: the login result and the first journal step record `identity: "cache" | "recipe" | "user"`; add every cached value (and token-shaped substring) to the session's redactor secret set; a mid-run recreated session continues from the latest capture; test that no response, telemetry line or log contains a cookie value.
- [ ] 2.4 Basic credential: capture from the browser's `Authorization: Basic` header after a developer-typed dialog login and re-install it as origin-scoped HTTP credentials sent only on `401`; tests (typed once, reused next run, never sent to another origin, evicted on a `401` after install).

## 3. Forgetting and surfaces

- [ ] 3.1 Stage route `identity` list/forget (value-free), CLI `stage identity list|forget`, dashboard stage action; tests.
- [ ] 3.2 Prove the memory-only rule: a test that the workflow store, snapshots, `telemetry.jsonl`, evidence and a heap-diagnostic dump contain no cached value; a server restart yields an empty cache.

## 4. Docs and verification

- [ ] 4.1 Docs: `docs/agent-environments.md` ("Hosted stages": identity cache, bounds, forgetting, what is and is not cached), `docs/config-inventory.md` (the policy keys and the stage field).
- [ ] 4.2 `bun run type-check` 0 errors, `bun run test`, biome, `openspec validate --changes --strict`.
