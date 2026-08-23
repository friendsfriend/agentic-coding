## 1. Canonical naming

- [x] 1.1 Implement canonical agent-name derivation (`<role>-<hash8>` persistent, `<shortrole>-<hash8>-<runId8>` round-scoped) with unit tests asserting injectivity across long/colliding change-ID prefixes, the 32-char cap, and Herdr's `^[a-z][a-z0-9_-]*$` pattern; verify `bun run type-check` passes
- [x] 1.2 Replace `runName` in `src/workflow/effect-runner.ts` with the canonical derivation and keep the legacy algorithm exported for one-generation fallback; verify existing `effectRunnerTest` coverage still passes via `bun test src/workflow`

## 2. Live-agent resolution and pane reuse

- [x] 2.1 Add the shared live-agent resolver (handle pane check → canonical-name lookup → adopt/refresh handle; legacy-name fallback on miss) in `src/workflow/effect-runner.ts` with unit tests covering stale pane id, live agent under new name, live agent only under legacy name, and no-live-agent outcomes; verify tests pass
- [x] 2.2 Wire the resolver into the `agent.launch` observe path so reuse prompts go through adopted live panes; verify a simulated stale handle reuses the named agent's pane in the existing effect-runner tests
- [x] 2.3 Change `paneForRun` in `src/workflow/cli.ts` to reuse the resolved pane for persistent roles instead of unconditionally running `tab create`, creating a tab only when no live agent resolved; verify via unit test that tab create fires only on the no-agent outcome
- [x] 2.4 Route verification/triage sibling anchoring through the resolver (canonical names, not stored pane ids) while keeping split geometry unchanged; verify layout selection tests still pass

## 3. Telemetry bridge run-env recovery

- [x] 3.1 Write `.herdr-workflow/runtime-bin/by-agent/<canonicalName>` pointer to the current run's run.env atomically at launch and at every reused-prompt delivery; verify pointer content matches the launched run id in a unit test
- [x] 3.2 Rewrite `recoverRunEnv` in `agent-definitions/bridges/pi-telemetry.ts` to resolve via the pointer file keyed by its own `--name` value, then regenerate `src/workflow/embedded.generated.ts` with `bun run build` (never hand-edit); verify regenerated output contains the pointer-based recovery
- [x] 3.3 Add bridge-level test that recovery succeeds for both a persistent-role name (`planner-ab12cd34`) and a round-scoped name; verify test passes

## 4. Validation and cleanup

- [x] 4.1 Remove dead truncation-era code paths and update comments that describe the old suffix heuristic; confirm no references to the 8-hex-suffix assumption remain outside legacy fallback, verified by `rg "runId8|8-char|32 -" agentic-coding/src`
- [x] 4.2 Run full gate: `bun run lint` zero diagnostics, `bun run type-check` clean, `bun test` green; record results in this change's evidence
