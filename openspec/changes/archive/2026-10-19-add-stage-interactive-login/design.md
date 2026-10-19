## Context

The foundation (`add-stage-testing-foundation`) gives a stage-bound browser session one way to log in: `stage_login`. It resolves the role's `${VAR}` credential references from the root `.env` inside the server and runs an automated recipe (`form` with multi-page Entra steps and optional TOTP, or `http-basic`). The results are:

- `ok`;
- `credential-missing`, naming the variable;
- `login-mfa-required` (push, SMS, number matching or conditional access);
- `login-failed`, `login-step-not-found`, `login-timeout`.

Any failure leaves the role's expectations `blocked` (`add-stage-test-workflow`).

The browser lives in `agentic-coding/src/server/browser/`. `pool.ts` owns one lazily launched Chromium and gives each session its own `BrowserContext`, under these rules:

- the sessions are capped by `browser.max_sessions` with a FIFO queue;
- idle sessions are swept after `browser.idle_ttl_minutes`;
- the browser is relaunched after a crash;
- the run's sessions are closed when the run ends (`closeOwner`).

Some details matter for this change:

- `playwright-driver.ts` is the only Playwright importer. It launches with `headless: true` through system Chrome (`channel: "chrome"`) or through the installed Chromium under `<configDir>/browsers` (`install.ts`).
- Headless versus headed is a launch option of the browser **process**, not of a context, so a headless context cannot be shown.
- On this machine, Playwright 1.64.0 (Chromium revision 1248) installed both `chromium-1248` (the full Chrome for Testing build, ~366 MB, which can open a window) and `chromium_headless_shell-1248` (~203 MB, which cannot).
- The application never downloads a browser on its own.

Developer questions already have a complete attention path:

- a `DeveloperDialogueRecord` in the workflow snapshot;
- the dashboard question modal;
- the Herdr notification, which fires when a run has an unexpired pending developer question;
- the `question.pending` event on the workflow event stream, which the orchestrator observes.

In orchestrator-started workflows, a question is routed to the orchestrator first (`targetRole: "orchestrator"`), and the orchestrator may answer it.

Settled with the developer before this design:

- The local use case comes first.
- Unattended/CI login is out of scope apart from a `never` seam.
- A hand-off happens when no credentials are configured and when the recipe cannot be automated. Configured credentials keep the automated path.
- Credentials and MFA are typed only in the window.

## Goals / Non-Goals

**Goals:**

- A stage session can hand its login to the developer in a visible window and continue in **the same browser context** afterwards. The IdP's and the app's cookies, localStorage and sessionStorage (MSAL caches tokens there) must survive.
- Only data needed to coordinate the hand-off reaches the agent, the model context, telemetry, logs, evidence, the wiki or reports. Credentials, typed input and page content from the hand-off never do.
- The developer is told reliably, through the attention channels that already exist. The orchestrator cannot answer for the developer.
- Every wait is bounded and every end state is explicit. Timeout, abort, unavailability and policy refusal all end as `blocked` verdicts, not as workflow failures.
- A seam (`interactiveLogin: "never"`) gives a future unattended mode a clear failure instead of a window.

**Non-Goals:**

- An unattended/server/CI hand-off mechanism (remote viewer, device-code flow, service principals).
- Persistent browser profiles, storing tokens at rest, or reusing a login across runs. Persistent profiles remain a possible later option; see D9. In-memory reuse across sessions and runs is the subject of the parallel `add-stage-identity-cache` change. This change only provides it with a successful login to capture.
- Controls injected into the stage page (an in-page *Done* button), or any agent access to the page while it is held.
- Changing how the automated recipes, the recording swap (`add-stage-flow-evidence`) or the stage test workflow phases (`add-stage-test-workflow`) work.

## Decisions

### D1 — A second, lazily launched headed browser; the session is promoted into it

The pool gains a second browser slot, `interactive`, next to the existing headless one. It is launched with `headless: false` the first time a hand-off needs it. It uses the same launch resolution as the headless browser (`install.ts`) and must resolve to a headed-capable executable (D8). It is closed when it holds no session, so no empty window or Dock icon stays behind. A crash marks only its own sessions `browser-crashed`, and it is relaunched single-flight like the headless one.

