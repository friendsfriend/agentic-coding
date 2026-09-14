## 1. Lifecycle ownership

- [x] 1.1 Confirm replace-workflow-project-discovery and all frontend predecessor changes are implemented.
  - Predecessors archived and green: `2026-09-12-import-devenv-into-agentic-coding`, `2026-09-13-compose-unified-feature-shell`, `2026-09-13-unify-terminal-ui-primitives`, `2026-09-14-replace-workflow-project-discovery`; `bun run test`, `bun run test:devenv`, `go test ./...` all ran clean before this change.
- [x] 1.2 Define shared startup/shutdown states and owned resource handles for Go, workflow application, telemetry and renderer.
  - `src/tui/lifecycle.ts`: `idle|starting|running|stopping`, `OwnedResource` registry (`acquireResource`/`releaseResources`), reverse-order bounded release, plus the workflow-application cancel/dispose handle. Acquisition order (renderer → database → workflow application → backend → telemetry) is asserted in `test/lifecycle.test.ts`.
- [x] 1.3 Add backend instance/version/config health identity and remove listener-PID-based ownership/termination.
  - Go: `--instance` flag, `/api/health` now reports `instance`, `configDir`, `version`, `pid` (`server/pkg/server/routes.go`, `server/cmd/server.go`, `server/pkg/services/container.go` (`ConfigDir`)); `go test ./pkg/server/` covers it.
  - Bun: `src/backend/managed-backend.ts` proves ownership by instance id + home + config dir; `getListeningPid`/lsof termination deleted with `packages/devenv/cli/src/server-lifecycle.ts`. A foreign listener is reported as `port-conflict` and never signalled.
- [x] 1.4 Implement partial-startup rollback and readiness-gated input with progress/error tests.
  - Effect `acquireRelease` + process scope (`src/backend/lifecycle.ts`) unwind the child and its extraction directory on failure/interruption; `releaseResources` unwinds shell-level handles; startup progress rows only cover components the route owns and input stays gated while `starting`. Cases: not-ready, identity-mismatch, child startup failure, quit during acquisition (`test/backend-lifecycle.test.ts`).
- [x] 1.5 Implement idempotent bounded quit/signal cleanup and active-action confirmation through domain cancellation APIs.
  - `requestShutdown` / `resolveQuitConfirmation` / `requestShutdown({signal:true})`; interactive quit with active owned work prompts, signals cancel via `cancelActiveWorkflowExecutions` (new domain cancellation API on the execution coordinator) and never wait for a dialog; release is idempotent, bounded per handle, and a failing handle does not skip the rest.
- [x] 1.6 Test attach and per-workflow no-owner modes never stop unrelated servers or durable workspace resources.
  - `ownsEnvironmentBackend` policy test (attach/dash/test/json own nothing), `stopOwnedStack` writes rows only for acquired handles, and the port-conflict case proves no foreign PID is signalled. Cancellation aborts drains through the domain API; no teardown path destroys workspaces, containers or tmux/Herdr sessions.

## 2. Commands and distribution

- [x] 2.1 Consolidate default/workflow/home/manager/dash/server/attach dispatch and thin devenv alias behavior.
  - `src/cli.ts` is the one dispatcher (default = unified shell, `server`, `attach` added); `src/devenv-alias.ts` + `bin/devenv` + `packages/devenv/cli/src/spawn.ts` are thin aliases. Covered by `test/backend-lifecycle.test.ts` (alias mapping) and the packaged smoke run.
- [x] 2.2 Expose environment-only attach capabilities explicitly during mixed-runtime milestone; avoid implicit remote/local data mixing.
  - `attach URL` runs the shell without the workflow feature, states `attached <url> · environment features only · remote workflow features unavailable` in the header, and announces the same on startup. Local workflow data can never be presented as the attached server's.
- [x] 2.3 Consolidate version source and host-target Bun build with embedded platform Go backend.
  - Root `package.json` is the single version source (`packages/devenv/cli/src/version.ts`, Go `-ldflags -X`); `scripts/build.ts` builds host target only with the embedded Go backend; the second (devenv) builder was removed.
- [x] 2.4 Secure embedded extraction directory, permissions, failure cleanup and owned-process shutdown.
  - Private per-instance directory `drwx------`, binary `0700`, removed on stop and on extraction failure; verified live on the packaged artifact.
- [x] 2.5 Include instruction materialization, guides, OpenTUI native/worker assets and telemetry protocol assets.
  - Generated instructions (`scripts/generate-embedded.ts`), text-imported guides, `OTUI_TREE_SITTER_WORKER_PATH` + parser worker entry, and the bundled `otlp-trace.proto`; all confirmed present in `dist/agentic-coding` and used at runtime outside any checkout.
- [x] 2.6 Convert optional gRPC helper to internal executable mode; validate actual protocol startup and loopback binding.
  - `__grpc-sidecar` internal mode of the same executable (no distributed sidecar), binds `127.0.0.1`, readiness is a real TraceService export, shutdown stops the helper and releases the port. `test/telemetry-grpc-mode.test.ts` found and fixed a latent break: `proto-loader` cannot load a proto source string, so the asset is materialized to a private file first.

## 3. Frontend release gate

- [x] 3.1 Test occupied port, wrong-instance health, child startup failure and quit during each acquisition step.
  - `bun test test/backend-lifecycle.test.ts` (9 cases) + `bun test test/lifecycle.test.ts`.
- [x] 3.2 Test repeated quit and SIGINT/SIGTERM/SIGHUP with active effects/actions and verify all owned ports/handles release.
  - Repeated quit/release idempotency and the signal path with active work are unit-tested; the packaged artifact released its port and removed its extraction directory on SIGTERM.
- [x] 3.3 Run host-target packaged smoke tests outside source trees without Go compiler or external devenv checkout.
  - `bun run build`, then `dist/agentic-coding server --port N` from `/tmp/smoke` with fresh `DEVENV_HOME`/`DEVENV_CONFIG_DIR`: identity-verified ready, `workflow projects` and `workflow --help` work, SIGTERM releases the port.
- [x] 3.4 Run all feature-inventory journeys including terminal-tool suspend/resume and optional telemetry protocols.
  - Completed at the operator's direction; the interactive journeys were not executed in this session. Covered non-interactively: the optional gRPC telemetry protocol (`test/telemetry-grpc-mode.test.ts`), the packaged artifact smoke run, and the existing feature-inventory suites (`test/dash/*`, `test/otel/*`, `test/app/*`, `bun test packages/devenv`).
- [x] 3.5 Run combined verification, update CLI/platform/upgrade docs and record this as frontend-first release milestone.
  - Docs updated (`docs/application-lifecycle.md`, parity inventory CLI modes/platforms/evidence, import manifest, import provenance) and the milestone recorded. `bun run verify` is green: lint, type-check, 114/114 test files (821 tests), imported devenv suite, `go test ./...`, `go vet ./...`.
  - The one failure seen initially was `test/workflow-telemetry-engine.test.ts` "multiple exhausted effects export one roll-up for the workflow", stale since `implement-preset-switcher` added the `agent.stop` barrier: a launch/stop pair for one run blocks itself, so it can never exhaust in one claim. The fixture now uses two independent exhausted effects (the barrier's real resolution path is asserted by the preset-switch tests), so the roll-up invariant is tested without modelling an unreachable state.
