## 1. Baselines and guards

- [ ] 1.1 Confirm stages A and B are implemented and archived, and that `src/workflow/steps/` owns the step semantics they moved. Verify the stage-A digest snapshot in `test/workflow-steps.test.ts` passes unmodified.
- [ ] 1.2 Capture the export surface baseline: write the sorted list of exported names for `runtime.ts`, `definitions.ts`, and `cli.ts` into a committed fixture, and add a test asserting each file's current exports equal that fixture. Verify it passes against unmodified source — this is the barrel-completeness oracle from design D1.
- [ ] 1.3 Add an import-cycle check over `src/workflow/` to the focused test set, asserting no module under `runtime/`, `definitions/`, or `cli/` imports its parent barrel. Verify it passes trivially before the split.

## 2. Split definitions.ts

- [ ] 2.1 Extract `definitions/steps.ts`: the step catalog declarations, `INSTRUCTION_BY_STEP`, the `step()` factory, and `instructionDigest()`, moved without behavior change. Verify the digest snapshot and the 1.2 export fixture both pass.
- [ ] 2.2 Extract `definitions/edges.ts`: the shared `workflowEdges()` builder and `definitionVersionForPolicy()`. Verify the digest snapshot passes.
- [ ] 2.3 Extract one `definitions/graphs/*.ts` per family — `openspec.ts`, `no-openspec.ts`, `wiki.ts`, `research.ts`, `fusion.ts` — each exporting its own registration function. Verify the digest snapshot passes after **each** file, per design D4, so a digest change is attributed to one move.
- [ ] 2.4 Add `definitions/registerBuiltins.ts` orchestrating the per-family registration across every verification-round count and wikiGate combination. Verify the full registered catalog is identical with `bun test test/workflow-registry.test.ts test/workflow-steps.test.ts`.
- [ ] 2.5 Reduce `definitions.ts` to a barrel re-exporting all 10 current exports. Verify with the 1.2 export fixture and `bun run type-check`.

## 3. Split cli.ts

- [ ] 3.1 Extract `cli/commands/start.ts` with the same argv contract as the current start branch. Verify with `bun test test/workflow-cli.test.ts`.
- [ ] 3.2 Extract `cli/commands/dispatch-actions.ts` covering the developer-action, agent-handoff, and agent-question branches. Verify with `bun test test/workflow-cli.test.ts test/workflow-question.test.ts`.
- [ ] 3.3 Extract `cli/commands/wiki.ts` (`runWiki` and the wiki subcommand branch) unchanged in behavior, preserving the managed wiki/research-wiki write authorization gate. Verify with `bun test test/workflow-wiki.test.ts`.
- [ ] 3.4 Extract `cli/commands/research-handoff.ts` unchanged, preserving the active-`core.research`-researcher authorization. Verify with `bun test test/workflow-runtime.test.ts -t "research-handoff"`.
- [ ] 3.5 Replace `run(argv)`'s branch chain with a command-name lookup table over the extracted handlers, and reduce `cli.ts` to a barrel re-exporting all 20 current exports including the test-only helpers. Verify with the 1.2 export fixture, `bun test test/workflow-cli.test.ts test/workflow-dashboard.test.ts`, and `bun run type-check`.

## 4. Split runtime.ts — leaf modules

- [ ] 4.1 Extract `runtime/store.ts`: schema DDL, `openStore`, row interfaces and mappers, `tableExists`, `rollback`, snapshot/run/effect read-write helpers, converted to free functions taking `db` first. Verify with `bun test test/workflow-runtime.test.ts`.
- [ ] 4.2 Extract `runtime/evidence.ts`: Git null-separated parsing, source path exclusion, source content fingerprinting, changed-file discovery, current branch, file walking, and wiki baseline helpers. Verify with `bun test test/workflow-runtime.test.ts test/workflow-wiki-gate.test.ts`.
- [ ] 4.3 Extract `runtime/capability.ts` as one cohesive security unit per design D2: token hashing and comparison, run capability issuance, agent and exact-run authorization, and the artifact path, size, schema, and digest checks with `MAX_ARTIFACT_BYTES`. Preserve the `runtimeTest` export hook. Verify with `bun test test/workflow-runtime.test.ts` including single-use, generation, expiry, and oversized-artifact rejection cases.
- [ ] 4.4 Confirm the one-way dependency order holds so far. Verify with the 1.3 import-cycle check and `bun run type-check`.

