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
| `.env` | env file | `src/env-file.ts`, `src/backend/home.ts` | Secret/endpoint references. Reads only the named variables. |
| `providers/*.json` | JSON | `src/server/integrations/provider-store.ts` | `${VAR}` placeholders only; written 0600. |
| `apps/definitions/*.json`, `libraries/definitions/*.json`, `infrastructure/definitions/*.json` | JSON | `src/server/environment/manager.ts`, `config.ts` | `${CONFIG}`/`$CONFIG` placeholder expansion. |
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

## 5. Diagnostics

`configDiagnostic()` reports to an installed diagnostic sink (a TUI toast or
blocking dialog) and falls back to stderr on headless surfaces. Diagnostics are
value-free: they name files and variables, never configuration values or
secrets. A failed load is reported as an error and still throws.
