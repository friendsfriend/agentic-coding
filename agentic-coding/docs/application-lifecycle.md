# Application lifecycle and distribution

Status: `unify-application-lifecycle-and-binary` (frontend-first release
milestone). One executable, one lifecycle owner, identity-proved backend
ownership.

## One executable, compatible commands

`agentic-coding` is the product command; every other entry point delegates to
it. `bin/devenv` and `packages/devenv/cli/src/spawn.ts` are thin aliases that
map devenv's verbs onto the same modes (`src/devenv-alias.ts`), so there is one
command surface and one lifecycle implementation.

| Command | Behavior | Owns a backend? |
| --- | --- | --- |
| `agentic-coding` (no command) | Unified shell, home route | yes (managed) |
| `agentic-coding home` / `manager` | Unified shell, home route | yes (managed) |
| `agentic-coding dash [--repo --workflow-id]` | Per-workflow dashboard pane in the shared shell | no |
| `agentic-coding dash --profile test` / `--json` | Dummy data / headless read | no |
| `agentic-coding attach URL` | Shell attached to a running environment backend | no |
| `agentic-coding server [--port N]` | Headless environment backend, foreground | yes (managed, headless) |
| `agentic-coding workflow ...` | Transactional workflow engine | no |
| `devenv [spawn] / devenv attach / devenv server` | Alias of the modes above | same as mapped mode |

Internal modes (`__dashboard-observe`, `__grpc-sidecar`) are implementation
details of this executable and are not part of the product surface. Removed
phase-specific workflow verbs are not reintroduced.

`agentic-coding` runs `--devenv-url URL` (or `AGENTIC_DEVENV_URL`/`DEVENV_URL`)
as an explicit attach: an explicit URL always means "someone else owns this
backend", so the process never stops it.

## Ownership is identity, not a port

`src/backend/managed-backend.ts` spawns the Go backend with a random instance
id and only accepts readiness when `/api/health` reports **all** of:

- `status: "ok"`,
- the instance id this process generated,
- the effective `homeDir` (`DEVENV_HOME` resolution) and `configDir`
  (`DEVENV_CONFIG_DIR` resolution) this process resolved.

Consequences (spec `tui-server-lifecycle`: "Backend identity proves
ownership"):

- A port served by an unrelated or different-instance backend fails startup
  with `port-conflict` and a pointer to attach explicitly. Nothing signals that
  listener's PID.
- `lsof`/listener-PID ownership and termination were removed entirely; a
  listening port never authorizes killing a process.
- Health answering with the wrong identity fails readiness as
  `identity-mismatch` and cleans up only the child this process spawned.

## Startup

`State: idle → starting → running | stopping` (`src/tui/lifecycle.ts`), with one
row per component this route actually owns (`go-backend`,
`workflow-application`/history, `telemetry`). The renderer is created first so
progress is visible before expensive bootstrap, and input is gated while
`starting`: only quit stays live.

Every acquired component is registered as an owned handle
(`acquireResource`) in acquisition order. Acquisition order is
renderer → database → workflow application → backend → telemetry, so release
runs exactly reversed.

Failure during bootstrap releases only acquired handles
(`releaseResources`), then reports the typed reason (`backend/lifecycle.ts`)
instead of exiting silently. The backend itself is acquired with
`Effect.acquireRelease` inside a process scope, so a failed or interrupted
start unwinds the child and its extraction directory even before the shell's
own rollback runs.

## Shutdown

One flow for the quit key and for SIGINT/SIGTERM/SIGHUP (`requestShutdown`):

1. **Interactive quit with owned workflow work asks first.** The prompt names
   what is still running; confirming cancels it through the domain cancellation
   API (`cancelActiveWorkflowExecutions`), declining returns to the shell.
   Cancellation aborts the in-flight drain — it never fabricates a workflow
   completion and never destroys durable workspaces.
2. **Signals never wait for a dialog.** They cancel owned work through the same
   API and proceed; cleanup does not depend on terminal output being available.
3. Release order: telemetry collectors/receivers/gRPC helper → environment
   backend → workflow application (cancel + dispose) → database → renderer.
   Each handle is bounded, a failing handle does not skip the rest, and repeat
   calls are no-ops.
4. External containers, tmux/Herdr sessions and durable workflow resources are
   **not** application resources: exiting does not destroy them.

`stopOwnedStack` only writes progress rows for handles the process actually
acquired, so dashboard and attach shells never claim to stop a stack they do
not own, and attach never stops the attached server.

## Bounded backend reads (no server running)

Headless consumers (the workflow CLI, dashboard observation children) read the
configured-project catalog over HTTP and, when no server answers, fall back to a
bounded one-shot `catalog` invocation of the same backend executable:
`DEVENV_SERVER_BINARY` override, then the checkout's own sources, then the
backend this installation ships (embedded binary, `dist/server/devenv`, or a
source-tree build of it). The packaged route resolves the executable through the
same launcher the managed start uses, so a compiled artifact can always answer a
bounded read; an embedded extraction is private to that one call and removed
afterwards.

While this process is starting the backend **it** owns, it exports
`AGENTIC_DEVENV_STARTING=1` so a read that lands in that window waits for
readiness (bounded, ~4s) instead of spawning a second backend for one read. The
flag is cleared the moment readiness is established, or when startup fails.

## Distribution

`scripts/build.ts` produces one artifact for the host target:

- the unified frontend, workflow engine and telemetry receivers,
- generated instructions (`scripts/generate-embedded.ts`) and the imported
  guides, both bundled (no source-relative path at runtime),
- the OpenTUI parser worker/native assets (`OTUI_TREE_SITTER_WORKER_PATH`),
- the OTLP protocol definition shared by the internal gRPC helper mode and the
  parent's readiness probe,
- the host Go backend, embedded as base64, extracted at runtime into a private
  per-instance directory (`drwx------`, binary `0700`, removed after the child
  stops or a failed extraction).

One version source: the root `package.json`, also injected into the Go backend
with `-ldflags -X`, so executable, TUI and backend agree. Only the host target is built and smoke-tested in this milestone;
cross-platform artifacts are not produced, and the previous second (devenv)
builder script was removed so packaging cannot drift between two implementations.

The optional gRPC telemetry helper is the `__grpc-sidecar` internal mode of
this executable — there is no separately distributed sidecar binary. It binds
`127.0.0.1` and readiness is proved by a real TraceService export, not by a port
accepting a connection; shutdown stops the helper and releases the port.

## Verification

| Check | Evidence |
| --- | --- |
| Identity/ownership, rollback, bounded stop, unresponsive child | `bun test test/backend-lifecycle.test.ts` |
| Owned-handle release order, quit guard, signal path, no-owner routes | `bun test test/lifecycle.test.ts` |
| Backend health identity | `cd server && go test ./pkg/server/` |
| Layering / no nested Effect runtime outside the named roots | `bun test test/workflow-source-layer-boundaries.test.ts` |
| Packaged artifact outside the source tree (no Go compiler, no checkout paths) | `bun run build` then run `dist/agentic-coding server --port N` from a temporary directory |
| Combined verification | `bun run verify` |
