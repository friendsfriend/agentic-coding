## 0. Preconditions

- [ ] 0.1 Confirm `add-stage-testing-foundation` has landed: the stage config, `stage_login` recipes and stage-bound sessions exist in code. This change must be archived after that one, because its `stage-browser-sessions` and `stage-configuration` deltas add to capabilities the foundation creates.
- [ ] 0.2 Spike on macOS with the real driver (opt-in, `DEVENV_SMOKE_BROWSER=1`). Record the outcome in `design.md` D10, and keep "do not minimize" unless the spike proves minimized windows reliable. Check four things:
  - a headed launch of system Chrome and of the installed `chromium-<rev>` build;
  - `page.bringToFront()` plus application activation;
  - whether a snapshot and a screenshot work while the window is occluded and while it is minimized;
  - whether a context-level init-script banner renders on `login.microsoftonline.com`;
  - whether Chromium's native HTTP-basic dialog appears in a headed window while the origin guard's request interception is active. If it does not, amend the `http-basic` sentence of the trigger requirement and keep `credential-missing` for those roles.

## 1. Browser driver and install (agent-browser-sessions)

- [ ] 1.1 Extend the driver boundary in `src/server/browser/types.ts`, `playwright-driver.ts` and `fake-driver.ts`:
  - `headless: false` launches;
  - a context-level init script, plus a page-level remove call for the banner;
  - `bringToFront`;
  - a page-close signal that tells a window closed by the user apart from a server close.
  The fake driver records headed launches, banner state and focus calls, so tests need no real window.
- [ ] 1.2 In `install.ts`:
  - add `headed` capability detection (system Chrome or a full `chromium-<rev>` means yes; `headless_shell` means no) and `resolveLaunch({ headed })`;
  - add the display check (Linux needs `DISPLAY` or `WAYLAND_DISPLAY`);
  - expose `headed` in the browser status contract (`src/contracts/browser.ts`).
  Tests in `test/browser-settings.test.ts` cover: headed true for system Chrome and for the full build, false for a shell-only install, and the install command never containing `--only-shell`.
- [ ] 1.3 In `pool.ts`:
  - add the second, lazily launched interactive browser slot, with single-flight launch, crash marking of only its own sessions, relaunch, and close when empty;
  - add `promote(sessionId)`: open a fresh context with guards attached, navigate to the login URL, close the headless context, and keep the id, name, owner and slot;
  - exempt held sessions from the idle sweep;
  - make `closeOwner` abort held sessions.
  Tests in `test/browser-pool.test.ts` with the fake driver cover: no interactive launch without a hand-off, promotion keeping the slot, isolation between two promoted sessions, the interactive browser closing when its last session closes, a held session not being swept, crash isolation between the two browsers, and owner close during a hold.
- [ ] 1.4 Make the recording swap of a promoted session create its recording context in the interactive browser. Add one pool test for this.

## 2. Stage configuration (stage-configuration)

- [ ] 2.1 Extend the stage and policy schemas:
  - `interactiveLogin` in the policy, plus stage-level narrowing with the widening diagnostic;
  - optional role credential references, with credential status `none`;
  - recipe kind `interactive` with a required `success`;
  - `limits.maxLoginHandoffSeconds` (default 900) and `ceilings.maxLoginHandoffSeconds` (default 1800), with clamping.
  Add focused config validation tests for each of these, next to the foundation's stage config tests.
- [ ] 2.2 Compute `loginMode` (`automated`, `handoff` or `unavailable`) per role, and report it in `stage_info` and in the Settings Stages section. Add tests that cover all three modes under both policies, and that check no credential value appears.

## 3. Hand-off coordinator and stage tools (stage-browser-sessions)

- [ ] 3.1 Add a server-side hand-off coordinator (in or next to the stage login module). It handles:
  - the single active slot and the FIFO queue;
  - the deadline computed from the request time;
  - the success detector, polled about once per second and returning only a boolean;
  - the 10 s silent-SSO check and the 10 s grace period after Done;
  - the terminal outcomes `ok`, `login-handoff-unverified`, `login-handoff-timeout`, `login-handoff-aborted` (with `by`) and `login-handoff-unavailable`.
  Unit-test it with fake clocks and the fake driver.
- [ ] 3.2 Extend `stage_login` with the trigger order of the spec:
  - the `recording-active` check first;
  - the automated path when credentials are set;
  - `no-credentials` and `unautomatable-step` hand-offs under `local`, including the discarded headless MFA attempt;
  - `credential-missing`, `login-user-unavailable` and `login-mfa-required` under `never`;
  - `http-basic` roles handing off without HTTP credentials on the context;
  - a second call on a held session rejoining the pending hand-off.
  Add focused route tests for each branch.
