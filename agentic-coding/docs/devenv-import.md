# devenv import provenance and manifest

Status: imported under change `import-devenv-into-agentic-coding` (migration change 1 of 11).

This document is the provenance record required by **Reproducible in-repository source
ownership**. It captures the exact upstream revision, what was copied where, what was
intentionally left out, and how the imported code is built and verified.

## Source revision

| Field | Value |
| --- | --- |
| Source repository | `git@github.com:friendsfriend/devenv.git` (`~/devenv`) |
| Pinned revision | `775579a8be625f7074c55a5971ab84ea30265fd4` |
| Commit date | `2026-08-15T12:30:27+02:00` |
| Commit subject | `Feature/startup with dependency tree health check (#73)` |
| Working-tree state at capture | clean (0 entries in `git status --short`) |
| Import method | `git archive <revision> <paths>` from the clean source checkout, then copy into this repository |

### Merged repository baseline

| Field | Value |
| --- | --- |
| agentic-coding revision | `6a393cab41f5e1d0d883f915cb46d2096597df39` (`implement herdr sidebar provider`) |
| Branch | `feature/import-devenv-into-agentic-coding` |
| Working-tree state at capture | clean; there were no unrelated local edits to preserve (`.herdr-workflow/` runtime state is gitignored) |

The import does **not** reference `~/devenv`, use a submodule, or check out a second
source tree. The merged checkout is self-contained: with `~/devenv` unavailable,
`bun install`, `bun run type-check`, `bun test packages/devenv` and
`bun run build:devenv:single` resolve only imported source and declared dependencies.

## Import manifest

| Upstream path | Imported path | Notes |
| --- | --- | --- |
| `server/` (208 `.go` files, `go.mod`, `go.sum`, `testdata/`) | `server/` | Go backend, tests and cross-runtime fixtures preserved verbatim |
| `tui/packages/cli/` | `agentic-coding/packages/devenv/cli/` | TUI entrypoint (`src/spawn.ts`), views, actions, stores, keyboard, tests |
| `tui/packages/core/` | `agentic-coding/packages/devenv/core/` | API/SSE clients, logger, diff helpers, tests |
| `tui/packages/types/` | `agentic-coding/packages/devenv/types/` | Shared domain types and labels, tests |
| `tui/packages/ui/` | `agentic-coding/packages/devenv/ui/` | OpenTUI/Solid components, tests and snapshots |
| `tui/scripts/build.ts` | `agentic-coding/packages/devenv/scripts/build.ts` | Binary builder, path resolution adapted to the flattened layout |
| `scripts/set-version.ts`, `scripts/create-perf-config.ts` | `agentic-coding/packages/devenv/scripts/` | Upstream maintenance scripts |
| `tui/tsconfig.json` | `agentic-coding/packages/devenv/tsconfig.json` | `paths`/`include` adapted to the flattened layout |
| `LICENSE` | `agentic-coding/packages/devenv/LICENSE` | Retained upstream license text (see below) |
| `docs/*.md` | `agentic-coding/docs/devenv/` | `action-architecture.md`, `cross-runtime-endpoints.md`, `performance.md` |
| `install.sh` | `agentic-coding/packages/devenv/install.sh` | Retained as reference; still targets the pre-merge `dist/tui/...` release layout (see exclusions) |
| (none) | `agentic-coding/packages/devenv/package.json` | New minimal metadata so `cli/src/version.ts` and the build script resolve the app version without the upstream `tui/package.json` |

`packages/devenv/package.json` (`{ name: "devenv", version: "0.12.7" }`) is intentionally
*not* a workspace member; the four `@devenv/*` packages are. It exists only so the
version and build tooling resolve `0.12.7`.

### Package names retained

The imported packages keep their temporary `@devenv/*` workspace names, per design
decision 2. Renaming to a unified namespace is out of scope for change 1.

## Intentionally excluded

Committed upstream files that were **not** imported, because they are not source,
belong to other migration changes, or would create a second build/test graph:

- `node_modules/`, `dist/`, `tui/dist/`, `tui/server-binaries/`, `*.bun-build` —
  generated artifacts; `server-binaries`, `dist` and `node_modules` are gitignored
  under `agentic-coding/packages/devenv/`.
- `.DS_Store` — untracked/OS noise.
- Upstream `openspec/`, `.opencode/`, `.pi/`, `.github/`, `AGENTS.md`, `README.md`,
  `FEATURE_IDEAS.md` — product/process docs that are superseded by this repository's
  own docs or track a separate backlog.
- Upstream per-package `bun.lock` and `tui/bunfig.toml` — the merged repository uses a
  single root `agentic-coding/bun.lock` and one `agentic-coding/bunfig.toml`.
- Upstream root `build.ts` release wrapper and the `dist/tui/*` layout it produces —
  its behavior is covered by the adapted `packages/devenv/scripts/build.ts`. The local
  `install.sh` remains as reference only and is not wired to a script until the release
  pipeline changes. `install-remote.sh` was **removed** during the fix round: it fetched
  an unsigned release archive from the third-party `friendsfriend/devenv` repository
  and stripped the macOS quarantine attribute, with no checksum or signature check.
