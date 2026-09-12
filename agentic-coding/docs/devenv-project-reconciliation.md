# Project reconciliation prerequisite (before change 4)

This note satisfies the operator-prerequisite part of the import change: it documents
what must be confirmed **by the operator, manually**, before
`replace-workflow-project-discovery` (change 4) can cut the workflow picker, history,
telemetry and CLI over to the configured devenv project catalog. Nothing in the
import or in the workflow engine moves data automatically.

## Why this is needed

The merged repository has two ways a project can be identified:

- **Devenv configured projects** — app/library/script definitions under
  `$DEVENV_CONFIG_DIR` (default `~/.config/devenv`) with a stable `ident`.
- **agentic-coding workflow projects** — workflow history, telemetry and worktree
  pins that reference an absolute checkout path.

Before discovery cutover, the operator must reconcile the two so a workflow never
silently attaches to a stale path or loses its history.

## Operator checklist

1. **Inventory configured projects.** List the intended configured project IDs
   (`ident`) and their managed repository locations from the devenv config
   (`~/.config/devenv/{apps,libraries}`), including feature-specific definitions.
2. **Confirm the mapping.** For each agentic-coding workflow project, decide which
   configured `ident` (if any) it maps to. Record unmatched entries; do not delete
   them.
3. **Resolve active workflows with stale absolute paths.** Check for workflows that
   are still active or have durable queued work whose stored checkout path no longer
   matches a managed location. Finish, cancel or explicitly re-point them **before**
   cutover. A configured-project removal is never permission to delete history or
   stop a workflow.
4. **Back up consistent state.** Stop old writers, then copy the workflow store and
   the devenv domain SQLite stores while quiescent. Keep the backups until the
   cutover has been validated; never auto-downgrade a store after upgrade.
5. **Do not relocate repositories here.** This change does not move user
   repositories, rewrite stored locations or migrate databases. If a move is
   desired, treat it as a separate, explicitly-reviewed operation.

## Risks to watch during cutover (change 4)

- **Path vs identity.** Canonical project identity is separate from the active
  checkout and the pinned workflow worktree; conflating them can pin a workflow to a
  checkout that later moves.
- **Duplicate identity.** Two definitions resolving to the same repository would make
  history ambiguous; decide the single canonical `ident` first.
- **History without a home.** A workflow project that maps to no configured project
  must remain readable; keep its history even after it is hidden from new selection.
- **Worktree pins.** Pinned worktrees reference absolute paths; verify they resolve
  under the reconciled locations before enabling the new picker.

## Backup procedure (no data movement)

```sh
# 1. Stop writers (quit the TUI and any managed server) first.
# 2. Back up the devenv domain stores and config while quiescent.
cp -a "$DEVENV_HOME" "$DEVENV_HOME.backup-$(date +%Y%m%d%H%M%S)"
cp -a "$DEVENV_CONFIG_DIR" "$DEVENV_CONFIG_DIR.backup-$(date +%Y%m%d%H%M%S)"
# 3. Back up the workflow store / .herdr-workflow state according to its own
#    documented consistent-backup procedure.
```

Restore is a directory copy back after quitting the writers. Record every manual
remap decision (old path/identity to new `ident`) in the change-4 task list so the
parity inventory can mark project discovery as migrated with evidence.
