# Configuration inventory

What the application reads and writes today, and who owns each file. The
canonical resolver, the JSON adapters and the `.env` contract are the whole
configuration surface: there is no configuration migration, no second root and
no obsolete file that a reader falls back to.

## 1. Root resolution

One resolver, `src/config-root.ts`, decides the application-owned global
configuration root:

| Precedence | Input |
| --- | --- |
| 1 | an explicit config-dir argument (health checks, embedded callers) |
| 2 | `AGENTIC_CODING_CONFIG_DIR` |
| 3 | `~/.config/agentic-coding` |

`DEVENV_HOME` is a different setting: it selects the managed environment
runtime root (`db/`, `logs/`, `scripts/`, worktrees), not the configuration
root. `DEVENV_CONFIG_DIR` no longer selects anything. The root's own `.env`
cannot select the root: a root-selecting key inside it is ignored and reported.

## 2. Files under the configuration root

| Asset | Format | Owner | Notes |
| --- | --- | --- | --- |
| `config.json` | JSON | `src/workflow/effects.ts`, `src/server/config.ts` | Global workflow/agents/wiki/telemetry/ui configuration. The only global workflow configuration file. |
| `tui.json` | JSON | `src/tui/shared/preferences.ts` | The one UI-preferences authority (active theme, custom-theme selection). Unrelated JSON keys are preserved; writes are atomic. |
| `themes/` | JSON | `src/tui/shared/preferences.ts` | Custom themes, loaded beside the built-in set. |
| `.env` | env file | `src/env-file.ts`, `src/backend/home.ts`, `src/server/stages/routes.ts` | Secret/endpoint references. Reads only the named variables. The one writer besides the operator is the Stages credential flow, and it writes only a variable an allow-listed stage definition references. |
| `providers/*.json` | JSON | `src/server/integrations/provider-store.ts` | `${VAR}` placeholders only; written 0600. |
| `apps/definitions/*.json`, `libraries/definitions/*.json`, `infrastructure/definitions/*.json` | JSON | `src/server/environment/manager.ts`, `config.ts` | `${CONFIG}`/`$CONFIG` placeholder expansion. |
| `apps/defaults/<app>.json` | JSON | `src/server/actions/default-target.ts` | Which target is the default for one app and action, so a choice between runtime families is decided instead of guessed. Read by the agent build/test tools, `env_list`, the developer's UI action, the validation gate and the smoke check; drafted and promoted by `env-setup` like any definition file. |
| `stages/definitions/*.json` | JSON | `src/server/stages/catalog.ts` | Hosted (non-production) stage definitions: `ident`, `displayName`, `environment`, `system`, `access`, `apps`, `logins`, `allowedOrigins`, `readOnlyExceptions`, `limits`, optional `data`/`wiki`/`planApproval`/`exclusive`/`insecureHttp`, and `oauth2.providers` (token endpoint, client id, optional scope/audience, `clientAuth`). A role may declare `"login": "oauth2"` with `provider`, `grant`, optional `bearerOrigins` and `refreshToken`. Credential fields are `${VAR}` references, never values — including a provider's `clientId` and `clientSecret`. A `app` key names a definition under `apps/definitions/`. |
| `stages/policy.json` | JSON | `src/server/stages/catalog.ts` | Catalog-wide policy for the stage tree above: `deniedHostPatterns` (hosts a stage may never name), `ceilings` (per-stage limits no definition can raise, including `maxLoginHandoffSeconds`, default ceiling 1800) and `interactiveLogin` (`"local"`, the default, allows a `stage_login` hand-off to open a headed window; `"never"` forbids it for the whole catalog, which is the seam for unattended use). A stage's own `interactiveLogin` may narrow the policy and never widens it. Optional; absent means the built-in defaults. |
| `scripts/**` | native | `src/server/environment/example-config.ts` | Stay in their own formats. |
| `environment-server.json` | JSON | environment authority | Server handoff for a spawned backend. |
| `wiki/` | OKF markdown | `src/workflow/wiki.ts` | Knowledge bundle; `HERDR_WIKI_DIR` overrides its location. |

