# `src/workflow/`

Read [`agentic-coding/docs/workflow-architecture.md`](../../docs/workflow-architecture.md)
before editing a file in this directory — it has the module map, the
one-way dependency order between `runtime/`, `definitions/`, and `cli/`, and
a checklist for adding a workflow family, a CLI command, or a reducer
without touching unrelated modules.

`runtime.ts`, `definitions.ts`, and `cli.ts` at this level are re-export
barrels; the actual code lives in `runtime/`, `definitions/`, and `cli/`.
Every current importer (`src/cli.ts`, `src/tui/dash/*.ts`,
`src/workflow/effect-runner.ts`, and the test suite) keeps importing the
barrel path — do not retarget an import to a path under `runtime/`,
`definitions/`, or `cli/` without checking the architecture doc's dependency
order first.
