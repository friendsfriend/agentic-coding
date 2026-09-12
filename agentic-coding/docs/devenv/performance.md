# Performance Guide

## Debug overlay

Start the TUI with `OTUI_SHOW_STATS=true` to see the debug overlay:

```sh
OTUI_SHOW_STATS=true bun run dev
```

Fields:

| Field | Meaning |
|-------|---------|
| **FPS** | Frames per second. 60 FPS = 16.67ms per frame. |
| **Frame** | Current, average frame time in ms. |
| **Frame Callback** | Time spent in Solid reactive callbacks. |
| **Overall** | Layout + render + output combined. |
| **Render** | Time to build the render buffer. |
| **Output** | Time to write the buffer to the terminal. |
| **Cells** | Number of terminal cells rendered, average. |
| **Memory** | Heap used / heap total / array buffers in MB. |
| **Threaded** | Whether threaded rendering is active. |

## Perf fixture

Generate a disposable large config for performance testing:

```sh
# 500 apps (smoke test)
bun run perf:fixture -- --apps 500

# 500 apps + 100 scripts
bun run perf:fixture -- --apps 500 --scripts 100

# Custom directories
bun run perf:fixture -- \
  --config-dir /tmp/my-perf-config \
  --home-dir /tmp/my-perf-home \
  --apps 2000 \
  --scripts 1000
```

Run the TUI with the fixture:

```sh
DEVENV_CONFIG_DIR=/tmp/devenv-perf-config \
DEVENV_HOME=/tmp/devenv-perf-home \
OTUI_SHOW_STATS=true \
bun run dev -p 4061
```

## Environment flags

| Flag | Purpose |
|------|---------|
| `OTUI_SHOW_STATS=true` | Show debug overlay at startup. |
| `DEVENV_DEBUG_POLLER=1` | Log every git poller change to server log. |
| `DEVENV_TUI_CONSOLE=1` | Enable OpenTUI console overlay (`Ctrl+/`). Disabled by default for performance. |

## Sizing guidelines

| Resource | Typical range | Notes |
|----------|-------------|-------|
| Applications | 10–50 | Each app runs a Docker container. TUI table handles 500+ smoothly. |
| Scripts | 5–20 | Each script is executed once at startup to extract `--devenv-metadata`. Execution is capped at 2s per script. |
| Infrastructure | 5–20 | Docker and script infra services. Polled every 5s. |
| Providers | 1–3 | Provider list is fetched once at startup. Provider errors are non-fatal. |

## Startup sequence

The splash screen shows each step:

```
✓ Connecting to server       — health check with retries
✓ Server ready               — health check passed
✓ Loading applications       — GET /api/apps
✓ Loading infrastructure     — GET /api/infra-services
✓ Loading scripts            — GET /api/scripts (runs --devenv-metadata on each)
✓ Loading providers          — GET /api/providers
  Startup complete
```

If any step hangs, the corresponding line stays in the "current" state (spinner) and the error message appears in a dialog.

## Profiling patterns

### Table search is slow

Replace `Object.values(app).some(...)` broad search with targeted field search. Already done in `app-store.ts:tableSearchText()`.

### Status broadcasts flood the server log

The `broadcastStatusUpdated` dedupe suppresses repeated identical status events. Enable verbose logging with `DEVENV_DEBUG_POLLER=1`.

### Frequent spinner overhead

`hasActiveOperation` memo in `app-store.ts` caches whether any app has an active operation, avoiding a full list scan on every animation frame.
