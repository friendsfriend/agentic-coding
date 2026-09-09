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

## Effect conventions

Read [`agentic-coding/docs/workflow-effect.md`](../../docs/workflow-effect.md)
before writing Effect code in this package — it is the single guide, one idiom
per operation/error/schema/service/scope/test boundary, locked to Effect
3.22.2. The migration inventory (module groups, callers, migration-only
bridges, removal owners) is in
[`agentic-coding/docs/workflow-effect-migration.md`](../../docs/workflow-effect-migration.md).

`contracts.ts` / `definitions/contracts.ts` are synchronous `Contract<T>`
facades that delegate to the single Schema implementation in `schema.ts`; they
are not second validators. `WorkflowFailure` (`contracts.ts`) is the tagged
expected-failure union; use `externalDiagnostic` at the outer boundary.

Exceptions, explicit:

- Pure graph/step/projection/formatting functions remain plain TypeScript.
- Outbox durable retries are not `Effect.retry`; only `infrastructure`
  failures are retryable, never defects.
- Native/Promise I/O stays in boundary adapters (`effects.ts`, `adapters.ts`).