## 5. Split runtime.ts — features and view

- [ ] 5.1 Extract `runtime/dialogue.ts`: question creation, answering, expiry, and the dialogue record bounds. Verify with `bun test test/workflow-question.test.ts`.
- [ ] 5.2 Extract `runtime/migration.ts`: legacy discovery, phase mapping, evidence conversion, and migration diagnostics, taking registry and clock as explicit parameters. Move verbatim — this is the least-covered path in the package. Verify with `bun test test/workflow-migration.test.ts`.
- [ ] 5.3 Extract `runtime/view.ts`: view, list, status, snapshot read, repair preview, and the run/effect projection. Verify with `bun test test/workflow-dashboard.test.ts test/workflow-runtime.test.ts`.

## 6. Split runtime.ts — reducers and kernel

- [ ] 6.1 Extract the `developer.action` reducer into `runtime/reducers/developer-action.ts` taking an explicit `ctx` that carries the already-open `db` handle, per design D3 — the reducer must continue running inside the kernel's existing transaction. Verify with `bun test test/workflow-runtime.test.ts` including a rollback case.
- [ ] 6.2 Extract the `agent.handoff` reducer the same way, one task per reducer so a behavior change is attributable. Verify with `bun test test/workflow-runtime.test.ts test/workflow-e2e.test.ts`.
- [ ] 6.3 Extract the `agent.question` and `agent.question-expire` reducers. Verify with `bun test test/workflow-question.test.ts`.
- [ ] 6.4 Extract the `agent.research-handoff` reducer. Verify with `bun test test/workflow-runtime.test.ts -t "research"`.
- [ ] 6.5 Extract the `effect.result` reducer. Verify with `bun test test/workflow-effects.test.ts`.
- [ ] 6.6 Extract the `operator.repair`, `operator.repin`, and `operator.resume` reducers together, since they share repair and repin plumbing. Verify with `bun test test/workflow-runtime.test.ts -t "repair"`.
- [ ] 6.7 Record any reducer that could not be extracted because it depends on state not expressible in `ctx`, leaving it in the kernel rather than widening `ctx` (design D3). Deliver the list in the change's design notes.
- [ ] 6.8 Reduce `runtime/engine.ts` to the kernel class with a `command.type` → handler lookup replacing the private-method chain, and reduce `runtime.ts` to a barrel re-exporting all 22 current exports. Verify with the 1.2 export fixture and `bun run type-check`.

## 7. Documentation and change-relevant validation

- [ ] 7.1 Update `agentic-coding/docs/workflow-architecture.md` with the final module map and a checklist for adding a workflow family, a command, or a reducer without touching unrelated modules. Note explicitly that `runtime/migration.ts` has the thinnest test coverage in the package.
- [ ] 7.2 Add `src/workflow/README.md` pointing at the architecture doc, so an agent opening the directory finds the map before opening a file.
- [ ] 7.3 Run the focused suites covering the moved surface: `bun test test/workflow-steps.test.ts test/workflow-runtime.test.ts test/workflow-registry.test.ts test/workflow-cli.test.ts test/workflow-question.test.ts test/workflow-migration.test.ts test/workflow-effects.test.ts test/workflow-e2e.test.ts test/workflow-dashboard.test.ts test/workflow-wiki.test.ts test/workflow-wiki-gate.test.ts test/workflow-plan-fusion.test.ts` and confirm all pass with the digest snapshot, export fixture, and import-cycle check green.
- [ ] 7.4 Run `bun run type-check`, then `bun run format` followed by `bun run lint` with zero diagnostics, then `bun run build` and confirm the compiled binary is produced (the build resolves from the module graph, so a broken move fails here).
- [ ] 7.5 Run `openspec validate split-workflow-god-modules --strict` and confirm it passes.
