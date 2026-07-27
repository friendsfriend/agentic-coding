# Design — architecture-checkup-round-1

## Context

`agentic-coding` bundles a Herdr-driven OpenSpec workflow engine with two terminal UIs. Today the pieces are:

| Piece | Language | Role |
|-------|----------|------|
| `pi/lib/herdr_workflow/` + `pi/bin/herdr-workflow` | Python | Workflow engine + frozen CLI agents call |
| `agent-dash/` | TypeScript (Bun/Solid/OpenTUI) | Workflow dashboard — home list + per-workflow view |
| `otel-tui/` | TypeScript (Bun/Solid/OpenTUI) | Standalone OTLP trace viewer |
| `pi/bin/herdr-manager` | bash | Launcher: starts `otel-tui` tab, execs `agent-dash --home` |
| `agent-definitions/extensions/herdr-workflow.ts` | TypeScript | Pi `/implementation` command + `herdr_workflow` tool (manager role) |

The engine is cleanly factored internally (`effects` seams / pure modules `transitions|tiering|findings|gates|tracing` / `commands` orchestration / `state` / `prompts` / `cli`) and has a pytest suite. The structural debt is at the **language boundary** and inside the oversized `commands.py`, not in the pure logic.

This change produces only an analysis catalog. The design below records the decisions that shape that catalog and the migration it recommends; it is the reference later rounds implement against.

## Goals / Non-Goals

**Goals**
- Capture a single, agreed target architecture that eliminates the dual-language contract-drift class at its root.
- Rank every finding so later rounds can pick items off independently.
- Preserve the agent-facing CLI contract as a hard constraint of any migration.

**Non-Goals**
- Any engine/UI/config code change in this round.
- Porting logic, splitting modules, or renaming binaries now.

## Decisions

### D1 — Consolidate onto one TypeScript binary named `agentic-coding`

The Python/TS split is the root cause of the phase-list, `state.json`, and phase→action drift, and of the duplicated Herdr client. Since TS is already the majority language and Bun ships single-file executables, the target is one binary:

```
agentic-coding workflow <verb> …   # ported engine (start|planner|apply|verify|
                                    #   dispatch-verifiers|verification-result|
                                    #   finish-review|archive|close|phase|
                                    #   override-phase|preflight-archive|
                                    #   set-return|message|status|projects|
                                    #   config|plugin …)
agentic-coding dash --repo … --change …   # per-workflow dashboard view
agentic-coding home                       # workflow list view (today: --home)
agentic-coding manager                    # folds herdr-manager launcher
```

The dashboard **imports the engine module in-process** instead of `Bun.spawn("herdr-workflow", …)` + JSON reparse. This collapses R1 (contract drift), R4 (duplicate Herdr client), and most of R5 (split state ownership) into structural impossibility rather than discipline.

### D2 — Preserve the agent CLI contract via a `herdr-workflow` shim

Agent skills, prompts, and the `PLAN_REJECTED` retry loop invoke `herdr-workflow <verb>` literally. The chosen umbrella name is `agentic-coding`, so the recommended lazy migration is a thin `herdr-workflow` executable that forwards `argv` to `agentic-coding workflow`. This keeps every skill, prompt, and the dashboard's own `runWorkflow`/`startWorkflow` calls working with zero edits, and lets a later round migrate call sites to `agentic-coding workflow` opportunistically. Mass-renaming every call site up front is the rejected alternative (larger diff, breaks the frozen contract during transition).

### D3 — `otel-tui` stays a separate binary; dedupe the shared viewer

The OTLP receiver is a distinct concern (network listener, no auth, own lifecycle) and stays its own binary. But the trace-view UI (`TraceBrowser`, `traces.ts`, `receiver`) is duplicated between `agent-dash` and `otel-tui`. Target: one shared module consumed by both the `agentic-coding` dashboard's trace tab and the standalone `otel-tui` (R6).

### D4 — Catalog format: living requirements with tier + effort

Mirror the existing `opentui-gap-catalog` precedent — each finding is a `Requirement` with scenarios asserting the target-state invariant, a severity tier (High/Med/Low), and an effort estimate (S <1d / M 1–3d / L ~1w / XL >1w). This makes the backlog directly consumable by later rounds.

### D5 — Layout state is presentation, not workflow state

`verificationSecondRowPane/Role` and `verificationPaneOrder` describe terminal geometry, not workflow progress. The target reconstructs verification pane layout from live Herdr queries (or a dedicated non-durable layout store) so `state.json` carries only workflow-meaningful fields (R3). This is called out separately from the port so it is not silently carried over.

## Ranked backlog (summary)

| # | Tier | Effort | Item |
|---|------|--------|------|
| R1 | High | XL | Consolidate engine + dashboard views into one TS `agentic-coding` binary; retire Python; import engine in-process; `herdr-workflow` shim; `otel-tui` separate |
| R2 | High | L | Decompose `commands.py` during the port (orchestration / git-ssh / layout / tracing / plugins) |
| R3 | High | M | Keep terminal-layout state out of durable workflow state |
| R4 | Med | M | Single Herdr CLI client module (one `.result` parser, shared geometry helpers) |
| R5 | Med | M | Event/watch-based dashboard refresh (tail telemetry/traces) instead of 5s re-spawn poll |
| R6 | Low | S | Dedupe otel trace-view code shared between dashboard and `otel-tui` |
| R7 | Low | S | Fix agent-name mismatch (herdr 32-char truncation vs pi `--name {change}-{role}`) |
| R8 | Low | S | Remove legacy dead paths (`startWorkflowWizard`, `pi_command` diagnostics) |

## Risks / Trade-offs

- **Port cost (R1) is XL.** Mitigated by the engine's clean internal seams — modules port one-for-one, and the pytest suite becomes the porting oracle (translate to `bun test`).
- **Contract breakage during migration.** Mitigated by D2's shim: the frozen `herdr-workflow` surface never disappears.
- **Behavioral parity.** The port must preserve exact stdout of engine verbs (agents parse it) and exact `state.json` semantics; the existing tests + characterization test are the parity gate.

## Migration Plan (for later rounds, not this change)

1. Round 2: R1 skeleton — TS `agentic-coding workflow` reproducing the CLI surface + `herdr-workflow` shim, engine ported behind it, tests green, Python removed.
2. Round 3: R2/R3 — decomposed modules, layout state moved out of `state.json`.
3. Round 4: dashboard imports engine in-process (R4/R5), otel dedupe (R6).
4. Cleanup: R7/R8.

## Open Questions

- None blocking. Naming of TUI subcommands (`dash`/`home`/`manager` vs alternatives) can be finalized when R1 is implemented.
