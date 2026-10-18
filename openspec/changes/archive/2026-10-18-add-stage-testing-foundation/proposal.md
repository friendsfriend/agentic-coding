## Why

The developer's real systems are several applications that together implement one process flow (a grid-connection request: CUSTOMER registers it, CLERK processes it, INSTALLER handles the technical part). Checking such a flow end to end on a hosted test stage is manual today. A local end-to-end run through the `debug` workflow showed that the browser tools, evidence store and report already work, but an agent has no safe way to reach a *hosted* stage: `browser_open` accepts any raw URL (`agentic-coding/src/server/browser/routes.ts`, `resolveOpenUrl`), there is no notion of a configured stage, no way to log a browser session in without putting the password into the model context, and browser tool output is not redacted at all (the shared redactor of `src/server/environment/agent-routes.ts` is applied to `env_*`, `http_request` and `db_query`, not to `browser_*`).

"Stage testing" is the capability that closes this gap: the developer hands in the text of a ticket (and optionally a stage), an agent derives a test plan from the ticket plus process knowledge in the wiki, drives the real applications on the stage through the whole flow, and answers with an evidence report. The capability is too large for one change (see `design.md`, "Phasing"); this change is **phase 1, the foundation**: the stage configuration domain, the stage allow-list and credential handling, and stage-bound browser sessions that can log in without any secret entering the model context. Everything later builds on it, and it is useful on its own: a `debug` run can already open a logged-in, allow-listed session on a configured stage.

## What Changes

- **New configuration domain `stages/`** under the configuration root (`~/.config/agentic-coding/stages/definitions/<ident>.json`, plus a global `stages/policy.json`), beside `apps/`, `libraries/` and `infrastructure/`. A stage names its environment (`dev`, `test`, `int`, …), its access (`read-only` | `writable`), the applications it bundles (customer / clerk / installer / backend / mail catcher / probes) with their base URLs, an optional link to a configured `app` ident, the roles per application with `${VAR}` credential references, declarative login recipes, extra allowed origins (an SSO identity provider), test-data conventions, cleanup hints and limits. Stages are global, operator-owned and never read from a repository overlay.
- **Validation and refusal.** A stage that declares a production-like environment, matches a denied host pattern, carries a literal credential instead of a `${VAR}` reference, references an unknown app ident or an undeclared login recipe is refused with a value-free diagnostic and is not part of the allow-list.
- **Read surfaces.** A stage catalog route for the dashboard/Settings and an owner-scoped agent route; both return structure and credential *status* (`set` / `missing VAR`), never a value. Settings gains a read-only **Stages** section; credential values are set through the existing protected `.env` credential flow.
- **Stage-bound browser sessions.** `browser_open` accepts `{ stage, stageApp, path? }` and binds the session to that stage. A stage-bound session refuses main-frame navigation to an origin outside the stage's allow-list, refuses state-changing requests on a `read-only` stage (except declared login endpoints), bounds the agent's action rate, refuses cookie/storage extraction from scripts, and masks password and credential-filled fields in screenshots.
- **Credential-safe login.** New `stage_login({ session, app, role })` resolves the role's credentials inside the server and runs the declared login recipe (`form`, `http-basic`, optional TOTP second factor); `browser_fill` accepts a `credential` reference instead of a `value`. A login is refused on a session that is recording, so a password field is never on video.
- **New agent tool `stage_info`** returning the configured stages (or one stage) without secrets, plus discoverable version information from declared version probes.
- **Every browser tool output is redacted** (all sessions, not only stage sessions): declared `.env` secret values and token-like URL query/fragment parameters never travel back to the model, telemetry or logs.
- Raw-URL behaviour of non-stage sessions is unchanged in this phase; the stage-test workflow (phase 3) is where raw URLs are refused.

## Capabilities

### New Capabilities

- `stage-configuration`: the stage definition files, schema, validation, production refusal, credential references, the stage allow-list and its read surfaces (routes, `stage_info`, Settings Stages section).
- `stage-browser-sessions`: stage-bound browser sessions — resolution from the stage catalog, origin and read-only guards, action-rate and session limits, optional exclusive stage lease, credential-safe `stage_login` and credential fills, screenshot masking and script facade restrictions.

### Modified Capabilities

- `agent-browser-sessions`: adds the requirement that browser tool outputs never carry a declared secret or a token-like URL parameter, for every session.

## Impact

- New server module for the stage catalog (`agentic-coding/src/server/stages/`), new routes in the unified server, new owner-scoped agent route.
- `agentic-coding/src/contracts/browser.ts` (open and action request schemas), `src/server/browser/routes.ts`, `pool.ts`, `session.ts`, `playwright-driver.ts`, `fake-driver.ts` (guards, login, masking, redaction), `src/agent-host/browser-tools.ts` (+ new `stage_*` tool definitions, codemode tool list).
- Settings catalog (`src/tui/settings/catalog.ts`) and a read-only Stages section; `docs/config-inventory.md`, `docs/settings-inventory.md`, `docs/agent-environments.md`.
- No new service, no new dependency (TOTP uses `node:crypto`), no workflow store schema change (stays 6), no environment state migration.
- Follow-up changes drafted alongside: `add-stage-flow-evidence` (phase 2), `add-stage-test-workflow` (phase 3), `add-stage-test-launch` (phase 4).
