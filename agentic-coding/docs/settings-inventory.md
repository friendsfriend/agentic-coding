# Settings inventory and policy (centralize-application-settings)

Home → Settings is the one destination for every supported application setting.
This file is the human-readable mirror of
`agentic-coding/src/tui/settings/catalog.ts`; the code table is authoritative
and `test/settings-configuration.test.ts` asserts that every entry resolves to a
Settings section page, a scope, a storage description, and at least one rendered
item, so nothing can be inventoried and then never shown.

Sections: `settings` (landing) with `settings.appearance`,
`settings.agents`, `settings.providers`, `settings.projects` and
`settings.backend`. A section route may carry a configured
application/library id (`resourceId`) as its stable project scope.

## Scopes

| Scope | Meaning |
| --- | --- |
| `client` | This client only: `$AGENTIC_CODING_CONFIG_DIR/tui.json` (default `~/.config/agentic-coding/tui.json`). |
| `user` | User-level configuration (no project selected). |
| `project` | Project-scoped configuration, selected by a configured application/library id. |
| `server` | Owned by the connected server process and its configuration directory. |

Settings never infers a project from the current working directory, and a
remote read/write never falls back to a local configuration file: an
unavailable or unauthorized server is a section error with a retry.

## Entries

| Setting | Section | Owner | Scope | Storage | Secret | Effect | Editable |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Theme | Appearance | `src/tui/shared/preferences.ts` | client | `$AGENTIC_CODING_CONFIG_DIR/tui.json` · `theme` | no | immediate | yes (shared theme picker) |
| Agent profiles | Agent models/presets | `src/server/config.ts` | user / project | `[agents.profiles]` in the layered workflow config | no | next workflow start | yes (shared profile/preset editor) |
| Configuration presets | Agent models/presets | `src/server/config.ts` | user / project | `[agents.presets]` in the layered workflow config | no | next workflow start | yes (shared profile/preset editor) |
| Routing and definition defaults | Agent models/presets | `src/workflow/profiles.ts` | user | `[agents]` `default_profile`, `routes`, `role_routes`, `definition_defaults` | no | next workflow start | no (no bounded editor; shown read-only with its source) |
| Git providers | Providers/credentials | server integration families (`/api/providers`) | server | `$AGENTIC_CODING_CONFIG_DIR/providers` served by the connected server | yes | immediate | yes (edited in Environments) |
| Provider credentials | Providers/credentials | `src/workflow/credentials.ts`, `src/server/credentials.ts` | server | protected credential store; single-owner ephemeral prompts | yes | immediate | no (status only) |
| Applications and libraries | Projects/environments | `src/server/environment/authority.ts` | server | `$AGENTIC_CODING_CONFIG_DIR/{apps,libraries}/definitions/*.json` (projected catalog) | no | immediate | yes (through Settings project scope / Environments) |
| Scripts and infrastructure | Projects/environments | `src/server/environment/authority.ts` | server | `$AGENTIC_CODING_CONFIG_DIR/{scripts,infra}` | no | immediate | yes (edited in Environments) |
| Backend endpoint and ownership | Backend/telemetry | `src/tui/index.tsx`, `src/server/lifecycle.ts` | server | `AGENTIC_DEVENV_URL` / `AGENTIC_WORKFLOW_URL` and the instance capability | yes | restart | no (start-time decision) |
| Configuration directory | Backend/telemetry | `src/backend/home.ts` | server | `AGENTIC_CODING_CONFIG_DIR` (default `~/.config/agentic-coding`) | no | restart | no |
| Telemetry receiver ports | Backend/telemetry | `src/server/receivers.ts` | server | `--http-port`, `--grpc-port`, `--zipkin-port`, `--datadog-port`, `--statsd-port` | no | restart | no (read-only override) |
| Prometheus scrape targets | Backend/telemetry | `src/tui/otel/receiver/index.ts` | server | `--prom-target`, `--prom-interval` | no | restart | no (read-only override) |
| Telemetry persistence and retention | Backend/telemetry | `src/server/telemetry.ts` | server | server-owned telemetry database | no | restart | no (server-owned) |

## Source and restart policy

- **Appearance** is client-local. Saving writes `tui.json` through
  `writeSettingsAtomically` (temp file + rename), preserving unrelated keys; a
  failed write reports the failure and leaves the previous file intact.
- **Agent settings** resolve through the layered workflow config and are
  written through the authenticated server (`POST /api/v1/config/agents`). The
  client names the revision it read (`expectedRevision`); the server digests the
  effective `[agents]` section and refuses a write when another client changed
  it since, so a concurrent edit is detected instead of overwritten. Unrelated
  keys, unknown preset role tables and source precedence are preserved.
- **Providers, projects and environments** are owned by the connected server.
  Settings reads status through the capability-bearing environment client
  (`Authorization: Bearer <instance token>`) and opens the existing environment
  editors for changes; it never writes the client's own checkout.
- **Backend/telemetry** values are decided when the owning server starts
  (CLI flags, environment variables, defaults). Settings shows the effective
  value, names the controlling source and states that a restart is required; it
  never restarts or stops an unowned server.
- **Application of changes**: persistent agent edits affect subsequent workflow
  starts only. A running workflow keeps the routing resolved into its run input
  (its pins/revisions) until its existing explicit revision-bound adoption
  operation is used. Editing server configuration never restarts a server.

## Credentials

Credential values are never read into Settings state: provider rows show
presence (`has_token`) and identity only, hosted credentials stay in the
protected store, and prompts remain single-owner and ephemeral. Secrets never
enter route payloads, navigation state, UI preference files, logs or telemetry.