When `stage_login` decides on a hand-off, it **promotes** the session:

1. It creates a fresh context in the interactive browser with the session's viewport and the foundation's origin/read-only guards. The guards are attached before the first navigation.
2. It opens the application's login URL.
3. It swaps that context in as the session's context and closes the old headless context.

Nothing is carried over. The login always restarts from the app, so any half-finished IdP state is discarded. The session keeps its id, name, owner and pool slot, and it stays in the interactive browser for the rest of its life.

All tokens written during and after the login therefore live in one context. Later agent actions, snapshots, screenshots and recordings run in that same context. A session already living in the interactive browser (after an earlier hand-off) is not promoted again. It navigates to the login URL in its existing context.

Alternatives considered:

- **Headed for every session.** Every debug or verifier run would pop up windows and steal focus. Rejected.
- **Headed from session creation.** Whether a hand-off is needed is known only once `stage_login` resolves the role, its credential status and the recipe, after `browser_open`. Rejected.
- **Log in headed, then relaunch headless with state carried over.** Playwright's `storageState` covers cookies and localStorage but not sessionStorage. The flow-evidence carry-over (`page.evaluate` plus `addInitScript`) is per-origin and fragile across IdP redirects. A second swap would also double the failure surface. Rejected. Keeping the context is the only way that is safe for every token store.
- **A persistent profile (`launchPersistentContext`).** It would put tokens on disk (D9) and allow only one context per profile. Rejected for this change.

### D2 — When a hand-off happens

`stage_login({ session, app, role })` decides in this order:

1. **Recording.** It is refused with `recording-active` while the session records. This is the foundation rule, now also before any hand-off. Recording is never stopped automatically.
2. **Silent SSO check.** This applies when the session already lives in the interactive browser and the recipe declares a success condition. The server navigates to the app and waits up to 10 s for the success condition. If it holds, the result is `ok` with `via: "existing-session"`, and no hand-off happens. This is how a second app on the same IdP logs in once per context. This change copies no login state between contexts: one context per role stays the isolation rule. A login reused across sessions is installed only by `add-stage-identity-cache`, and that change also lets the success condition decide.
3. **Credentials configured** (every referenced variable is set) **and the recipe is automatable.** The automated recipe runs exactly as before.
4. **Hand-off triggers**, each only when the effective policy is `local` (D7):
   - `no-credentials`: the role declares no credential references, or at least one referenced variable is absent or empty.
   - `unautomatable-step`: the recipe is of kind `interactive`, or the automated recipe of step 3 ended in `login-mfa-required`. In that case the headless attempt is discarded and the hand-off restarts from the login URL in a fresh interactive context, so the developer completes the whole login.
5. **Under `never`:**
   - missing references answer `credential-missing` naming the variable, exactly as in the foundation;
   - a role with no references, or an `interactive` recipe, answers `login-user-unavailable`;
   - an MFA step still answers `login-mfa-required`.
   No window opens.

`http-basic` roles do **not** hand off. The plan was for the window to show the browser's own authentication dialog for the application's origin, with no `httpCredentials` on the hand-off context. Spike 0.2 disproved it: a headed Chrome launched by this server fails an unauthenticated `http-basic` navigation immediately with `net::ERR_INVALID_AUTH_CREDENTIALS` instead of showing the dialog, with and without the origin guard's request interception installed (see the verification note in D10). So `http-basic` roles keep the foundation's results — `credential-missing` naming the variable, `login-user-unavailable`, and the automated `http-basic` recipe when its variables are set — under either policy, no window opens for them, and `loginMode` reports `unavailable`. The `stage-browser-sessions` delta is amended to match.

Alternatives considered:

- **Assisted hand-off.** The server would type the configured username and password in the visible window and hand over only at the MFA step. That saves the developer some typing when credentials exist, but the server and the developer would act in the same window, and it doubles the recipe paths. It is left as a later refinement.
- **Asking the developer before opening the window.** This adds a round trip without adding safety, because the window itself is the request.

### D3 — Outcome contract: `login-needs-user`, then `stage_login_wait`

A hand-off makes `stage_login` return immediately with the non-terminal result:

