# Diagnostics: catching a freeze

The unified shell (`agentic-coding home`) is **one process**: the unified server,
the dashboard, the Orchestrator view, the OTel receivers/telemetry stores and
the workflow event bus all share one main thread. Anything synchronous and
expensive in any of them stops the UI, so the shell now records what its main
thread was doing before a freeze has to be guessed at.

Everything below is written by that process for itself, into
`<configDir>/diagnostics/tui.log` (the configuration root is
`$AGENTIC_CODING_CONFIG_DIR`, else the platform default). The file rotates at
256 KiB and keeps exactly one previous generation (`tui.log.1`).

## What is recorded

| Record `kind` | When | Contents |
| --- | --- | --- |
| `lag` | the 200 ms drift ticker ran late, **or** a wrapped section held the loop for ≥ 150 ms | `at`, `lagMs`, `rssMb`, `heapUsedMb`, the slowest `sections` of that window (name + ms, slowest first, at most 5) |
| `memory` | every 60 s | `at`, `rssMb`, `heapUsedMb`, `heapTotalMb`, `uptimeSeconds`, `caches` (entry counts of the long-lived caches) |
| `report` | `SIGUSR2`, or `agentic-coding diagnostics` in the owning process | `at`, `rssMb`, `heapUsedMb`, the recent spikes |

The section names are constants chosen in the code, and the records contain
numbers, instants and those names — never workflow ids, task text, file paths,
transcripts or credentials. A name that is not a short identifier is written as
`unnamed` instead of being logged.

Sections currently wrapped:

| Section | Where |
| --- | --- |
| `store.listViews` | the event bus's repository listing (the reconcile tick and every debounced refresh) |
| `store.view` | the event bus's single-workflow read |
| `read.dashboard` | one dashboard observation (run outputs, telemetry, Git state) |
| `telemetry.spans`, `telemetry.logs`, `telemetry.metrics` | the OTLP receiver sinks |
| `render.telemetry-refresh` | the observability refresh a store change triggers |

Wrapping more is one call: `diagnosticsSection("name", () => work())` (or
`recordDiagnosticsSection("name", ms)` when the timing is already in hand). It
costs one function call when no monitor is running.

## Reading it

```sh
agentic-coding diagnostics            # summary + the 20 newest records
agentic-coding diagnostics --tail 100 # deeper
agentic-coding diagnostics --json     # for a script
agentic-coding diagnostics --heap     # also write a heap snapshot beside the log
```

The same summary is in the TUI footer: `lag 420ms ×3` appears next to `?` help
when this process observed spikes in the last ten minutes, where `420ms` is the
worst of them and `×3` how many.

On a **running** process, without restarting it:

```sh
kill -USR2 <pid-of-agentic-coding>
agentic-coding diagnostics --tail 40   # then read the `report` record
```

`SIGUSR2` writes one `report` line (memory, cache counts, the recent spikes).
It never dumps a heap snapshot by itself — a snapshot is a few hundred megabytes
and belongs to a deliberate decision, which is `--heap`.

## Capturing a freeze while it happens

1. Leave the shell running (the monitor is always on).
2. When it freezes, from another terminal:
   ```sh
   agentic-coding diagnostics --tail 50
   samply record -p <pid>            # or: sample <pid> 5 -file /tmp/tui.sample
   ```
   `sample`/`samply` show *where* the thread is; the diagnostics log shows
   *which section* it was in and how often it happened.
3. If the process is stuck rather than slow, also take:
   ```sh
   ps -o rss=,pcpu=,etime= -p <pid>
   ls -la "$AGENTIC_CODING_CONFIG_DIR/diagnostics/"
   ```
4. What to send: the `agentic-coding diagnostics --json` output, the native
   sample, and (only when asked) a `--heap` snapshot. Nothing in the diagnostics
   file is sensitive by construction; a heap snapshot *can* contain workflow
   content, so treat it as you would the store.

A freeze that never reaches the log means no wrapped section held the loop: send
the native sample, which is then the only evidence.

## What the log is not

It is not a debug log, not a trace export and not a substitute for the OTLP
telemetry the shell already carries. It is one bounded file whose whole purpose
is to answer "what was the main thread doing", the question that cost the most
time in the two earlier rounds of freeze fixes.
