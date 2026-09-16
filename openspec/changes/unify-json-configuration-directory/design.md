## Context

`src/backend/home.ts` resolves `DEVENV_CONFIG_DIR` or `~/.config/devenv`; the UI preferences adapter and imported logger repeat that choice. Environment manager definitions already use JSON under `apps/definitions`, `libraries/definitions` and `infrastructure/definitions`. Provider JSON uses `${VAR}` credentials loaded from the root `.env`. Some current Settings labels incorrectly describe these definitions as TOML.

Workflow configuration in `src/workflow/effects.ts` loads an explicit `HERDR_WORKFLOW_CONFIG` replacement, otherwise the first existing user/legacy base plus a canonical-repository overlay. Base paths are `~/.config/agentic-coding/config.toml` and `~/.pi/agent/herdr-workflow.toml`; repository overrides use `.pi/herdr-workflow.toml`. Model editing resolves the winning source and detects conflicting agent sections. The server-side editor now also checks revisions. Preserve these semantics deliberately rather than replacing them with a naive merge of every file.

Existing `.env` helpers preserve unrelated lines and enforce 0600 writes, but provider substitution currently operates on raw JSON text, and bootstrap has another parser. Those paths must converge on a tested contract that handles quotes and backslashes safely. The new format is not permission to expose secret-expanded objects through Settings or durable workflow snapshots.

## Goals / Non-Goals

Goals: one default global root; JSON for application-owned structured configuration; one `.env` contract for environment and workflow secrets; explicit safe migration; unchanged effective non-secret settings and scope rules.

Non-goals: moving checkouts, databases, logs or centralized Wiki data; converting Compose/Helm/Kubernetes YAML, scripts, Dockerfiles or third-party tool configuration to JSON; importing external Pi/OpenCode credential stores; changing workflows/outbox semantics; adding a secret manager or generic configuration framework. Repository-local overrides remain repository-local, not copied into global defaults.

## Decisions

### 1. One root and preserved layout

```text
~/.config/agentic-coding/
├── .env                         # bootstrap variables and protected secrets
├── config.json                  # existing workflow/agents/wiki/telemetry config sections
├── tui.json                     # client-local UI preferences
├── themes/*.json
├── providers/*.json              # references to .env credentials
├── apps/definitions/*.json
├── libraries/definitions/*.json
├── infrastructure/definitions/*.json
└── ...                          # existing scripts/Compose/chart/config assets
```

Do not split agents/profiles/presets into additional files merely to redesign the format. Keep existing environment directory names and content. Configuration-referenced assets move with their config directories where needed; external/native formats stay native.

Root resolution: explicit existing config-dir argument where supported, then `AGENTIC_CODING_CONFIG_DIR`, then deprecated `DEVENV_CONFIG_DIR`, then `~/.config/agentic-coding`. If both environment variables are set, the new name wins with a value-free deprecation diagnostic. Normalize explicit paths once and pass the resolved absolute root to child processes. Never read `.env` to decide the directory that contains that `.env`; reject/ignore root-changing keys there with a diagnostic. Retain `DEVENV_HOME` for managed runtime location; this proposal does not rename or move it.

`DEVENV_CONFIG_DIR` is an alias selecting the single active root, not a second read/write location. Without an override, legacy files under `~/.config/devenv` trigger migration guidance rather than a silent empty setup or permanent fallback. If canonical and legacy files coexist, only canonical data is active; show migration conflicts as appropriate without merging live authorities. Explicitly selecting an old directory remains possible, but it is then the sole root and must use supported formats.

### 2. JSON and source precedence

Use strict JSON parsing followed by current domain validation. Preserve workflow config shape and deep-merge behavior, profiles, arbitrary role tables, registered role/type catalogs, model-agnostic defaults, execution settings and agent-write conflict rules. Writers preserve unrelated/unknown supported keys and use atomic replacement with expected-source revision checks.

The portable template becomes `pi/herdr-workflow.json`; global workflow config becomes `<root>/config.json`. New repository overlays use `.pi/herdr-workflow.json` at the canonical repository root, not a transient worktree. Existing repository `.pi/herdr-workflow.toml` is a read-only compatibility input until explicitly converted; do not rewrite external repositories during global migration. If both formats exist at a repository scope, refuse ambiguous edits/loads with a migration diagnostic rather than merging them. Settings offers explicit source conversion before writing a legacy overlay. New templates/writes are JSON only. This is a bounded project-compatibility bridge, not a second global root.

`HERDR_WORKFLOW_CONFIG` remains an explicit full replacement and skips repository overlays as today. JSON is its target format; explicit legacy TOML can be read during migration, but edits require confirmed conversion and adjustment of that override. Independent wiki/research resolution continues to ignore cwd/project overlays. Server-wide trusted user preferences such as `ui.herdr_sidebar` must not become project-controlled. Settings displays the actual source, format, scope, reference names and pending migration state.

### 3. Shared .env and secret references

Retain the root `.env` as a protected plaintext file, not encryption. Reuse/consolidate current parsing and preserving writes: blank/comment lines, `KEY=value`, quoted values, existing escaped quotes/backslashes, bootstrap HOME expansion and currently supported `export KEY=value` input must be tested. Never source it through a shell, execute substitutions or load arbitrary cwd/repository `.env` files implicitly. Existing non-secret bootstrap variables such as `DEVENV_HOME` remain valid.