```
login-needs-user {
  handoffId, stage, app, role,
  reason: "no-credentials" | "unautomatable-step",
  state: "queued" | "active",
  queuePosition?, deadlineAt
}
```

The agent then calls `stage_login_wait({ session, timeoutSec? })`. The server blocks for at most the smaller of the remaining deadline and 600 s per call. It returns either the same non-terminal shape (still waiting, so the agent calls again) or one terminal outcome:

- **`ok`**: the success condition was detected. The result carries `via: "handoff"`, `verified: true` and the landing URL as **origin plus path** (D4).
- **`ok` with `verified: false`**: the developer chose *Done* and the recipe declares no success condition.
- **`login-handoff-unverified`**: the developer chose *Done*, but the declared success condition did not hold within a 10 s grace period.
- **`login-handoff-timeout`**: the deadline (D6) passed.
- **`login-handoff-aborted`** with `by: "developer" | "agent" | "window-closed" | "run-ended"`.
- **`login-handoff-unavailable`** with `reason: "headless-only-browser" | "no-display" | "launch-failed"`. This is returned by `stage_login` directly, and no record is created.

Success detection runs in the server. Every second it checks the recipe's success condition against the main frame URL or origin, plus an optional selector-presence check, and only a boolean leaves that check. A second `stage_login` on a held session returns the current `login-needs-user`; it does not start a second hand-off. The terminal outcomes are failures in the foundation's sense. The stage test workflow maps them to `blocked` verdicts with the code as the reason, and a retry is a fresh `stage_login`.

The agent waits inside a tool call, not by handing off `blocked`. A run that ends closes its sessions (`closeOwner`), which aborts the hand-off with `run-ended`, so a parked run could never come back to a logged-in session. The tool description and the stage tester guidance say this explicitly.

Alternatives considered:

- **A long blocking `stage_login`.** Agent tool calls would stay open for up to 30 minutes with no progress signal, and the agent could not tell a queue position from an active window. Rejected.
- **Polling through `stage_info`.** This mixes the catalog with run state and costs a model turn per poll. Rejected.

### D4 — Session lock and redaction

While a hand-off is `queued` or `active`, the session is **held by the user**:

- Every session-addressed agent route is refused with `session-held-by-user { handoffId, deadlineAt }`. This covers `browser_open` on that session name, snapshot, click, fill, press, select, hover, wait, eval, console, network, screenshot, `browser_record_start` and `browser_record_stop`, `browser_run_script`, and the `stage_step`/`stage_wait` tools from `add-stage-flow-evidence`.
- `browser_close` stays allowed and aborts the hand-off (`by: "agent"`).
- `stage_login_wait` and `stage_login` (which rejoins) are the only other calls allowed.
- These refusals do not count against `limits.maxActionsPerMinute`.

At promotion, the session's console and network ring buffers are cleared, and nothing is buffered while it is held. IdP URLs, which can carry a `login_hint` with the developer's account, and console output from the login therefore never become readable later. Snapshot refs are invalidated. Session listings show `heldByUser: true` and only the origin of the current URL.

After the hand-off, the landing URL in `ok` is reported as origin plus path, with query and fragment dropped. This is stricter than the foundation's token-parameter list, because authorization-code, `state` and hint parameters vary by IdP. Later reads follow the foundation's shared redactor.

Telemetry and logs about a hand-off carry only stage, app, role, reason, state, outcome, queue time and duration.

### D5 — Attention item: a server-created `login-handoff` dialogue record

A hand-off becoming `queued` creates one `DeveloperDialogueRecord` with a new optional `kind: "login-handoff"`. A new workflow command does this for the owning run, and the server issues it after the browser route has verified the run's capability.

| Field | Value |
| --- | --- |
| `description` | "Log in to `<app label>` as `<role>` on stage `<displayName>`" |
| `context` | reason, queue position, the hint about the banner, and the deadline. It contains no URL beyond the app's configured origin. |
| `options` | **Done** and **Abort** |
| `expiresAt` | the hand-off deadline |

This reuses the existing attention path:

- the dashboard modal;
- the Herdr notification rule (an unexpired pending developer question means the workflow owes input);
- the `question.pending` event, whose payload gains `kind`, so the orchestrator can tell the developer instead of seeing a silent stall.

