## Context

Depends on `replace-workflow-project-discovery`. This is the frontend-first release gate. Current agentic-coding builds a main binary plus gRPC sidecar; devenv embeds Go and owns its launch. Both have independent shutdown handling. Porting the Go runtime is deliberately not needed for this milestone.

## Goals / Non-Goals

**Goals:** One distributable executable, one lifecycle owner, visible readiness/shutdown, safe process ownership and retained entrypoints.

**Non-Goals:** One backend runtime yet, automatic daemon persistence, mass environment teardown or new full-feature remote access.

## Decisions

1. Keep product command `agentic-coding`; default opens unified shell. `home`/`manager`/`dash` choose shared-shell routes; `workflow` retains its verbs; `server` and `attach` preserve devenv capabilities. Thin `devenv` launcher alias invokes the same executable. Before backend API extraction, attach is explicitly environment-server attachment: local workflow features are not silently presented as remote server data. Headless server starts the available local backend service stack without renderer; a later change adds the unified workflow API.
2. One root lifecycle state machine coordinates renderer, Go child, workflow application, telemetry listeners and collectors. Readiness includes successful binding/health plus matching version, config-home and random instance identity. Only spawned/verified process handles can be stopped; never infer ownership from lsof or a listening port. Port conflict reports an error or requires explicit attach.
3. Start rendering progress before expensive bootstrap, track partial acquisitions, and undo only acquired resources on failure. Shutdown is idempotent and awaits bounded child termination, application-scope disposal and database close before renderer destruction. Signals use the same cleanup path; a terminal already gone may use stderr instead of painting.
4. User quit with active owned actions requires confirmation before cancellation. Workflow drains are stopped/finalized without fabricating completion or destroying durable workspaces. Leaving containers/tmux/Herdr sessions running is not an orphaned application server. Attach mode only releases client resources. Noninteractive signals perform safe bounded cancellation without waiting for an unanswered dialog.
5. Adapt devenv embedding rather than introducing another installer. Extract Go binary into a private per-instance directory, validate platform artifact and clean it after exit. Include generated workflow instructions, guides, native OpenTUI assets and protocol assets. Build optional gRPC as an internal mode of this executable; test actual trace service startup, port readiness and loopback binding rather than assuming current sidecar correctness. Keep additional telemetry listeners as protocol-specific ports under one lifecycle.
6. Use one version source and host-target build for local validation. Retain the union of previously supported features/platform promises only where verified; do not claim Herdr workflows work on platforms lacking Herdr. No broad multi-platform build unless explicitly requested.

## Risks / Trade-offs

- Cleanup kills unrelated server → instance identity plus owned handles and negative collision tests.
- Quit while lease renewal is active → cancellation/finalization tests preserve ownership and never publish stale results.
- Embedded binary works only in checkout → smoke test from a temporary unrelated directory without source or Go compiler.
- TUI suspend stalls in-process workflow timers → warn in this transitional release and do not mark process isolation complete; next change removes this limitation.

## Migration Plan

Consolidate lifecycle and commands first, then merge build assets and internal modes. Run startup failure, repeated quit, attach, collision, signal and active-work tests. Release only after the full frontend parity inventory is green. Rollback uses the previous artifact with unchanged domain stores; restore pre-upgrade backup only if an unrelated supported schema upgrade requires it.

## Open Questions

No blocking choices. The default remains TUI-owned; persistent server mode is explicit, not automatic.