- Global user data: `$DEVENV_HOME`, `~/.config/devenv`, SQLite databases, credentials
  and `.env` files. The database/config formats are not modified by this change.

## Fix-round security hardening

The security verification round raised upstream issues that the import surfaced. They
were fixed in place without changing the imported applications' external contracts:

| Finding | Disposition |
| --- | --- |
| SEC-001/SEC-002 unsigned remote installer | Removed `install-remote.sh`; the local `install.sh` remains unwired reference. |
| SEC-003 secrets on `kubectl` argv | Secret values are now materialised into per-value 0600 temp files under a private temp dir and passed via `--from-file`, then removed; display/log args are redacted. Resulting secrets are unchanged. |
| SEC-004 process-group termination | Unix `killProcessGroup` now signals the whole process group the script was started in, falling back to the leader. |
| SEC-005 Windows containment comment | Corrected the Windows comment to state that `os/exec` does not assign a Job Object and containment is unsupported. |
| SEC-006 full URL in debug logs | `custom-fetch` logs only scheme + host + path (query strings and userinfo redacted). |
| SEC-007 process log permissions | Long-running process logs are opened `0600`. |
| SEC-008 `.env` permission tightening | `writeEnvLines` chmods the file to `0600` after every write, not just on creation. |

## Workspace and tooling

- `agentic-coding/package.json` is the Bun workspace root; `workspaces` includes
  `packages/devenv/*`, so one lockfile resolves `@devenv/cli`, `@devenv/core`,
  `@devenv/types`, `@devenv/ui` and a single OpenTUI/Solid version.
- `agentic-coding/bunfig.toml` pins `[install] linker = "hoisted"` so existing and
  imported code resolve transitive packages (for example `marked` via
  `@opentui/core`) exactly as before the merge.
- `agentic-coding/tsconfig.json` adds `packages/**/*` and `@devenv/*` path mappings;
  `tsc --noEmit` type-checks both applications with one configuration.
- Biome covers the imported TypeScript with the repository's normal rules (tabs,
  import organization, no `any`, no non-null assertions). The import was reviewed to
  zero diagnostics rather than excluded from linting.
- Go module/import identity (`github.com/friendsfriend/devenv`) is preserved.

## Launch commands

From `agentic-coding/`:

| Command | Surface |
| --- | --- |
| `bun run dev:devenv` | devenv TUI (spawns the Go server via `go run`) |
| `bun run dev:ui` / `bun run dev:ui-dash` | existing agentic-coding TUI |
| `bun run build` | agentic-coding executable + gRPC sidecar |
| `bun run build:devenv:single` | host-target devenv binary (`--single` semantics) |
| `bun run verify` | combined Bun lint/type-check/tests plus Go test/vet |

## License notice and redistribution gate

Two conflicting signals were imported and must be reconciled before redistribution:

- The retained `agentic-coding/packages/devenv/LICENSE` text is an **MIT License**
  (`Copyright (c) 2026 Fabian Kellner`).
- The upstream `package.json` metadata declares `"license": "PROPRIETARY"`.

Only the upstream root `LICENSE` was copied to `agentic-coding/packages/devenv/LICENSE`;
`server/` carries no separate license file. Redistribution of this merged repository
must not proceed until the MIT text and the PROPRIETARY package metadata are
reconciled (design decision 3); no licensing intent is asserted or invented here.

## Rollback

The change is a source/build revert: delete `server/` and
`agentic-coding/packages/devenv/`, restore `agentic-coding/package.json`,
`tsconfig.json`, `bunfig.toml`, `.gitignore` and `bun.lock`, and remove the parity,
import and reconciliation docs. No user data, database schema or repository location
is modified, so no data migration or downgrade is involved.

## Verification evidence (this run)

| Check | Command | Result |
| --- | --- | --- |
| Combined verification | `bun run verify` (from `agentic-coding/`) | exit 0: lint, type-check, both Bun suites, Go test/vet |
| Lint | `bun run lint` (from `agentic-coding/`) | 696 files, zero diagnostics |
| Type-check | `bun run type-check` | clean |
| Imported TUI suite | `bun test packages/devenv` | 162 pass, 0 fail, 40 files |
| Go tests | `cd server && go test ./...` | all packages `ok` |
| Go vet | `cd server && go vet ./...` | exit 0 |
| agentic-coding build | `bun run build` | executable + gRPC sidecar built |
| devenv host build smoke | `bun run build:devenv:single` | `dist/devenv-darwin-arm64/bin/devenv` produced |

Fix round (generation 2): the verifier findings were addressed and re-validated. Focused
checks after the fixes: Kubernetes cluster summary contract tests, action-run-store
debounce polling, `custom-fetch` URL-redaction tests, the Go secret-file and
process-group tests, `go test ./...`, `go vet ./...`, `bun run verify` (exit 0),
`bun run build` and `bun run build:devenv:single`.
