# Secure native workflow SQLite I/O

`database.ts` is an I/O boundary below the existing `WorkflowStore` Effect
service, not a second store or orchestration API. `secure-sqlite.c` implements
a VFS using SQLite's public extension/VFS/filename APIs and ordinary OS file
and locking APIs. No Bun/SQLite internal structures or dependency patches are
used. Each root pins one explicitly validated canonical database basename: `herdr.db`
for workflow stores or `scheduling.sqlite` for the config-root scheduler. Arbitrary
names, paths and cross-basename capability reuse are refused. Registration also
validates and pins every existing reserved sidecar, even when the current journal
mode would not inspect it.

## Build and packaging

`bun install` builds the host-platform artifact through `postinstall`.
`bun run build:native` explicitly regenerates it for a source checkout.
`bun run build` does the same before embedding it in the executable.
A C11 compiler and public SQLite development headers are build dependencies;
there is no external runtime compiler. The generated TypeScript artifact is
ignored by Git. Never hand-edit or distribute an artifact for a different
platform/architecture: the loader refuses that mismatch.

Supported native platforms are modern macOS and Linux with `F_OFD_SETLK` and
`F_OFD_GETLK`. The build fails rather than falling back to process-wide locks.
SQLite must provide the public `sqlite3_create_filename`/`sqlite3_free_filename` APIs.
On Linux, the VFS uses SQLite's public extension loader. macOS's system SQLite
omits that loader, so the module binds public system-library functions only
after its default VFS pointer exactly matches the pointer returned by Bun's
`SQLITE_FCNTL_VFS_POINTER`. It never switches Bun's SQLite library. A custom,
unrecognized macOS SQLite instance is refused, not silently rebound.

The embedded module is extracted into a private, per-bootstrap temporary
directory, written and fsynced through an exclusive no-follow file capability,
and loaded through that descriptor. A retained native loader reference keeps
registered callbacks alive for the process lifetime, including after JS worker
termination. Each loaded image registers a distinct VFS name, so concurrent
workers cannot replace one another's VFS/root registry. Registration is
synchronized; each connection has a random private capability token.

## Transactions, recovery, and confinement

- Main-file descriptors remain inode-pinned. Sidecar open/access operations
  stay relative to the held directory and reject symlinks, multiple links,
  foreign ownership, group/other access and a sidecar inode changed after
  observation/opening.
- Writers select `journal_mode=TRUNCATE` and `synchronous=FULL`. SQLite retains
  responsibility for rollback/recovery and commit atomicity. A successful
  reserve/activate transaction is not simulated with application JSON files.
- Sidecar logical deletion truncates and syncs a validated, held inode instead
  of unlinking a path that may have been replaced. Zero-length sidecars report
  absent for `SQLITE_ACCESS_EXISTS`, matching normal SQLite behavior. A later
  directory rebinding cannot cause foreign journal removal or truncation.
- Descriptor duplicates cannot use ordinary process-owned POSIX locks: closing
  an unrelated duplicate would release another connection's locks. This VFS
  uses OFD locks on the standard pending/reserved/shared SQLite byte ranges.
  Independent native connections, workers, processes and ordinary external
  SQLite clients therefore participate in the same conflict protocol.
  All in-process workflow-store connections must use the native store adapter.
- Legacy WAL is converted only by a writer, using exclusive locking and a heap
  WAL index; no shared-memory callbacks or lexical `-shm` path are exposed.
  Read-only observation refuses that conversion and never performs hot-journal
  rollback. After a crash, an explicit writable open performs recovery before
  the normal native-store validation/query/command proceeds.
- `sqlite3_filename` allocations outlive the delegated file handle; SQLite may
  inspect URI metadata even when an fd alias has no URI parameters.

Focused coverage lives in `workflow-secure-sqlite.test.ts`,
`scheduling-workflow-crash.test.ts`, `workflow-store-service.test.ts` and
`workflow-store-version.test.ts`. It includes a real SIGKILL after uncommitted
pages reach the main file, actual uncheckpointed WAL recovery, shared/writer
locks after an unrelated guard closes, worker teardown/reopening, sidecar
substitution and a compiled-executable smoke with an unavailable compiler.