These rules are specific to the kind:

- **No orchestrator routing.** The record is never marked `targetRole: "orchestrator"`, even in orchestrator-started workflows, and an orchestrator answer is rejected. Only a person at the machine can log in.
- **No custom answer.** The modal offers no custom text answer for this kind. It shows the stage, app, role, reason and deadline, says to look for the agentic-coding window, and offers *Done* and *Abort* (Escape means *Abort*).
- **How the server reacts.** The hand-off coordinator watches the workflow's updates on the same `workflow.updated` path that the event bus derives from.
  - *Done* triggers the success check and its 10 s grace period (D3).
  - *Abort* ends the hand-off as `aborted`.
  - A resolution by the system (success, timeout, window closed, run ended, agent close) moves the record to `answered` with a system answer, or to `expired` at the deadline. It never invokes the rule that an answered question resumes the blocked asking run. The asking run is not blocked; it is waiting in `stage_login_wait`.
- **Not prior dialogue.** The record is excluded from the "prior dialogue" text of later assignments. It holds no decision context.
- **Server restart.** If the server restarts during a hand-off, both browsers die with it. The pending record then expires at its deadline through the existing question timer, and a later `stage_login` starts a new hand-off.

Alternatives considered:

- **A new attention-item type.** It would need its own event, notification rule, dashboard surface and orchestrator handling, all of which the dialogue record already has. Rejected.
- **A plain `attention-required` workflow status.** That status means "needs repair", would not carry Done/Abort, and would stop the run. Rejected.
- **A "Done" button injected into the page** through `exposeBinding`. It changes the page under test, and page scripts could call the binding. Rejected; the dashboard is the trusted surface.

### D6 — Queueing, deadline and limits

- **One active hand-off per server.** One developer has one screen. Further hand-offs, across sessions and workflows, wait in a FIFO queue. The queue position is reported in `login-needs-user` and in the record's context. The next window opens only when the previous hand-off ends.
- **The deadline.** It is fixed when the hand-off is requested: `requestedAt + limits.maxLoginHandoffSeconds`, default 900 s. Queue time counts toward it, so the agent's wall-clock wait has one known bound. The value is clamped to the policy ceiling `ceilings.maxLoginHandoffSeconds`, default 1800, which is below the default `stall_minutes` of 30 — and that 1800 s is a **hard** ceiling of the feature, applied even when the policy declares no `ceilings` at all. It is separate from `maxWaitSeconds`, which bounds automated `stage_wait` against a system rather than a person. When the deadline passes on an *activated* hand-off, the window is closed and the session is marked unusable, so the run's next call is answered `browser-crashed` and the agent decides whether a login is worth another window; a hand-off that was still queued never had one to close.
- **Slots.** A held session keeps its pool slot. It counts against `browser.max_sessions` and the stage's `maxSessions` throughout, and promotion takes no new slot. The idle TTL sweep skips held sessions, because the deadline bounds them, and resumes when the hand-off ends.
- **Rate limit.** Each `stage_login_wait` call counts as one stage action. The run makes no model turn while it waits.
- **Multiple roles.** Several roles mean several sessions and so several hand-offs, served in order. The planner sees in advance which roles need a person through `stage_info`'s login mode (D7), so `add-stage-test-workflow` can name them in the plan. That change does not need to be edited for this.

### D7 — Policy seam and configuration

- **`stages/policy.json`** gains `interactiveLogin: "local" | "never"`, default `local`. A stage file may set `interactiveLogin: "never"` to narrow it, and may never widen it.
- **Display check.** The effective mode is also treated as unavailable when the server has no display: Linux without `DISPLAY` or `WAYLAND_DISPLAY`. macOS is assumed to have one, and a failed launch reports `launch-failed`.
- **Role credential references become optional.** A role with no `username`, `password` or `totp` reference is valid, and its credential status is the new value `none`.
- **New recipe kind `interactive`.** It has no fields and only a required `success` condition. It marks a role that always needs a person, such as a known number-matching account.
- **`stage_info` and the Settings Stages section** report, per role, a `loginMode`:
  - `automated`: credentials set and the recipe is automatable;
  - `handoff`: it would hand off under `local`;
  - `unavailable`: it would fail under `never`.
