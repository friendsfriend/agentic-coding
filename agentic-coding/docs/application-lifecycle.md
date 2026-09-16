# Application lifecycle and distribution

Status: `retire-go-backend-and-migration-bridges`. One executable, one lifecycle
owner, one Bun backend process. The identity-proved Go child that this document
used to describe is gone; see [`go-retirement.md`](go-retirement.md).

## One executable, compatible commands

`agentic-coding` is the product command; every other entry point delegates to
it. `bin/devenv` and `packages/devenv/cli/src/spawn.ts` are thin aliases that
map devenv's verbs onto the same modes (`src/devenv-alias.ts`), so there is one
command surface and one lifecycle implementation.

| Command | Behavior | Owns a backend? |
| --- | --- | --- |
| `agentic-coding` (no command) | Unified shell, home route | yes (managed) |
| `agentic-coding home` / `manager` | Unified shell, home route | yes (managed) |
| `agentic-coding dash [--repo --workflow-id]` | Dashboard-only presentation of one explicit workflow target (no tabs, breadcrumbs, picker, Home/Settings or observability) | no |
| `agentic-coding dash --profile test` / `--json` | Dummy data / headless read | no |
| `agentic-coding attach URL` | Shell attached to a running environment backend | no |
| `agentic-coding server [--port N]` | Headless environment backend, foreground | yes (managed, headless) |
| `agentic-coding workflow ...` | Transactional workflow engine | no |
| `devenv [spawn] / devenv attach / devenv server` | Alias of the modes above | same as mapped mode |

Internal modes (`__catalog`; the retired `__dashboard-observe` and
`__grpc-sidecar`) are implementation details of this executable and are not part
of the product surface. Removed phase-specific workflow verbs are not
reintroduced.

`agentic-coding` runs `--devenv-url URL` (or `AGENTIC_DEVENV_URL`/`DEVENV_URL`)
as an explicit attach: an explicit URL always means "someone else owns this
server", so the process never stops it. The unified server authenticates every
surface, so an attached shell needs a capability: `--token` /
`AGENTIC_WORKFLOW_TOKEN` (full feature) or `AGENTIC_DEVENV_TOKEN` (environment
surface).

## Ownership is the process that started the listener

The managed route starts the one server in this process and owns it: there is no
child to identify, no extraction directory and no second runtime to reconcile.
An explicit `--devenv-url`/`attach` URL means another process owns the listener,
so this one never stops it. `GET /api/health` still reports the instance id and
the effective `homeDir` (`DEVENV_HOME` resolution) and `configDir`
(`DEVENV_CONFIG_DIR` resolution), which is how an operator confirms which
install a listener belongs to.

Consequences:

- A port already in use fails startup (`Bun.serve` refuses the bind) and the
  startup modal reports it; nothing signals another process.
- `lsof`/listener-PID ownership and termination stay removed entirely; a
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
not own, and attach never stops the attached server. The dashboard-only root
composes no backend at all: it acquires no server or coordinator handle, so its
exit can only release the renderer and client resources the process entry
already registered.

## Bounded backend reads (no server running)

Headless consumers (the workflow CLI, dashboard observation children) read the
configured-project catalog over HTTP and, when no server answers, fall back to a
bounded one-shot `__catalog` invocation of this same executable
(`[this executable] __catalog`). It opens the environment authority in its
read-only mode and prints the catalog envelope, so the projection has exactly
one implementation and a packaged artifact can always answer a bounded read
without a compiler or a second runtime.

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
- the OTLP protocol definition used by the in-process gRPC TraceService.

One version source: the root `package.json` (`src/version.ts`), reported by the
executable, the TUI and the headless server. Only the host target is built and
smoke-tested; cross-platform artifacts are not produced, and the previous second
(devenv) builder script was removed so packaging cannot drift between two
implementations.

The optional OTLP gRPC receiver is an in-process listener of the server
(`src/tui/otel/receiver/otlp-grpc.ts`) — no helper process, no separately
distributed binary. It binds `127.0.0.1`, decodes a real ExportTraceService
request into the same span sink the OTLP HTTP receiver uses, reports an
undecodable export as `INVALID_ARGUMENT` instead of acknowledging it, and
releases the port on shutdown.

## Verification

| Check | Evidence |
| --- | --- |
| Ownership policy, alias surface, port collision, health identity | `bun test test/backend-lifecycle.test.ts` |
| Owned-handle release order, quit guard, signal path, no-owner routes | `bun test test/lifecycle.test.ts` |
| No Go runtime/bridge/helper process can return | `bun test test/go-retirement.test.ts` |
| In-process gRPC protocol, loopback bind, shutdown | `bun test test/telemetry-grpc.test.ts` |
| Layering / no nested Effect runtime outside the named roots | `bun test test/workflow-source-layer-boundaries.test.ts` |
| Packaged artifact outside the source tree (no Go toolchain, no checkout paths) | `bun run build`, then run `dist/agentic-coding server --port N` from a temporary directory with a `PATH` that has no `go` |
| Combined verification | `bun run verify` |