- [ ] 3.3 Add the `stage_login_wait` route and agent tool (`src/agent-host/`). The wait is capped at the smaller of the remaining deadline and 600 s, and each call counts as one stage action. The tool description says to wait in the tool, not to hand off `blocked`. Add tool tests in the style of `test/agent-host-browser-tools.test.ts`.
- [ ] 3.4 Add the held-session guard to every session-addressed browser and stage route in `routes.ts`:
  - those routes are refused with `session-held-by-user`, and the refusal is not counted against the rate limit;
  - `browser_close` aborts the hand-off with `by: "agent"`;
  - console and network buffers are cleared at promotion and not filled while held;
  - snapshot refs are invalidated;
  - listings show `heldByUser` and the origin only.
  Add route tests that check every guarded route is refused during a hold, including `browser_record_start`, `browser_screenshot` and `browser_run_script`.
- [ ] 3.5 Banner and focus: install the banner when a hand-off becomes active and remove it when it ends. Call `bringToFront` once, plus the macOS activation as a bounded best effort, and never at any other time. Add fake-driver tests that check the banner is absent from the snapshot after the hand-off and that agent actions make no focus call.
- [ ] 3.6 Leak test. Simulate a hand-off with the fake driver in which the "developer" types sentinel credentials and the IdP redirect carries sentinel `code`, `state` and `login_hint` parameters. Assert that no sentinel appears in:
  - the agent results;
  - `browser_network` or `browser_console` after the hand-off;
  - server log lines;
  - captured telemetry attributes;
  - the workflow dialogue record.
  Also assert that no profile or storage-state file remains under the configuration directory after close.
- [ ] 3.7 Hand-off telemetry and logs carry only stage, app, role, reason, state, outcome, queue time and duration. Write one journal entry (outcome, reason, duration) when the `add-stage-flow-evidence` journal is present.

## 4. Attention record (workflow-developer-question)

- [ ] 4.1 In `src/contracts/workflow.ts`, add the optional `kind: "login-handoff"` field to `DeveloperDialogueRecord`. Add workflow commands that create the record for the owning run and resolve it from the system, with reducers that:
  - never set the orchestrator routing marker;
  - reject an orchestrator answer to this kind;
  - never call the resume rule;
  - expire the record through the existing question timer at the deadline.
  Add focused tests in `test/workflow-question.test.ts` for creation, the orchestrator-started workflow, the orchestrator answer rejection, system resolution without resume, and expiry.
- [ ] 4.2 Make the coordinator react to developer answers on the `workflow.updated` path: Done triggers the success check with its grace period, and Abort ends the hand-off. Test both together with the coordinator from 3.1.
- [ ] 4.3 Dashboard question modal: for `kind: "login-handoff"`, show the stage, app, role, reason and deadline, and offer only Done and Abort, with Escape choosing Abort. Add a focused TUI component test. Open the TUI and check that the keybind help still matches the catalog.
- [ ] 4.4 Add `kind` to the `question.pending` event payload, with a derivation test. Exclude `login-handoff` records from the prior-dialogue text of assignments, with a test.

## 5. Docs and guidance

- [ ] 5.1 In the "Hosted stages" section of `agentic-coding/docs/agent-environments.md`, describe:
  - when a hand-off happens;
  - what the window and banner look like;
  - Done, Abort and the deadline;
  - the `interactiveLogin` policy and the `never` seam for unattended use;
  - leaving the window alone after the hand-off;
  - no persistent login;
  - the MFA and conditional-access precondition.
- [ ] 5.2 Add `stages/policy.json` `interactiveLogin`, `ceilings.maxLoginHandoffSeconds` and the stage `limits.maxLoginHandoffSeconds` to `agentic-coding/docs/config-inventory.md`. Add the headed capability to the Browser row of `agentic-coding/docs/settings-inventory.md`.
- [ ] 5.3 Stage tester guidance: if the `add-stage-test-workflow` role instructions exist, add one line saying that `login-needs-user` means calling `stage_login_wait`, and that terminal hand-off outcomes become `blocked` verdicts with the code as the reason. Otherwise, the tool descriptions from 3.3 carry this.

## 6. Verification

- [ ] 6.1 From `agentic-coding/`, run the focused tests touched above: `test/browser-pool.test.ts`, `test/browser-routes.test.ts`, `test/browser-settings.test.ts`, `test/agent-host-browser-tools.test.ts`, `test/workflow-question.test.ts`, and the new stage login and hand-off tests. Then run `bun run lint` and `bun run type-check`.
- [ ] 6.2 Run one manual hand-off end to end on macOS against a local stage fixture: no credentials configured, then log in in the window, then the agent snapshot shows the logged-in page. Record the result in the change's verification notes, without screenshots of the login.