Reference lookup uses explicitly supplied process environment first (including an explicit empty value), then the selected root `.env`. This is an intentional provider-resolution update and must be covered by parity tests. Parse JSON before resolving references in schema-declared reference-capable fields; insert values as string data, never by replacing raw JSON source. No recursive expansion of secret values; no automatic interpolation of arbitrary tasks, prompts, commands or third-party assets. Existing `${VAR}` provider syntax remains compatible. Workflow credential-bearing fields must accept whole-value `${VAR}` references; typed non-string fields do not get implicit string coercion. Missing required references fail the dependent operation with field and variable names only, not values; optional missing-provider status remains representable.

Identify workflow fields actually carrying credentials through schema/consumer inventory rather than inventing an API-key property. Configuration consumed only by external harnesses stays with their authentication system. Interactive one-time workflow credential replies keep existing ephemeral semantics; do not persist them automatically to `.env`.

Settings credential edits write `.env` on the owning server through authenticated APIs, and JSON retains reference names. Reject new inline credentials in credential-bearing fields. Migration extracts known literal credentials into collision-checked `.env` names and replaces their JSON values with references; unknown suspicious fields require operator review without printing values. Unrelated `.env` lines survive. Do not dump the entire `.env` into process.env or every child: resolve at the consuming boundary and forward only required values under existing credential policies. Project-controlled data must not gain a generic API for reading all root secrets.

Restrict root/staging/backup directories to owner access and `.env` plus secret-bearing backups to 0600 on POSIX (equivalent supported permissions elsewhere). Avoid following unapproved symlinks when writing secrets. Redact expanded values from Settings responses, errors, traces, migration reports and workflow snapshots. Durable config pins keep reference identifiers and non-secret settings, not resolved secret material; later credential rotation does not rewrite workflow definition/revision pins. Preserve existing fingerprint behavior over non-secret execution settings.

### 4. Explicit, recoverable migration

Provide `agentic-coding config migrate --dry-run` and explicit `--apply`; bare invocation previews only. Source/target options support custom roots and legacy locations. Ordinary startup and installation never move user data. Preview inventories both roots, selected legacy workflow base, relevant assets and secret-key names without printing secret values. Preserve original precedence instead of deep-merging previously shadowed bases. Existing canonical JSON, duplicate definition IDs, different `.env` values for one key, symlinks, unsupported TOML values, unknown secret fields and concurrent edits become explicit conflicts. No force-overwrite default.

Apply requires stopped writers for the selected config authority or a verified shared exclusion mechanism, fingerprints sources, takes protected backups, stages converted files, validates JSON/schema/references and effective non-secret config parity, and only then activates. The target already contains user files and possibly Wiki data; never replace the whole directory or use a wholesale recursive move. Publish through a migration journal/marker with startup refusal during incomplete cutover, since multiple file renames are not one atomic transaction. Preserve unrelated target files. Failures before publication leave live files unchanged; interrupted publication supports deterministic resume or explicit rollback from protected backups. A rerun verifies fingerprints/completed state and does not create duplicate definitions or overwrite later edits.

Known config-relative asset references and `$CONFIG` resolution must still refer to migrated assets. Classify path-bearing fields: rebase config assets only; preserve absolute checkout, runtime/state and Wiki paths. In particular, do not move the existing `~/.config/agentic-coding/wiki` directory just because it shares the target root. Convert TOML types only when lossless under current schema; unsupported dates/non-finite values or unexpected types require an explicit diagnostic. Comments cannot survive JSON conversion; originals remain in protected backups.

Legacy sources remain untouched/read-only after successful migration, with clear inactive-source guidance. Do not delete secrets/backups automatically or keep bidirectional writers. Cleanup is a separate deliberate operator action. Rollback restores the prior config authority only with writers stopped and after ensuring subsequent canonical edits will not be lost.

### 5. Integration and ordering

Complete/coordinate `centralize-application-settings` first for final source/format UI behavior; its preservation of old formats applies until this explicit format migration. Navigation/contextual launch/dashboard isolation do not need to block this work. Audit actual current source because Settings is being implemented concurrently. Update root users, workflow loaders/writers, providers, logger/bootstrap, examples, installer and docs in one cutover. Fix stale Settings TOML/path labels.

Attached Settings edits server-owned configuration, never the client's similarly named root. Client-local themes/preferences use the client root; one directory convention does not imply one shared filesystem across hosts. Restart-required receiver/bootstrap changes are explicit; migration never stops an unowned server. Domain I/O follows existing workflow Effect boundaries; pure path/parse/merge logic remains plain TypeScript.

## Risks / Trade-offs

- `.env` is plaintext: filesystem protection and redaction are mandatory; no claim of encrypted storage.
- Accidental raw JSON interpolation corrupts credentials with quotes/newlines: resolve parsed fields instead and test exact round trips.
- Two old config trees can contain conflicting names/secrets: require decisions, never last-write-wins.
- Hidden consumers may keep writing old roots: search source/templates/docs and assert subprocess behavior before release.
- Running workflows may carry config provenance paths: retain historical metadata and execution pins; do not rewrite durable state to make paths look new.

## Migration Plan

Inventory all readers/writers/formats/secrets and source precedence; implement shared resolver/reference layer; add JSON adapters and migration preview/apply; integrate Settings and install defaults; validate fixture migration and every launch mode; document deliberate operator cutover. No live user migration is performed by this proposal.

## Open Questions

None blocking. Concrete credential-field and asset inventories are implementation acceptance artifacts; undiscovered fields must not be guessed or silently dropped.
