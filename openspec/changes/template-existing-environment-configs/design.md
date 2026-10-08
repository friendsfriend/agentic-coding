# Design

## Context

`config migrate` (`src/config-migration.ts`) established the pattern: preview by
default, `--apply` with protected backups, refuse while writers run. Compose
requires are parsed in `discovery.ts` (`parseComposeRequires`).

## Goals / Non-Goals

**Goals:** convert every existing definition mechanically and reversibly;
detect untemplated or semantically incomplete targets.

**Non-Goals:** editing app-specific environment variables, script run targets
(none configured today; validator still covers them), Kubernetes charts.

## Decisions

- **Comment- and order-preserving edits.** Users hand-edit these files; a full
  YAML re-serialization would lose comments and ordering. Prefer a targeted
  rewrite on parsed node positions; fall back to refusing a file whose shape is
  not recognized (reported, not modified).
- **Port names.** `AC_PORT_<SERVICE>` for a single published port, else
  `AC_PORT_<SERVICE>_<CONTAINERPORT>`; uppercased, `-` → `_`. Deterministic so
  re-runs are idempotent.
- **Idempotent.** Running twice changes nothing; the dry run of a converted
  tree reports zero edits.
- **Backup.** `<config>/.backups/env-templates-<timestamp>/` with the original
  files; `--restore <timestamp>` restores.
- **Writers.** Refuse `--apply` while any non-`user` instance runs, because
  their compiled definitions reference the old files.

## Risks / Trade-offs

- [Unusual compose shape] → file is skipped and listed; operator fixes by hand
  or via `env-setup`.
- [Port name collisions across services] → detected; suffixed with container
  port.
