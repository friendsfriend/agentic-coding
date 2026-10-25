# Agent host store v2: guarded one-way upgrade

This rollout changes the previous source-revert-only rollback policy. **Do not run an older host against an upgraded store. Restore the complete pre-upgrade database before rolling back the executable.** Live compatibility with old binaries is not supported.

## Upgrade

On the first open, before resuming conversations or accepting runs, the host:

1. Takes a consistent SQLite snapshot of the **entire** `harness.sqlite` database, including committed WAL contents, at `harness.sqlite.pre-keyed-v2` in the same agent-host directory. This includes conversations, transcripts, and all durable documents, not just association maps. The private backup is mode `0600`, flushed and published without overwriting any existing copy.
2. In one durable transaction, copies legacy role/run associations into individually keyed documents, clears the aggregate maps, and installs **version 2** of `agentic.runs`. Version-1 document readers and writers explicitly reject this newer version instead of silently seeing empty state. Empty/fresh stores also receive the gate.
3. Resumes the host only after the transaction succeeds. Later starts skip the backup/migration; normal ensure/recovery operations stay bounded to requested keys.

A failed backup prevents migration and startup. An existing backup is never overwritten. If a crash or failed transaction leaves a backup but no installed gate, startup fails closed: preserve that copy, inspect/restore the store as below, and move the retained copy to a separate private archival location before retrying an upgrade. Do not simply delete the only rollback copy. Custom injected storage is caller-owned; embedders are responsible for its complete backup. The standard persisted host always uses the SQLite snapshot above.

## Restore before rollback

Perform this procedure for **every affected workflow host store**, including repository-independent workflow hosts:

1. Stop the dashboard/workflow clients and host using the deployment's normal managed shutdown. Confirm no process still holds the host database/socket. Do not let old and new hosts open the store concurrently.
2. Locate the host storage path from its runtime layout: `<runtimeDir>/agent-host/harness.sqlite`. Repository-backed workflows normally use their authoritative worktree's `.herdr-workflow` runtime; repository-independent workflows have their own workflow runtime directory. The sibling `.pre-keyed-v2` file is the pre-upgrade snapshot.
3. Preserve the upgraded `harness.sqlite` **and any `-wal`/`-shm` sidecars** separately for forward recovery/inspection. Preserve the rollback backup as well. Treat all copies as private transcript/credential-bearing data.
4. Restore a **copy** of `harness.sqlite.pre-keyed-v2` to `harness.sqlite` with mode `0600`. Remove the upgraded database's old `-wal`/`-shm` files from the live location (archive them in step 3); never combine those sidecars with the restored database. The SQLite snapshot is standalone and does not need its own sidecars.
5. Install/start the older executable only after restoration. Verify the legacy role/run associations and historical session recovery using the restored conversations. A source revert without these steps is not a rollback.

Rollback returns host conversations to the snapshot time: post-upgrade transcript/association changes are not merged into an older format. This does **not** roll back authoritative workflow state; newer recorded session handles may therefore be unavailable and must fail closed, never open another run's session. Retain the upgraded store if forward recovery of those conversations is needed.

Before a later re-upgrade, preserve/move the existing `.pre-keyed-v2` copy out of the live backup path so the next upgrade can create a fresh complete snapshot. Never remove or downgrade the version gate in place. Focused tests cover durable API rejection of older readers/writers, legacy-map/conversation restore, complete live-WAL snapshots, backup failure, and non-overwrite behavior.