`HERDR_WORKFLOW_CONFIG` selects a full-replacement workflow configuration file:
it keeps replacement semantics and skips the repository overlay.

## 3. Repository overlay

A repository supplies `<repo-root>/.pi/herdr-workflow.json`, deep-merged over the
global base. That merge is the only project scope: a TOML overlay is not read,
and a project overlay never captures a user-scope write. Write-back
(`selectAgentsConfigPath`) targets the explicit replacement file, else the
project overlay when it supplies `agents`, else the canonical `config.json`.

## 4. Obsolete formats

Only the files above are read. An obsolete configuration file (for example a
leftover `config.toml` or `~/.pi/agent/herdr-workflow.toml`) is ignored: it is
neither merged, nor reported as a shadowed source, nor rewritten, and nothing
copies it into the canonical root. A configuration document that is not JSON is
refused by name (`failed to parse config <file>: only the current JSON
configuration format is supported`) rather than interpreted.

Converting historical configuration is therefore an out-of-band step performed
with the older build; this build has no `config migrate` command and no
migration journal, backup or rollback machinery.

## 5. Hosted stages

`stages/` is one tree of two optional parts, read from the canonical
configuration root only: `stages/definitions/*.json` (one file per stage) and
`stages/policy.json` (the catalog-wide policy). A repository overlay is *not*
consulted: a `stages/` directory beside a checkout is ignored, so a stage a run
drives is always the operator's own file.

Ownership is `src/server/stages/`:

- `schema.ts` — the Effect Schema for a definition and the policy. Decoding
  refuses an excess property, so a typo is an error rather than a silently
  ignored key.
- `catalog.ts` — the reader and validator: file stem = `ident`, production-like
  names refused (in `ident` and `environment`), denied hosts, the https rule,
  `${VAR}`-only credential fields, declared login recipes, and `app` keys that
  name a real `apps/definitions` entry. Diagnostics are value-free: they name a
  field path and the rule it broke, never a credential value.
- `guard.ts` / `limits.ts` — the origin and read-only rules a bound browser
  session enforces, and the per-stage session/action bounds.
- `oauth2.ts` / `api-request.ts` — the OAuth 2.0 token path (`add-stage-oauth2-auth`):
  the in-memory token store with its single-flight renewal, refresh-token
  rotation, entry cap, absolute lifetime and forget action, and the token
  call/`stage_api_request` implementation. A token, a client secret, a refresh
  token and an authorization code are the run's secrets from the moment they
  exist: they join the redaction set, are never journaled, and the only token
  facts any surface reports are `expiresAt`, `scopes`, `audience` and `issuer`.
- `routes.ts` / `operations.ts` — the read surfaces and the one write (the
  credential flow above), plus their in-process twin for a transport-less shell.
  The OAuth 2.0 additions are two POST routes on the same owner-scoped agent
  surface: `stage-api-request` and `stage-token-info`.

The only function that turns a reference into a value is
`resolveStageCredential`, called by the login path alone; no route module
imports it. `.env` therefore stays the sole credential store, and a stage file,
a log line, a tool result and the Settings section all carry names and presence
instead of values. The OAuth 2.0 path reads its own references through
`resolveStageOAuthCredential` (provider `clientId`/`clientSecret`) and a role's
`refreshToken`, which have the same contract: the value is resolved at the
moment a token request is built and never stored.

The reader, the policy it enforces and the Settings section are described in
`docs/settings-inventory.md` and `docs/agent-environments.md`.

## 6. Diagnostics

`configDiagnostic()` reports to an installed diagnostic sink (a TUI toast or
blocking dialog) and falls back to stderr on headless surfaces. Diagnostics are
value-free: they name files and variables, never configuration values or
secrets. A failed load is reported as an error and still throws.
