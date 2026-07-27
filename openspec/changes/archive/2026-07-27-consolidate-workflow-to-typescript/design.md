# Design — consolidate-workflow-to-typescript

## Context

The engine is internally clean: `effects` (seams) / pure modules (`transitions`, `tiering`, `findings`, `gates`, `tracing`) / `commands` (orchestration) / `state` / `prompts` / `cli`, with a pytest suite. The debt is the language boundary (R1) and the `commands.py` god module (R2), plus layout state in `state.json` (R3). This change ports the engine to TypeScript and fixes R2/R3 in the same pass.

## Decisions

### D1 — Port module-for-module behind a preserved CLI

Each Python module maps to a TS module of the same responsibility. The pure modules (`transitions`, `tiering`, `findings`, `gates`, `tracing`) port first and get direct `bun test` translations of their pytest cases — they are the low-risk core. `effects` becomes the single seam layer (Herdr client, git, clock, exporter, config). `cli` reproduces the exact argparse surface.

### D2 — `herdr-workflow` shim, not a rename

Agents call `herdr-workflow <verb>` literally. A ~3-line `herdr-workflow` executable forwards to `agentic-coding workflow`. Skills, prompts, and the dashboard's `runWorkflow`/`startWorkflow` need no edits. Rejected: mass-renaming call sites (larger diff, breaks the frozen contract mid-migration).

### D3 — Decompose `commands.py` during the port (R2)

The port target is separate modules so no single file spans all concerns:

| Module | Owns |
|--------|------|
| `orchestration` | `cmd_*` phase flow |
| `git` | clean/branch/ssh/base-fresh helpers |
| `layout` | Herdr tab/pane/BSP verification layout |
| `telemetry` | trace/span/telemetry emission |
| `plugins` | plugin list/install |

### D4 — Layout state out of `state.json` (R3)

`verificationSecondRowPane/Role` and `verificationPaneOrder` are terminal geometry. The port reconstructs verification pane placement from live Herdr queries (or a non-durable per-workspace layout store) so persisted state carries only workflow-meaningful fields.

## Behavioral parity gate

The ported engine SHALL produce byte-identical stdout for every verb agents parse and semantically-identical `state.json` for every phase transition. The ported test suite (including the characterization test) is the gate.

## Risks / Trade-offs

- **XL effort.** Mitigated by clean seams and the test suite as oracle.
- **Parity drift.** Mitigated by porting characterization + phase tests before touching orchestration.
- **State migration.** Existing in-flight `state.json` files that contain layout fields must load without error (ignore unknown/removed fields on read).

## Open Questions

- Whether the non-durable layout store is in-memory per process or a small sidecar file — decided during implementation.
