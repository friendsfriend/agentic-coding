## 1. Authorization code with PKCE

- [ ] 1.1 PKCE (verifier, S256 challenge, `state`) and a single-use loopback receiver on `127.0.0.1:<ephemeral>` with a deadline, `state` validation, "you can close this window" page; the code exchange at the token endpoint; the code, the verifier and the tokens stay in the server; tests with a fake authorization server.

## 2. The hand-off

- [ ] 2.1 Connect it to the hand-off: the authorization URL opens through the hand-off record and window, the session lock and deadline apply, the hand-off ends when the receiver completes or the deadline passes; `stage_login` reports the non-terminal `login-needs-user` and the run waits with `stage_login_wait`; tests (success, wrong `state`, timeout, abort).

## 3. Docs and verification

- [ ] 3.1 Docs: `docs/agent-environments.md` ("Hosted stages": the authorization code grant, the loopback redirect an app registration must allow, what a person's identity needs, the client-side-token limit).
- [ ] 3.2 `bun run type-check` 0 errors, `bun run test`, biome, `openspec validate --changes --strict`.
