## Why

Three files in `agentic-coding/src/workflow/` carry most of the package's logic: `runtime.ts` (3936 lines, one `WorkflowEngine` class), `cli.ts` (1804 lines, one `run(argv)` function), and `definitions.ts` (1396 lines, one `registerBuiltins` function). Stages A and B removed the *step-identity coupling* from them, but not their size. A file that large is still hostile to an agent: any edit loads thousands of lines of unrelated context, and a mistake in one workflow's graph sits in the same function as every other workflow's.

This stage is the one structural change all four original planning drafts agreed on. It is deliberately last, because it is a **pure move** — after stages A and B, the semantics are already in the right modules, so this change relocates code without reinterpreting it, and the definition digests provide a machine-checkable proof that nothing changed.

## What Changes

- Split `runtime.ts` into `runtime/{store,capability,migration,dialogue,evidence,view,engine}.ts`, grouped by concern rather than by call order: SQLite persistence and row mapping; token hashing, capability issuance and artifact validation as one cohesive security unit; legacy migration; developer-question dialogue; Git and source-fingerprint evidence; view projection; and the remaining engine class.
- Split `definitions.ts` into `definitions/{steps,edges}.ts` plus one `definitions/graphs/*.ts` per workflow family (openspec, no-openspec, wiki, research, fusion), with a `definitions/registerBuiltins.ts` orchestrator.
- Split `cli.ts` into `cli/commands/*.ts` per command group behind a command-name lookup table, replacing the long `run(argv)` branch chain.
- Reduce all three original files to **re-export barrels** preserving their exact current export surface — 22 exports from `runtime.ts`, 10 from `definitions.ts`, 20 from `cli.ts`. All 19 importing files (3 under `src/`, 1 workflow-internal, 15 test files) are unchanged.
- No behavior change of any kind: no new or removed step, graph, outcome, effect, action, CLI verb, or schema. Every definition digest and step digest stays byte-identical.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. This is a pure internal reorganization with no spec-level behavior change, so the change sets `skip_specs: true` in its `.openspec.yaml`. Specs describe behavior; no behavior changes here, so inventing a requirement to satisfy validation would be wrong.

## Impact

- **Depends on:** `restructure-repo-for-agent-use` (stage A) and `move-step-semantics-to-behavior-hooks` (stage B). Running this before B would move the step-id branches to new files and then have to move them again.
- **Code (new):** `src/workflow/runtime/*.ts`, `src/workflow/definitions/*.ts`, `src/workflow/definitions/graphs/*.ts`, `src/workflow/cli/commands/*.ts`.
- **Code (reduced to barrels):** `src/workflow/runtime.ts`, `src/workflow/definitions.ts`, `src/workflow/cli.ts`.
- **Unchanged by design:** all 19 importers, the SQLite schema, every manifest, every definition version and digest, the CLI command surface, and `WorkflowView`.
- **Not in scope:** `contracts.ts` (1078 lines) and `effect-runner.ts` (1478 lines). Both are flat exported functions rather than god-objects, so they are not the coupling problem; revisit only if they become one.
- **Verified non-risk:** `scripts/build.ts` builds from the module graph (`entrypoints: ["./src/cli.ts"]`) and `scripts/generate-embedded.ts` reads only `agent-definitions/` and writes one fixed output path. Neither references a source path under `src/workflow/`, so moving files cannot cause a stale-content build.
