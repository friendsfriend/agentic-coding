# Tasks — consolidate-workflow-to-typescript

## Port pure core (lowest risk first)

- [x] **T1** Port `transitions`, `tiering`, `findings`, `gates`, `tracing` to TypeScript with direct `bun test` translations of their pytest cases.
- [x] **T2** Port `state` (load/save/phase, path helpers) and `prompts` (role prompts, pi-argument building, plugin discovery).
- [x] **T3** Port `effects` as the single seam layer: one Herdr client (`.result` envelope), git, clock, OTLP exporter, config load/merge.

## Port orchestration with module boundaries (R2)

- [x] **T4** Port `cmd_*` orchestration split into `orchestration` / `git` / `layout` / `telemetry` / `plugins` modules; no module spans all concerns.
- [x] **T5** Reproduce the exact CLI surface (all verbs and flags) and stdout format agents parse.

## CLI compatibility (R1)

- [x] **T6** Add `herdr-workflow` shim executable forwarding `argv` to `agentic-coding workflow`; verify `verify`, `dispatch-verifiers`, `verification-result`, `phase proposed` work unchanged.

## Layout-state removal (R3)

- [x] **T7** Remove `verificationSecondRowPane`, `verificationSecondRowRole`, `verificationPaneOrder` from persisted `state.json`; reconstruct verification pane layout from live Herdr queries or a non-durable store.
- [x] **T8** Ensure existing `state.json` files containing removed layout fields still load without error.

## Cutover

- [x] **T9** Port the full pytest suite (incl. characterization) to `bun test` and confirm behavioral parity (verb stdout + `state.json` semantics).
- [x] **T10** Remove `pi/lib/herdr_workflow/` and the Python `pi/bin/herdr-workflow`; update `scripts/` install/test wiring.
- [x] **T11** Run `openspec validate consolidate-workflow-to-typescript` and resolve structural errors.