- **New limit.** `limits.maxLoginHandoffSeconds` comes with its ceiling.
- **No secrets in policy.** Nothing in the policy or the stage files can name a secret value; the foundation's validation rules still apply.

### D8 — Installer and bundle: headed capability

`resolveLaunch` gains a `headed` flag, and the browser status gains `headed: boolean` (headed-capable).

| Browser | Headed-capable? |
| --- | --- |
| System Chrome | yes |
| The full installed `chromium-<rev>` build | yes |
| A `chromium_headless_shell-<rev>` executable | no |

The opt-in install keeps running `playwright install chromium`. With Playwright 1.64 that already fetches the full build, so no extra download is needed today. The install must never pass `--only-shell`, and a test pins this. Skipping the unused shell with `--no-shell` would save ~203 MB, but that is a separate optimization.

There is no offline browser bundle. The compiled artifact carries only the Playwright version and revision constants, so nothing changes there.

A hand-off with no headed-capable browser answers `login-handoff-unavailable` with `reason: "headless-only-browser"` and the hint Settings → Browser → Install, the same as the existing `browser-unavailable` hint.

### D9 — No tokens at rest; persistent profile is a non-goal

Interactive contexts are ordinary in-memory contexts of a launched browser. Playwright uses a temporary profile and removes it on close. This change itself reads no storage state of a held session. A promoted session's state is read only by the existing recording swap after the hand-off, and by the in-memory capture of `add-stage-identity-cache` when that change is present. Neither writes to disk. This change never persists cookies or tokens and never exports them as evidence. Without the identity cache, the login lasts as long as the session: closing the session, ending the run, an idle sweep or a crash requires a new login.

A persistent per-stage, per-role profile (`launchPersistentContext` under `<configDir>`) would save repeated logins. It would also store long-lived refresh tokens for test accounts on disk and need encryption, expiry and a revocation UI. It is recorded as a possible future option and is not specified here.

### D10 — Window identity, focus and recording

