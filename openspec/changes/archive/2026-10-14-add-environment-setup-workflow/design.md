# Design

## Context

The `wiki` family proves the "repository as read-only evidence, write
elsewhere, approve, then publish" shape. `config migrate` proves protected
backups. Slot rows carry a `config_overlay` column
(`add-environment-instances`, kept by `make-app-runs-exclusive`).

## Goals / Non-Goals

**Goals:** agents author complete, validated environment definitions with static
names and ports;
nothing becomes live without approval; existing config is never corrupted.

**Non-Goals:** modifying the app repository (mock-auth profiles or OTel agents
missing in the app are reported as follow-ups, not implemented), secrets
authoring (`.env` stays human-owned; drafts may reference new `${VARS}` which
the report lists).

## Decisions

- **Overlay, not copy.** Discovery for a run with an overlay checks the drafts
  dir first, then the live config dir, per file name. A draft can therefore
  replace or add a target without touching live files.
- **Owner.** The setup workflow holds the app slot as `workflow:<id>` with
  `config_overlay` set while it validates; it waits like any workflow when the
  app is held, and teardown releases it. Drafts keep the app's existing static
  ports and names so routing to other apps stays unchanged.
- **Validation is deterministic.** The system step checks that the overlay
  parses, discovers and compiles, that run targets reference `AC_OTEL_*`, and
  that host ports do not collide with another app's static ports. It then
  starts each target, waiting for readiness from
  the action engine. Agent-side browser smoke checks are part of authoring, not
  of the gate.
- **Approval diff.** File-level list with unified diffs; files under
  `infrastructure/` that modify an existing shared service are flagged
  "affects all apps".
- **Promotion.** Under the environment authority: back up every live file to be
  replaced to `<config>/.backups/env-setup-<workflowId>/`, write via temp +
  rename per file, reload catalog; on any failure restore all backed-up files
  and delete newly added ones, then report. A failed reload keeps the last good
  catalog (existing behavior).
- **Write guard.** Fingerprint = sorted (path, size, mtime, hash for small
  files) of the live config dir excluding `.drafts`/`.backups`, plus `git
  status --porcelain` of the checkout. Checked at each author handoff and
  before promotion.

## Risks / Trade-offs

- [Agent writes live config via bash anyway] → guard detects it and blocks the
  workflow; developer decides.
- [Drafts reference secrets not in `.env`] → validation fails with a list of
  missing variables; report tells the developer what to add.
