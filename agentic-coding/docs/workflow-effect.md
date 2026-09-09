# Workflow Effect conventions

This playbook is the single agent-facing guide for writing and changing the
workflow layer with [Effect](https://effect.website/) (locked at **3.22.2**,
the release line selected in task 1.1). It documents one standard pattern per
operation/error/schema/service/scope/test boundary. Every example imports a
production symbol or lives in a type-checked module; none are uncompiled
drift. The companion inventory is
[`docs/workflow-effect-migration.md`](workflow-effect-migration.md).

Version-matched official documentation:

- Effect Schema (data decoding): https://effect.website/docs/schema/introduction
- Effect Schema union/optional/refinement: https://effect.website/docs/schema/type-schema
- Effect Schema decoding (sync/async): https://effect.website/docs/schema/usage

> **Scope of this phase.** Phase 1 (`adopt-workflow-effect-foundation`) owns
> contract decoding and tagged failures only. The runtime, store, runner, CLI
> and TUI are migrated in later roadmap phases; do not wrap them in Effect yet.
> Pure graph/step/projection/formatting functions remain plain deterministic
> TypeScript.

## Operations: sequential typed effects

Effect programs compose with `Effect.gen` and `Effect` combinators. The
workflow layer does **not** build a project-specific `effect()` wrapper,
service factory, or combinator DSL — use Effect's native API directly.

```ts
import { Effect } from "effect";

const readThenLog = Effect.gen(function* () {
	const value = yield* Effect.succeed(41);
	return value + 1;
});
```

## Errors: concrete tagged failures, not a stringly umbrella

Expected failures are the `WorkflowFailure` tagged union in
`src/workflow/contracts.ts`. Each expected failure carries a stable external
diagnostic `code` and a bounded, redacted message. Use `externalDiagnostic` at
the outer boundary to surface it; never put raw secrets or full input contents
in the default message.

```ts
import {
	externalDiagnostic,
	isRetryableFailure,
	type WorkflowFailure,
} from "./contracts.ts";

const failure: WorkflowFailure = {
	_tag: "stale-revision",
	code: "stale-run",
	message: "run issued against an older revision",
	currentRevision: 7,
};
const diagnostic = externalDiagnostic(failure); // { code, message } bounded
const retryable = isRetryableFailure(failure); // false — never retry a defect
```

Recovery distinctions that must stay separate (spec `workflow-effect-conventions`):

- `stale-revision` — exposes `currentRevision` without message matching.
- `stale-ownership` — a lease/ownership that no longer belongs to the caller.
- `validation` / `invalid-input` — reject before mutation or capability use.
- `infrastructure` — the only `isRetryableFailure` (`_tag === "infrastructure"`).
- `defect` — a programming defect; **never** automatically retried.

## Schemas: one Effect Schema-backed implementation per contract

`src/workflow/schema.ts` is the single source of truth for decoding command,
snapshot, dialogue, and built-in step input/output data. The `Contract<T>`
facades in `contracts.ts` / `definitions/contracts.ts` delegate to it via
`decodeContract` — they are not second validators.

```ts
import { Schema } from "effect";
import { decodeContract } from "./schema.ts";

const Answer = Schema.Struct({
	questionId: Schema.String,
	kind: Schema.Literal("option", "custom", "cancel"),
	value: Schema.optionalWith(Schema.String, { exact: true }),
});

const answer = decodeContract("core.developer-question", Answer, raw);
```

Cross-field invariants and byte bounds that a single field schema cannot
express stay as **pure validation functions** called by the facade (for
example the "either description or questions" rule in
`commandContract.parse`). Schema implementation metadata never enters durable
pins or wire values; contract IDs/versions and definition/step digests are
independent of the parser implementation.

## Services: only at a real production boundary, Layers at the root

Phase 1 introduces no services. A service (and its Effect Layer) is added only
when a later phase migrates an actual production boundary — and then only at a
composition root, not scattered through domain code. Do not invent services
for pure functions.

## Scopes: pure domain stays pure; native/Promise I/O belongs in adapters

- Pure graph/step/projection/formatting functions remain plain deterministic
  TypeScript — do not wrap every pure function in Effect.
- Native/Promise I/O (git subprocess, filesystem, network) belongs in the
  named boundary adapters (`src/workflow/effects.ts`, `adapters.ts`), not a
  second orchestration style.
- No nested runtime execution: a program never runs its own Effect runtime.
- **Durable outbox vs Effect programs are different concepts.** Outbox records
  and the workflow engine's durable retries are **not** generic
  `Effect.retry`. A transient infrastructure failure may be retried through
  the outbox; a defect must not be.

## Tests: use `bun:test`, drive Effect through it

Keep `bun:test`. Test Effect decoding by calling the production
`decodeContract`/`Contract.parse` facades and asserting on the returned domain
values (see `test/workflow-effect-foundation.test.ts`). When a later phase
introduces a test clock, use Effect's test clock facilities through `bun:test`
rather than adding another test framework.

```ts
import { expect, test } from "bun:test";
import { commandContract } from "./contracts.ts";

test("command facade accepts an omitted reason as empty", () => {
	const parsed = commandContract.parse({
		type: "operator.repair",
		workflowId: "w",
		revision: 3,
		targetStep: "core.implementation",
	});
	expect(parsed.type === "operator.repair" ? parsed.reason : null).toBe("");
});
```

## The outer runtime boundary

Only the workflow engine's launch/composition points may run an Effect runtime
in later phases. Everything downstream of a Schema decode stays inside typed
values and tagged failures; the outer boundary maps `WorkflowFailure` to the
bounded external diagnostic via `externalDiagnostic`.
