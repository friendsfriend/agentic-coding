# Configuration inventory (unify-json-configuration-directory)

Implementation acceptance artifact for tasks 1.1–1.3. It records what exists
today so the canonical resolver, JSON adapters, `.env` contract and migration
operate on measured behavior rather than assumptions. Every credential field and
path classification below is an inventory result, not a proposal; anything not
listed here must not be guessed or silently dropped.

## 1. Predecessor status (task 1.1)

`centralize-application-settings` is **archived**
(`openspec/changes/archive/2026-09-16-centralize-application-settings`), so
Settings exists and is authoritative for source/scope labels
(`docs/settings-inventory.md`, `src/tui/settings/catalog.ts`). Its
`unified-ui-preferences` deltas are already applied against the **legacy**
`$DEVENV_CONFIG_DIR` root, and its storage labels for
`src/tui/settings/catalog.ts:165` still say `apps/**.toml` for JSON definition
files. This change supersedes those path/format examples while keeping its
client/server ownership rules (attached client edits the owning server, never
its own similarly named root).

## 2. Root resolution today (task 1.1)

There is no single resolver. Six independent decisions exist:

| # | Site | Precedence | Default |
| --- | --- | --- | --- |
| 1 | `src/backend/home.ts:resolveConfigDir()` | `DEVENV_CONFIG_DIR` | `~/.config/devenv` |
| 2 | `src/tui/shared/preferences.ts:configDir()` | `DEVENV_CONFIG_DIR` | `~/.config/devenv` (duplicate of 1) |
| 3 | `packages/devenv/core/src/logger.ts:resolveDevenvHome()` | `DEVENV_HOME` → `DEVENV_HOME` in `<configDir>/.env` | `~/devenv`, with an inline third copy of the `DEVENV_CONFIG_DIR`/`~/.config/devenv` pair |
| 4 | `src/tui/settings/backend-info.ts:resolvedConfigDir()` | `DEVENV_CONFIG_DIR` | `~/.config/devenv` (display/provenance only) |
| 5 | `src/workflow/paths.ts:CONFIG` + `effects.ts:loadConfigWithProvenance()` | `HERDR_WORKFLOW_CONFIG` → first existing base | `~/.config/agentic-coding/config.toml`, legacy `~/.pi/agent/herdr-workflow.toml` |
| 6 | `src/workflow/wiki.ts:wikiRoot()` | `HERDR_WIKI_DIR` → `[wiki] root` | `~/.config/agentic-coding/wiki` |

Root environment variables and override flags in use:

- `DEVENV_CONFIG_DIR` — env/provider/preferences root (sites 1–4).
- `DEVENV_HOME` — managed runtime root (`db/`, `logs/`, `scripts/`); retained
  and **not** renamed by this change.
- `HERDR_WORKFLOW_CONFIG` — explicit full replacement of workflow config; skips
  repository overlays (`effects.ts:328`).
- `HERDR_WIKI_DIR` — wiki bundle root; independent of cwd/project.
- `HERDR_AGENT_DEF_DIR` — agent definitions; unrelated to this change.
- `AGENTIC_CODING_CONFIG_DIR` — **does not exist yet**.
- No `--config-dir` CLI flag exists today. The resolver gains an explicit
  argument for migration `--source`/`--target`, not a new user-facing flag.

Workflow config precedence (`effects.ts:loadConfigWithProvenance`): explicit
replacement file, else first existing of `~/.config/agentic-coding/config.toml`
then `~/.pi/agent/herdr-workflow.toml`, then a deep-merged repository overlay at
`<repo-root>/.pi/herdr-workflow.toml`. Write-back target
(`selectAgentsConfigPath`): explicit replacement > project file containing
`[agents]` > first existing base > project file > canonical base. Conflict
detection (`conflictingAgentsFiles`) fires only when the target is the project
overlay and a base also supplies `[agents]`. `userConfigPaths` deliberately
excludes project overlays and the explicit replacement because
`ui.herdr_sidebar` is server-wide.

## 3. Configuration consumers and formats (task 1.1)

