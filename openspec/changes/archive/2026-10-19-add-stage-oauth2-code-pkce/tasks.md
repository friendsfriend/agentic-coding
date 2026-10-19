## 1. Authorization code with PKCE

- [x] 1.1 PKCE (verifier, S256 challenge, `state`) and a single-use loopback receiver on `127.0.0.1:<ephemeral>` with a deadline, `state` validation, "you can close this window" page; the code exchange at the token endpoint; the code, the verifier and the tokens stay in the server; tests with a fake authorization server.

## 2. The hand-off

- [x] 2.1 Connect it to the hand-off: the authorization URL opens through the hand-off record and window, the session lock and deadline apply, the hand-off ends when the receiver completes or the deadline passes; `stage_login` reports the non-terminal `login-needs-user` and the run waits with `stage_login_wait`; tests (success, wrong `state`, timeout, abort).

## 3. Docs and verification

- [x] 3.1 Docs: `docs/agent-environments.md` ("Hosted stages": the authorization code grant, the loopback redirect an app registration must allow, what a person's identity needs, the client-side-token limit).
- [x] 3.2 `bun run type-check` 0 errors, biome, `openspec validate --changes --strict`, and the focused tests of this change (`test/stage-oauth2-code-pkce.test.ts`, `test/browser-stage-sessions.test.ts`, `test/stage-oauth2-schema.test.ts`, `test/stage-oauth2-tokens.test.ts`). The whole `bun run test` suite is the test-verifier's gate, not this task's.

## Manual checks (pending for the developer)

Nothing here gates the change; it needs a person and a tenant.

- Pending for the developer: a real identity provider with a public client and a loopback redirect (the reference is an Entra app registration whose platform is "Mobile and desktop applications" with `http://127.0.0.1` callbacks). Open a stage whose role declares `grant: "authorization_code"`, run `stage_login`, sign in in the window, and confirm `stage_login_wait` answers `ok` with `via: "token"` and that `stage_token_info` then reports the token's expiry.
