## Context

- `add-stage-oauth2-auth` supplies everything this change builds on: named OAuth 2.0 providers on a stage (`tokenEndpoint`, `authorizationEndpoint`, references for the client id and the optional client secret, scopes, audience, `clientAuth`), the role recipe `{ "login": "oauth2", "provider", "grant" }`, the in-memory token store with its single-flight renewal, the redaction of every token form, `stage_api_request`, `stage_token_info` and the scoped browser bearer header.
- `add-stage-interactive-login` (merged) supplies the hand-off: one attention record, one headed window the server opens and owns, a session lock that keeps other calls off the session while the developer works, a deadline bounded by `stages/policy.json` and the stage, and the terminal outcomes `ok`, `login-handoff-unverified`, `login-handoff-timeout`, `login-handoff-aborted` and `login-handoff-unavailable`.
- The two unattended grants are the natural login of the backend and of a provisioned service identity. A person's identity — a clerk role in a UI test — cannot use them: it needs the authorization code grant, and the person part is exactly the developer typing into a window.

## Goals / Non-Goals

**Goals:** obtain a token of a role whose grant is `authorization_code` with PKCE, through the hand-off window the developer already drives, with the code, the verifier and the tokens held by the server only.

**Non-Goals:** a device-code grant; a second window or a second interaction mechanism of its own (this change uses the hand-off as it is); automatic token refresh by a page's own client-side identity library; a public redirect target other than loopback.

## Decisions

### D1 — PKCE first, and a loopback redirect the registration has to allow

A code verifier (43–128 characters of an unreserved alphabet) and its S256 challenge (base64url of the SHA-256 digest, unpadded) are created with `node:crypto`, together with an opaque `state`. The redirect URI is `http://127.0.0.1:<ephemeral>/callback` on a single-use `node:http` server bound to the loopback interface only, started before the authorization URL is opened so the port is known.

The provider's app registration must allow a loopback redirect. Entra permits loopback redirects for public clients with any port, so an ephemeral port works there. A registration that forbids it makes this grant unusable for that provider, and the role keeps the browser hand-off; that is a documented operator decision, not a fallback the server invents.

Rejected: a fixed port (another process may hold it, and two stage logins in parallel would collide); a custom URI scheme (it needs an OS-level handler registration); a public hosted callback (this server has no public origin).

### D2 — The receiver validates `state`, answers once, and shows one page

The receiver accepts exactly one callback request, compares `state` in constant time, and answers a short "you can close this window" page. A callback whose `state` does not match never reaches the token endpoint: the receiver answers a page that says the sign-in did not complete and the hand-off ends without a token. The receiver is closed on every path — success, mismatch, deadline and abort — so no port stays bound after a login.

The provider's own `error`/`error_description` on the callback is mapped to the same value-free `login-failed` code the token endpoint's errors use, after redaction.

### D3 — The hand-off owns the window, the lock and the deadline

The authorization URL opens through `add-stage-interactive-login`'s hand-off record and window: the same attention entry, the same session lock, the same deadline (`maxLoginHandoffSeconds`, ceilinged at 1800 s) and the same abort paths. This change adds no second mechanism and no second window. `stage_login` answers the non-terminal `login-needs-user` immediately, and the run waits inside `stage_login_wait`; the hand-off reports `ok` with `via: "token"` when the receiver has completed and the token is in the store.

A deadline, an abort or a closed window ends the hand-off and stops the receiver; nothing of the exchange survives it.

### D4 — What the model may learn is unchanged

The authorization code, the verifier and the tokens join the redaction set `add-stage-oauth2-auth` already installs, and no tool result, log line, telemetry attribute, evidence file or report carries them. The agent learns the outcome and, through `stage_token_info`, the expiry, scopes, audience and issuer — never a claim, a code or a token.

### D5 — As built: two seams the hand-off needed, and nothing else

Implementing D3 showed that the hand-off needed exactly two additions, both of them inside its own mechanism:

- **A completion the page cannot answer.** A declared recipe succeeds when the page reaches a URL; a code-grant login succeeds when *this server's* receiver has the token, whatever the window shows last. `LoginHandoffRequest` therefore takes an optional `completion` (`poll()`, `close()`, an optional `land()` and the URL the outcome reports), polled on the hand-off's own tick before any page-based success condition, and the coordinator gained one outcome (`failed`) that carries the server's own value-free `StageAuthError`. `close()` runs on every ending path, so the receiver is released by the hand-off's teardown rather than by each caller.
- **One origin a stage session may reach.** The provider's redirect is a main-frame navigation to `http://127.0.0.1:<port>`, an origin no stage declares. `BrowserPool` keeps the allowance per session as a *set* (`allowHandoffRedirect` / `clearHandoffRedirect` / `handoffRedirect`), and a flow releases **its own** origin, so two logins that race on one session leave exactly the winner's allowance behind. `createStageGuard` reads `policy.origins` per navigation instead of snapshotting it, and a session's context defers to the session's own guard from creation on, so a fresh *and* a reused interactive context both see the addition and its removal. Nothing else about the session's binding changes, and the allowance is dropped when the session is dropped.

