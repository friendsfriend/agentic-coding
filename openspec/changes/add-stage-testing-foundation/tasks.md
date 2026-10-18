## 1. Stage catalog (configuration domain)

- [ ] 1.1 Add `agentic-coding/src/server/stages/schema.ts`: Effect Schema for a stage definition and `stages/policy.json` (`ident`, `displayName`, `environment`, `system`, `access`, `planApproval`, `exclusive`, `insecureHttp`, `apps.{key}.{label,app?,url,kind,api?,roles,version?}`, `logins`, `allowedOrigins`, `readOnlyExceptions`, `data`, `limits`, `wiki.processes`; policy `deniedHostPatterns`, `ceilings`).
- [ ] 1.2 Add `src/server/stages/catalog.ts`: read `stages/definitions/*.json` and `stages/policy.json` from the canonical config root only (`src/config-root.ts`), validate (ident = file stem, production-like names, denied hosts, https rule, `${VAR}`-only credential fields, declared login recipes, known `app` idents from `apps/definitions`, ceiling clamping), derive each stage's origin allow-list, and report value-free diagnostics; credential status per role from `.env` presence (`src/env-file.ts`) without returning values.
- [ ] 1.3 Add `resolveStageCredential(stage, app, role, field)` that resolves a reference from `.env` at call time and is the only function returning a value; keep it server-internal (not exported through any route module).
- [ ] 1.4 Unit tests for the catalog with temporary config roots: valid stage, overlay ignored, ident mismatch, production refusal, denied host, http refusal and `insecureHttp`, literal credential refusal without the value in diagnostics, missing variable status, unknown app ident, ceiling clamp.

## 2. Read surfaces

- [ ] 2.1 Add `GET /api/v1/stages` (authenticated dashboard/Settings) and `GET /api/v1/agent-env/stages[/{ident}]` (owner capability) returning structure, credential status and diagnostics; version probes for the agent route with a bounded timeout and the shared redactor (`src/server/environment/agent-routes.ts` `environmentSecrets`/`redact`).
- [ ] 2.2 Add the `stage_info` agent tool in `src/agent-host/` (description states it never returns secrets) and include it in the codemode tool list.
- [ ] 2.3 Route tests: no `.env` value in any response (seed `.env` with sentinel values and assert absence), probe success / timeout → `not discoverable`.

## 3. Stage-bound browser sessions

- [ ] 3.1 Extend `src/contracts/browser.ts`: `browserOpenRequestSchema` gains `stage`, `stageApp`, `path`; `browserActionRequestSchema` gains `credential: { app, role, field }` (mutually exclusive with `value`); add the `stage_login` request schema and the new error codes (`stage-not-configured`, `stage-app-unknown`, `stage-mismatch`, `origin-not-allowed`, `stage-read-only`, `stage-rate-limit`, `stage-held`, `stage-session-restricted`, `recording-active`, `credential-missing`, `login-failed`, `login-mfa-required`, `login-timeout`).
- [ ] 3.2 `src/server/browser/routes.ts` `resolveOpenUrl`: resolve stage opens from the catalog; bind the session (`session.ts` gains an optional immutable stage binding); refuse re-binding and off-list raw URLs; leave non-stage opens unchanged.
- [ ] 3.3 `pool.ts` / `playwright-driver.ts` / `fake-driver.ts`: install the context route guard on stage-bound contexts (main-frame origin guard, read-only method guard with exceptions, `http-basic` credentials at context creation), surface guard events on the next tool result; keep the guard installed on the recording context after a swap.
- [ ] 3.4 Session limits: per-stage `maxSessions`, rolling `maxActionsPerMinute` counter per workflow+stage, in-memory exclusive lease released when the workflow's last session on the stage closes (including run end and idle TTL).
- [ ] 3.5 `stage_login` route + tool: run `form` (ordered multi-page `steps` with optional prompt steps, as an Entra ID login needs; `login-step-not-found`, `login-not-required` for an application without roles) / `http-basic` recipes, RFC 6238 TOTP via `node:crypto`, bounded success wait, failure codes; refuse while recording; record which elements received credentials for masking.
- [ ] 3.6 `browser_fill` with `credential`: resolve server-side, refuse while recording, refuse on a non-stage session.
- [ ] 3.7 Screenshot masking for stage sessions (`input[type=password]` + credential-filled elements); script facade refuses `context.cookies` / `storageState` / `addCookies` on stage sessions; saved repro spec gets an env-name login preamble.
- [ ] 3.8 Driver-level tests with the fake driver: stage open resolution, origin guard (redirect off-list aborted, IdP allowed), read-only guard and exception, rate limit, exclusive lease, login success/missing variable/MFA/recording refusal, masking options passed, facade refusal, repro spec contains variable names but no values.

## 4. Redaction of browser output (all sessions)

- [ ] 4.1 Apply the shared redactor plus a URL sanitizer for token-like query/fragment parameters to every browser route response and error in `src/server/browser/routes.ts`; add the session's resolved credentials and their URL-encoded forms to the redaction set of a stage session.
- [ ] 4.2 Tests: secret in page text, token in callback URL fragment, eval returning a credential-filled input value, console line containing a `.env` value — each redacted.

## 5. Settings and documentation

- [ ] 5.1 Settings: read-only **Stages** section (catalog entry in `src/tui/settings/catalog.ts`) showing validation state, diagnostics, access, apps and credential status; "set credential" through the protected `.env` credential flow writing only the referenced key, masked.
- [ ] 5.2 Docs: `docs/config-inventory.md` (new `stages/` tree and ownership), `docs/settings-inventory.md` (Stages section), `docs/agent-environments.md` ("Hosted stages": allow-list, login, redaction, limits), browser tool descriptions mention stage opens and `stage_login`.

## 6. Focused checks

- [ ] 6.1 Run only the new and touched test files (catalog, stage routes, browser routes/pool with the fake driver, Settings Stages section) plus `bun run type-check` and `bun run lint` in `agentic-coding/`; no real stage, no real browser, no real `.env` in tests.