| Asset | Format | Owner / site | Notes |
| --- | --- | --- | --- |
| `config.toml` (workflow/agents/wiki/telemetry/ui) | TOML | `src/workflow/effects.ts`, `src/server/config.ts` | TOML read via `Bun.TOML.parse`; written via a local TOML serializer (`effects.ts:130-191`) |
| `~/.pi/agent/herdr-workflow.toml` | TOML | same, "legacy" provenance | read-only compatibility input after migration |
| `<repo>/.pi/herdr-workflow.toml` | TOML | same, "project" provenance | repository overlay; not copied into global defaults |
| `pi/herdr-workflow.toml` | TOML | repository portable template | copied by installer; contains `use-default-model` preset plus portable defaults |
| `apps/definitions/*.json`, `libraries/definitions/*.json`, `infrastructure/definitions/*.json` | JSON | `src/server/environment/manager.ts`, `config.ts` | already JSON; `${CONFIG}`/`$CONFIG` placeholder expansion at `config.ts:150-162` |
| `scripts/**` | shell/ps1/py/ts | `src/server/environment/example-config.ts` | native formats, stay native |
| Compose/chart/values assets | YAML | `example-config.ts` | native, stay native |
| `providers/*.json` | JSON | `src/server/integrations/provider-store.ts` | holds `${VAR}` placeholders only; 0600 on write |
| `.env` | env file | `src/backend/home.ts`, `packages/devenv/core/src/logger.ts`, `src/server/integrations/env-file.ts` | three parsers, one preserving writer |
| `tui.json` | JSON | `src/tui/shared/preferences.ts` | client-local active theme; atomic temp+rename |
| `themes/*.json` | JSON | `src/tui/shared/preferences.ts` | client-local custom themes; loaded at startup |
| example config tree | mixed | `src/server/environment/example-config.ts` | refuses non-empty dirs; preserves `.env`, `providers/`, `tui.json` |

Consumers of the root: `src/server-command.ts` (`resolveConfigDir` +
`resolveDevenvHome` at 92), `src/server/catalog-command.ts:16`,
`src/server/integrations/services.ts:76-78` (`providers` + `.env`),
`src/server/environment/authority.ts` (`configDir`, `homeDir`),
`src/tui/settings/backend-info.ts`, `src/tui/shared/preferences.ts`,
`packages/devenv/core/src/logger.ts`, and the installer scripts
(`scripts/stow.sh`, `scripts/test-stow.sh`, `scripts/test-herdr-workflow.sh`).

## 4. Credentials, `.env` and interpolation (task 1.2)

### Credential-bearing fields

- **Provider files** (`providers/*.json`): `username`, `token`. A non-placeholder
  literal is already refused as `clear-text-credentials`
  (`provider-store.ts:clearTextCredentialError`). Env keys are derived as
  `DEVENV_PROVIDER_<NAME>_USERNAME` / `_TOKEN` (`providerCredentialEnvKeys`).
- **Workflow config sections**: TOML workflow/agents/wiki/telemetry/ui currently
  carry **no** credential field and no `${VAR}` reference. Workflow credentials
  today are not config fields at all — they arrive through the askpass relay
  (below). No workflow JSON credential field is invented by this change; the
  resolution layer is written for schema-declared reference-capable fields and
  is exercised by the provider fields until a workflow field is inventoried.
- **`.env` bootstrap**: `DEVENV_HOME` only (read by `resolveDevenvHome`).
- **Runtime env forwarding**: telemetry bridges receive `HERDR_*` identity,
  `OTEL_EXPORTER_OTLP_*`, `HERDR_TELEMETRY_PATH` — never resolved secrets.
- **Askpass shim** (`src/workflow/credentials.ts`): ephemeral, single-owner,
  FIFO-relayed prompt answers; never persisted. **Task 3.4 keeps this as-is.**
- **`CredentialRegistry`** (`src/server/credentials.ts`): ephemeral server-side
  prompt broker (`/api/v1/credentials/respond`); never persisted.
- **External harness auth** (pi/opencode credential stores, `~/.pi`,
  `~/.config/opencode`): not imported, not migrated.

### Interpolation today — the raw-JSON defect

`src/server/integrations/provider-store.ts:load()` calls
`substituteVarsWithWarnings(rawJsonText, envVars)` from
`src/server/integrations/env-file.ts`, i.e. it substitutes into the **raw JSON
source text** and only then parses it. A secret containing `"`, `\` or a newline
therefore corrupts or mis-parses the document. This is the exact behavior task
3.2 replaces with parse-then-resolve-on-fields. The pattern is
`/\$\{([^}]*)\}/g`; an empty name is left untouched, an unknown name is reported
in `missingVars` and the placeholder survives.

Reference precedence for the replacement layer must become: explicitly supplied
process environment first (including an explicit empty value), then the selected
root `.env`. Today `loadEnvFile` is the only source, so process overrides are
never consulted for provider credentials.

### `.env` syntax actually supported (parser union)

| Feature | `backend/home.ts` | `core/logger.ts` | `integrations/env-file.ts` |
| --- | --- | --- | --- |
| `#` comments, blank lines | yes | yes | yes |
| `KEY=value`, whitespace trimmed | yes | yes | yes |
| `export KEY=value` | yes | yes | **no** |
| single/double quoted values | naive quote strip | naive quote strip | quote-aware with `\\`/`\'` unescape |
| `$HOME`/`${HOME}` expansion | yes | yes | **no** |
| preserves unrelated lines on write | no write | no write | yes (`upsertEnvFile`, `removeEnvFileKeys`) |
| 0600 enforcement | no | no | yes (`writeEnvLines`) |
| shell evaluation | never | never | never |
| implicit cwd `.env` load | never | never | never |

