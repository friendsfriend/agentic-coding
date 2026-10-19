## Why

`add-stage-oauth2-auth` gives a stage role an OAuth 2.0 token for the grants that need no person: `client_credentials` for a service principal and `refresh_token` for a long-lived refresh token provisioned as a secret. A person's identity is the third case the design names — a test that has to act *as a clerk* — and it cannot be obtained unattended: it needs the authorization code grant, PKCE, a browser in which somebody signs in, and a redirect back into this server.

This change is the part of the original `add-stage-oauth2-auth` plan that needs the interactive-login hand-off: the authorization code grant with PKCE, its single-use loopback receiver, and its connection to the hand-off window the developer already drives. It is split out so the unattended half can be archived and used without waiting for it.

## What Changes

- **Authorization code + PKCE.** For a role whose grant is `authorization_code`, the server creates a PKCE code verifier and its S256 challenge and an opaque `state`, starts a single-use loopback receiver on `127.0.0.1:<ephemeral>`, and opens the provider's authorization URL in the interactive-login hand-off window. The developer completes the sign-in there; the receiver validates `state`, takes the `code` and exchanges it at the token endpoint. The code, the verifier and the tokens never leave the server.
- **The hand-off owns the window and the deadline.** The record, the window, the session lock and the deadline are the ones `add-stage-interactive-login` already specifies; the hand-off ends when the receiver completes, when the deadline passes, or when the developer aborts. A `state` mismatch, a deadline and an abort all end it without a token.
- **`stage_login` for `authorization_code`.** The role's login is a hand-off, reported as `login-needs-user` and waited for with `stage_login_wait`, exactly like the other unautomatable logins.

## Capabilities

### New Capabilities

- `stage-oauth2-auth`: the authorization code grant with PKCE, its loopback receiver and its use of the interactive-login hand-off, added to the stage OAuth 2.0 capability `add-stage-oauth2-auth` introduces.

### Modified Capabilities

None.

## Impact

- `src/server/stages/oauth2.ts` (the PKCE flow, the loopback receiver and the code exchange), `src/server/browser/handoff.ts` and `src/server/browser/routes.ts` (`stage_login` for the `authorization_code` grant), `src/server/stages/routes.ts`, docs (`docs/agent-environments.md`, "Hosted stages").
- No store schema change, no new dependency (`node:crypto` for the verifier and `state`, `node:http` for the loopback receiver). Depends on `add-stage-oauth2-auth` (the providers, the token store and the role recipe it adds) and on the merged `add-stage-interactive-login` (the hand-off record, window, session lock and deadline).
- A provider's app registration must allow a loopback redirect (`http://127.0.0.1:<port>/…`). Where the registration forbids it, this grant is not usable for that provider and the role falls back to the browser hand-off.
