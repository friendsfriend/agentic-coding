## Why

`add-stage-testing-foundation` logs a stage session in only through automated recipes, and those need credentials in the root `.env`. Many hosted stages have neither: test accounts are personal, the developer has no shared password to configure, or the IdP enforces push, number-matching or conditional-access MFA that no recipe can answer. Today such a role ends in `credential-missing` or `login-mfa-required`, and every expectation behind it becomes `blocked`. The developer is sitting at the same machine and could log in within a minute, but the server's browser is headless, so there is no window to type into.

This change lets a stage session hand its login to the developer in a visible browser window. The agent waits, the developer logs in, and the agent continues in the same session without ever seeing the credentials. When nobody is there to log in, a clear failure is returned instead of a window.

## What Changes

- **Login hand-off.** `stage_login` returns a new non-terminal outcome, `login-needs-user`, in two cases. Both apply only under the local policy:
  - the role has no usable credentials (no references configured, or a referenced `${VAR}` is not set);
  - the recipe cannot be automated (an explicit `interactive` recipe, or an MFA step the recipe cannot answer).
  When credentials are configured, the automated recipe path is unchanged: it still runs whenever no login can be reused silently and no hand-off is required.
- **Interactive (headed) browser.** The browser pool lazily launches a second, server-owned Chromium process with a visible window. A session that needs a hand-off is promoted into it: a fresh context opens at the app's login URL and the old headless context is closed. The session then stays in that context, so cookies, localStorage and sessionStorage written by the IdP and the app persist for the rest of the run. Other sessions stay headless.
- **`stage_login_wait`.** This new agent tool blocks server-side, for a bounded time, until the hand-off reaches one of these outcomes: `ok`, `login-handoff-timeout`, `login-handoff-aborted`, or `login-handoff-unverified`. It never returns page content.
- **Session lock.** While a hand-off is active, every agent call that would read or drive the session is refused with `session-held-by-user`. Console and network events from the hand-off are not buffered. After the hand-off, the landing URL is reported as origin plus path only.
- **Attention item.** The hand-off is shown through the existing developer-dialogue mechanism, as a server-created pending record of kind `login-handoff`. It therefore raises the existing dashboard modal, Herdr notification and `question.pending` event. The record is never routed to the orchestrator, and the orchestrator cannot answer it. The developer can complete it with *Done* or *Abort*. The server also completes it on its own when it detects success, when the deadline passes, or when the developer closes the window.
- **Window identity.** The window is marked with an informational agentic-coding banner, shown only during the hand-off. It is brought to the front once when the hand-off starts. It is never raised again, and it is not minimized afterwards.
- **Queue and SSO.** Only one hand-off is active at a time per server. Others wait in a FIFO queue and report their position. A session whose context already holds an IdP session is checked first, so a second app on the same IdP logs in silently, without a second hand-off.
- **Policy seam.** A new `stages/policy.json` key, `interactiveLogin: "local" | "never"`, defaults to `local`. A stage may narrow it to `never`. Under `never`, missing credentials fail with `credential-missing`, roles that need a person fail with `login-user-unavailable`, and no window opens. Role credential references become optional.
- **Limits.** A new stage limit, `limits.maxLoginHandoffSeconds` (default 900), has a policy ceiling (default 1800). It is separate from `maxWaitSeconds`. The idle TTL is suspended while a session is held, and the session keeps its slot.
- **Installer.** Browser status reports whether the resolved browser can open a window (`headed`). The install must never drop headed support. When no headed-capable browser or display is available, the result is `login-handoff-unavailable` instead of a crash.
- **Out of scope.** These are not part of this change:
  - an unattended/server/CI hand-off mechanism (only the `never` seam is added);
  - persistent browser profiles or tokens stored at rest;
  - injecting controls into the stage page.

## Capabilities

### New Capabilities

<!-- None: the behavior extends the stage and browser capabilities introduced by add-stage-testing-foundation and add-agent-browser-sessions. -->

### Modified Capabilities

- `stage-browser-sessions` (introduced by `add-stage-testing-foundation`): adds these requirements:
  - the `login-needs-user` outcome and `stage_login_wait`;
  - the trigger rules;
  - the session lock and the redaction of hand-off state;
  - recording and evidence safety during a hand-off;
  - the hand-off queue and silent SSO reuse;
  - the bounded deadline and its terminal outcomes.
- `stage-configuration` (introduced by `add-stage-testing-foundation`): adds these requirements:
  - the `interactiveLogin` policy and its stage-level narrowing;
  - optional role credentials and the `interactive` recipe kind;
  - the `maxLoginHandoffSeconds` limit and its ceiling;
  - per-role login-mode reporting in `stage_info`.
- `agent-browser-sessions`: the pooled, isolated and bounded session requirement now allows a second, lazily launched interactive browser process for promoted sessions. Browser status reports headed capability, and the install keeps the headed build.
- `workflow-developer-question`: adds the server-created `login-handoff` dialogue record. The record is never routed to the orchestrator, offers no custom answer, has a validated *Done* and an *Abort*, and its system resolution does not resume any run.

## Impact

- **Browser server** (`agentic-coding/src/server/browser/`):
  - `pool.ts`: a second browser slot, promotion, hold state, TTL exemption and owner close.
  - `install.ts`: headed capability and the display check.
  - `types.ts`, `playwright-driver.ts`, `fake-driver.ts`: headed launch and window/banner operations behind the driver boundary.
  - `session.ts`: hold state and buffer suspension.
  - `routes.ts`: the lock guard on every session route.
- **Stage surface** (from the foundation): `stage_login` gains the hand-off branch, plus the new `stage_login_wait` route and agent tool (`agentic-coding/src/agent-host/`). Stage config and policy schemas gain the new keys.
- **Workflow**:
  - `src/contracts/workflow.ts`: dialogue record `kind`.
  - Reducers for the server-created hand-off record and its system resolution.
  - The orchestrator answer refusal.
  - The dashboard question modal: the hand-off presentation, with no custom answer.
  - Event payload `kind`.
- **Docs**: `agentic-coding/docs/agent-environments.md` (Hosted stages), `docs/config-inventory.md`, `docs/settings-inventory.md` (Browser status row).
- **Dependencies:**
  - No new package dependencies.
  - Builds on `add-stage-testing-foundation`, which must land first.
  - Composes with `add-stage-flow-evidence` (recording swap and journal) and `add-stage-test-workflow` (blocked verdicts), and does not change them.
  - The parallel `add-stage-identity-cache` change keeps a successful hand-off in server memory for later sessions. It also covers HTTP-basic credentials the developer types into the browser's own dialog during a hand-off.