- **Banner.** At promotion, an init script in the interactive context renders a fixed, non-interactive banner in a closed shadow root while the hand-off is active. It reads: "agentic-coding · stage `<displayName>` · log in to `<app>` as `<role>` — the agent waits; close this window to abort". On success or end, the server removes it from every page, and the init script stops rendering it. It contains no controls and no links. A test pins that no later snapshot or screenshot shows it. Init scripts run outside the page's content security policy, so the IdP's CSP does not block them.
- **Window size.** The window opens at the session viewport.
- **Focus.** At activation, the server calls `page.bringToFront()` once. On macOS it also activates the browser application, best effort and bounded; a failure is only a diagnostic. It never raises the window again. Agent actions after the hand-off go to the window without activating it. Playwright's default flags (`--disable-backgrounding-occluded-windows`, no renderer or timer throttling) keep an occluded window rendering. The window is **not minimized** after the hand-off: CDP screenshots of minimized windows are unreliable on macOS, and a spike task checks this before any change of mind. A window closed by the developer after the hand-off ends that session through the existing closed-page handling; the next call answers `browser-crashed` or reopens the session.
- **Recording.** `stage_login` is refused with `recording-active` while recording, and `browser_record_start` is refused with `session-held-by-user` while the session is held. So no video, poster, screenshot or saved script can capture the login. Recording after the hand-off is allowed. The swap for a promoted session builds the recording context inside the interactive browser, so a new window replaces the old one. sessionStorage carries over only through the `add-stage-flow-evidence` carry-over when that change has landed.
- **Journal.** If the phase-2 journal exists, the hand-off adds one entry with only the outcome, reason and duration.

  **Verification note (attempts 1 and 2).** Attempt 1 ran no spike and left these decisions unverified. Attempt 2 ran the parts of task 0.2 a script can run on macOS, outside the opt-in smoke test (`bun` against the real driver and a local fixture, nothing written into the repository), with these results:

  - **Headed launch works.** `headedAvailability()` answers `ok`; `resolveLaunch({ headed: true })` picks system Chrome (`/Applications/Google Chrome.app`, `channel: "chrome"`, `headless: false`) and the window opens. The installed `chromium-<rev>` build and `headless_shell` refusal were not exercised again — `test/browser-settings.test.ts` covers the resolution rules without a download.
  - **`bringToFront` works**, and a CDP screenshot of the headed window returns an image while the window sits behind the terminal, so an occluded window is not a problem. Application activation on macOS remains a bounded best effort that no test asserts, and a *minimized* window was not exercised: the decision to keep the window un-minimized stands, and no change of mind is justified.
  - **A real promotion works.** A `stage_login` hand-off promoted a live session into a headed Chrome (`browserSlot: "interactive"`), the window opened on the login URL with the banner init script installed on its context, and after the login page submitted, the session answered `ok` and the agent's next snapshot showed the signed-in page.
  - **The `http-basic` dialog does not appear.** A headed Chrome launched exactly as this server launches it fails a `502`-free, unauthenticated `http-basic` navigation within ~20 ms with `net::ERR_INVALID_AUTH_CREDENTIALS`, both with and without a context-level route interceptor installed. The browser cannot prompt, so a hand-off for such a role could never be answered: the `http-basic` sentence of the trigger requirement is amended (no hand-off; the foundation's `credential-missing` / `login-user-unavailable` results stand, and `loginMode` reports `unavailable`) and `stage_login` no longer opens a window for one. This is the fallback this design named, applied on the evidence rather than on a hunch.
  - **Not verified here:** the banner on `login.microsoftonline.com` (needs a real tenant). A manual end-to-end pass, where a person types in the window, is out of scope: the scripted run above typed through the page's own form instead. It is an open item, not a claim.


## Risks / Trade-offs

- **The developer keeps clicking in the window after the hand-off**, while the agent drives the same page. → The banner says the window belongs to the agent until the hand-off ends, and the docs say to leave it alone afterwards. Concurrent input after the hand-off is an accepted, documented risk; the window is not locked against input.
- **The recording swap opens a new window, which may take focus on macOS.** → This is documented. Recording a promoted session is rare and starts after the login.
- **Herdr notifications are opt-in** (`ui.herdr_notifications` is disabled by default), so the developer may not be told outside the dashboard. → The window is brought to the front once, the dashboard modal opens, and the orchestrator sees `question.pending` with `kind: "login-handoff"`. The deadline bounds an unnoticed hand-off.
- **IdP account data in URLs** (`login_hint`, `username`). → Buffers are suspended, the landing URL is origin plus path only, and telemetry carries only coordination fields.
- **A queue across workflows can starve a late hand-off within its deadline.** → The deadline is per hand-off and queue time is visible. Timeouts end in `blocked` verdicts, not failures.
- **Archive ordering.** The deltas for `stage-browser-sessions` and `stage-configuration` are ADDED requirements on capabilities that `add-stage-testing-foundation` creates. → This change must be archived after the foundation, as tasks.md states.
- **MFA restart cost.** An `unautomatable-step` hand-off restarts the login, so the developer types credentials that are already configured. → An `interactive` recipe declares this up front. Assisted hand-off remains possible later (D2).
- **System Chrome windows look like the developer's own Chrome.** → The banner identifies the window. The context uses a temporary profile, so neither the developer's profile nor the developer's cookies are involved.

## Migration Plan

- The change is additive.
- Stage files without the new keys behave as before, except that roles with unset variables now hand off under the default `local` policy instead of answering `credential-missing`. Operators who want the old behavior set `interactiveLogin: "never"`.
- No store schema version change is needed: `kind` is an optional field of the dialogue record in the snapshot JSON.
- Rollback means removing the policy key or reverting. A pending hand-off record from a reverted server expires at its deadline.

## Open Questions

- **Do Microsoft Entra conditional-access policies treat a temporary-profile Chrome for Testing window as an unmanaged device?** They might then block the login altogether, and only a real run on the target tenant shows this. It is carried over from the foundation's MFA question, and the documentation records the result.
- **Should `--no-shell` be used for the opt-in install?** It would save ~203 MB. This belongs to a separate installer change and does not block this one.
- **Should the assisted hand-off of D2 become the default** once the basic flow has proved itself?