Three smaller decisions worth stating: a *Done* from the developer is never an `ok` for this grant (only the receiver completing is), so it ends as `login-handoff-unverified` after the hand-off's grace period and neither the window's banner nor the dashboard record offers that *Done* — the record is opened with `canConfirm: false`, which is how the reducer learns to list *Abort* alone (USAB-207); a request that merely needs a token never starts a sign-in, so `stage_token_info`, `stage_api_request` and the bearer header refuse an empty store with `login-failed` (`interactive_login_required`) from inside the acquisition they hand to `StageTokenStore.token` — that refusal is remembered for the failure TTL like any other, and what keeps the hand-off unblocked is not where it is thrown but the exclusive registration described below, which skips the fast path, the remembered failure and the join (OAS-103); and the grant a token is renewed with is the one the *store* says the role can use: a code-grant role that has no refresh token (the provider issued none, or the hand-off has not run yet) asks for `stage_login` again rather than being renewed with a grant it has nothing for.

The hand-off's own registration is exclusive: `StageTokenStore.token` takes an option that skips the existing-token fast path, the remembered failure and the join on a pending acquisition, so a login this server just completed is never answered with a refusal remembered for an earlier attempt — and a second `stage_login` on a signed-in role really exchanges its own code instead of returning the stored token. Two rules of that path follow from what the exchange is: an exclusive acquisition is never *published* for others to join, and, because it read no entry, its failure evicts none (a stale sign-in cannot delete a token that was working), while a plain renewal loses its rotated refresh token only to the provider's own refusal — a transport failure, a timeout or a 5xx keeps it, because for a code-grant role that value is the only way back to a token (CONC-004, CONC-006, QUALITY-005). The flow's `ok` is then read from the store rather than from the promise: a write a `forget` or an `expire` discarded during the exchange is a failed login, not a success the agent would have to disprove later (CONC-005). The receiver reports the address it actually bound (`address`, `port`) and the redirect URI is built from it; a bind failure is one value-free `StageAuthError` naming the cause, and because the verifier is registered only after the receiver exists, a failure there leaves nothing registered by construction. The `state` and the authorization code stay in the redaction set after the login ends (a callback URL can be replayed; the verifier only lives as long as the flow), which is bounded rather than eternal: the set is one list with a total cap of 64 values, a finished login leaves two of them — its `state` and the code its receiver took — so roughly the last 32 logins stay covered and the oldest value falls out, one per value added (OAS-104, SEC-001). The hand-off's reason is `user-identity` so the banner and the record say *why* a person is needed, and a pre-flight refusal answers `credential-missing` with the variable that is actually unset — the provider's client id *or* the client secret it declares — instead of assuming the client id (USAB-206); a provider that declares no client id reference at all never gets that far, because its stage file is refused at load with `oauth2.providers.<name>.clientId` named, since no `.env` value could fill it, and `resolveStageOAuthCredential` answers an undeclared field the same way rather than promising a `.env` remedy (USAB-208).

## Risks / Trade-offs

- [A registration forbids a loopback redirect] → documented; the role falls back to the browser hand-off, and this grant is simply not usable for that provider.
- [The provider's consent screen asks for something the developer cannot complete (MFA, tenant policy)] → the hand-off's deadline and abort paths already answer it, and nothing of the attempt is retained.
- [A terminal or agent sees the loopback URL] → the URL carries only the client id, the scopes, the challenge and the `state`; no token and no code ever appears in it before the receiver takes it.
- [Two logins of two roles race] → each starts its own single-use receiver and its own hand-off; the session lock keeps them from overlapping on one session, and on one session the loser releases only its own origin (the winner's allowance survives).
- [A token endpoint answers with an unbounded or oversized body] → the exchange reads the response through a byte cap (a declared `content-length` above it is refused before reading anything and that body is cancelled, and a streamed one is cancelled as soon as the cap is passed), so a broken or hostile provider can neither make the server buffer without limit nor hold a connection open with an answer it refused.
- [The agent cannot see how far a code login got] → the wait only answers `ok` when the token is in the store, and every other ending names itself (`login-handoff-unverified` / `-timeout` / `-aborted`, `login-failed`); no value is in any of them.
