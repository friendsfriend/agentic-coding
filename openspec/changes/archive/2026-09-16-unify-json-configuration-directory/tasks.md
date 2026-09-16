## 1. Inventory and baseline
- [x] 1.1 Confirm Settings predecessor status; inventory CLI/server/TUI/logger/subprocess/install/config readers and writers, supported formats, scope precedence, override flags and root environment variables.
- [x] 1.2 Inventory credential-bearing fields, existing `.env` syntax, interpolation fields, file permissions and redaction boundaries; separate external harness auth and ephemeral workflow replies.
- [x] 1.3 Classify configuration assets versus runtime databases/checkouts/logs/wiki data; record all config-relative and absolute path behavior and representative migration fixtures.

## 2. Canonical resolution and JSON
- [x] 2.1 Implement one root resolver with explicit-argument/new-env/legacy-alias/default precedence and resolved-root propagation; remove independent default-path readers.
- [x] 2.2 Add validated config.json workflow reading/writing and JSON templates while preserving current merge, independent-target, canonical-repository, trusted-user and agent revision/conflict semantics.
- [x] 2.3 Add JSON repository overlays and explicit-file support with read-only TOML compatibility/conversion diagnostics; reject simultaneous source formats without implicit merge.
- [x] 2.4 Route environment definitions, providers, preferences/themes, logging/bootstrap and generated config through the canonical root; preserve runtime locations and native config assets.

## 3. .env and secrets
- [x] 3.1 Consolidate .env parsing/preserving writes with tested legacy syntax, process-env precedence and no shell evaluation or cwd auto-loading.
- [x] 3.2 Replace raw-JSON interpolation with parsed field resolution for existing providers and inventoried workflow credential fields; validate missing/empty references and special-character round trips.
- [x] 3.3 Implement authenticated secret editing, collision-safe extraction, owner-only atomic storage and redacted Settings/provenance/errors/reports; prevent resolved secrets entering pins, telemetry or broad subprocess environments.
- [x] 3.4 Preserve ephemeral credential requests and external harness authentication without automatic import/persistence.

## 4. Migration and installation
- [x] 4.1 Add migration preview/dry-run with source/target options, effective precedence comparison, duplicate/path/secret/symlink conflicts and value-free reports.
- [x] 4.2 Implement explicit apply with writer exclusion, source fingerprints, protected backup/staging, validation and journaled publication; preserve unrelated target files and original sources.
- [x] 4.3 Add interrupted-cutover startup guard, idempotent resume and explicit rollback that detects subsequent edits; document inactive legacy sources and deliberate cleanup.
- [x] 4.4 Update installer/examples/portable defaults to initialize JSON only when no existing or legacy user config would be shadowed; preserve regular-file/symlink non-overwrite rules.

## 5. Settings and consumers
- [x] 5.1 Update all Settings storage/source/format labels, global/project scope, credential forms, migration guidance and authenticated server-versus-client ownership.
- [x] 5.2 Audit remaining TOML/devenv-root references and retain only intentional migration fixtures/compatibility or external-tool contracts; update docs/templates and source assets.

## 6. Validation
- [x] 6.1 Test fresh, legacy-only, both-roots, canonical-existing, custom-root, duplicate-ID, secret-conflict, permissions, symlink, unsupported-TOML, failed-write and interrupted/resumed migration fixtures without touching real user config.
- [x] 6.2 Verify effective profiles/presets/arbitrary roles, default harness, provenance, project overrides, explicit replacement and independent targets before/after conversion; prove pinned workflows and runtime paths remain unchanged.
- [x] 6.3 Test secret values containing quotes/backslashes/dollar signs/newlines, missing/empty references, process overrides, JSON save round trips and redaction across APIs/logs/traces/snapshots/migration output.
- [x] 6.4 Test default/server/attach/dash/headless/subprocess consumers share the selected root and no longer write legacy roots; verify attached clients cannot migrate or stop unowned servers implicitly.
- [x] 6.5 Open Settings and verify source/scope, secret masking, conflict handling, footer and `?` help if commands change; run relevant tests, type-check, zero-diagnostic lint and strict OpenSpec validation.