Task 3.1 must union these: `export` input and `$HOME` expansion **and**
quote-aware escaping **and** preserving 0600 writes, with the union tested.

### Permissions and redaction boundaries

- `writeEnvLines` enforces `0600` and re-`chmod`s on every write.
- Provider files are written `0600`; the providers directory is `0755`.
- Askpass shim dir and shim are `0700`; FIFOs `0600`.
- `src/workflow/secure-fs.ts` provides `O_NOFOLLOW` descriptor-relative open,
  atomic private write and rename — the primitive to reuse for
  secret-bearing atomic storage (task 3.3) instead of inventing a second one.
- Redaction today: the telemetry bridges redact by pattern
  (`SECRET_PATTERN` in `embedded.generated.ts`), and Settings shows provider
  presence (`has_token`) only. There is no redaction layer over migration
  reports or config provenance — tasks 3.3 and 4.1 must add it.

## 5. Asset vs runtime classification (task 1.3)

**Configuration (moves to the canonical root):**

- `config.json` (from the workflow TOML), `providers/`, `tui.json`, `themes/`,
  `apps/definitions/`, `libraries/definitions/`, `infrastructure/definitions/`,
  `infrastructure/scripts/`, `apps/**` assets referenced through `$CONFIG`.
- Assets referenced by `$CONFIG`/`${CONFIG}` are rebased by re-pointing
  `$CONFIG` at the resolved root; the field values themselves do not change.

**Runtime / state (must NOT relocate):**

- `wiki/` — **already lives under `~/.config/agentic-coding/wiki`** by default
  (`effects.ts:252`, `wiki.ts:396`). It shares the target root but is knowledge
  data, not configuration. Migration must not treat it as a config file.
- `$DEVENV_HOME/db/state.db` — environment state database
  (`environmentStateDir`).
- `$DEVENV_HOME/logs/` — logger output (`core/logger.ts`).
- `$CONFIG/logs/infrastructure/*.log` — script/infra logs
  (`defaultScriptLogPath`, `runtime/script-infrastructure.ts:382`). These live
  under the config root today; they stay where they are and are not migrated.
- Checkouts, worktrees, `.herdr-workflow/` run directories, outbox/durable
  workflow state, pins and provenance: absolute paths preserved verbatim.

### Path-bearing fields

- **Absolute**: repository/checkout paths, `cwd`, runtime/state paths, log
  destinations, wiki root when absolute, `HERDR_HOME`-style values.
- **Config-relative**: `$CONFIG`-prefixed definition fields
  (`chartPath`, `values[]`, `cwd`, script paths), `[wiki] root` when it is the
  default `~/.config/agentic-coding/wiki` (already canonical — no rebase), and
  the default `config.toml` → `config.json` rename at the root.
- **Tilde**: `~/...` values are expanded at read time, stored verbatim.

### Representative migration fixtures

Derived from the above and used by tasks 6.1–6.4:

1. Fresh machine: no `~/.config/agentic-coding/config.*`, no
   `~/.config/devenv` → defaults only.
2. Legacy-only workflow root: `~/.config/agentic-coding/config.toml` present →
   convert to `config.json`, preserve profiles/presets/routes/`ui.herdr_sidebar`.
3. Legacy-only env root: `~/.config/devenv/{.env,providers,apps,...}` present →
   move into the canonical root.
4. Both roots present with overlapping definitions → explicit conflicts, no
   deep merge, no last-write-wins.
5. Both scopes for one `.env` key with different values → secret conflict
   requiring resolution, values never printed.
6. Canonical `config.json` already exists plus a legacy TOML → canonical wins,
   migration reports the conflict instead of merging.
7. Duplicate definition `ident` across `apps/`/`libraries/` → conflict entry.
8. `~/.config/agentic-coding/wiki/` present with knowledge data → untouched.
9. Target path is a symlink → refuse to replace/retarget.
10. Unsupported TOML value (date, non-finite) → explicit diagnostic, no
    lossy conversion.
11. Interrupted publication (journal present, partial staged files) → startup
    refuses, resume completes, rollback restores.
12. Rerun of a completed migration → idempotent, no duplicate definitions, later
    canonical edits preserved.
13. Custom roots via explicit `--source`/`--target`.
14. Failed write / unwritable directory → live files unchanged.

All fixtures run against temporary directories; no test touches real user
configuration or secrets.
