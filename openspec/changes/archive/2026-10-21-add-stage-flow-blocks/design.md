## Context

The `stage-test` workflow already separates planning, execution and reporting:
`stage.plan` produces `core.stage-test-plan@1`, `stage.plan-review` approves it,
and `stage.execute` runs the `stage-tester` role with the plan and stage
description. The tester drives the browser one tool call at a time. The current
instruction requires a fresh `browser_snapshot` before every action, action
results carry no observation, and each meaningful action is recorded with a
separate `stage_step` call.

That design is safe and auditable, but it spends model turns on mechanics. It
also keeps the knowledge of *how* to perform an intent in the agent's head
rather than in reviewed code. A stage change forces every flow that touches the
page to rediscover selectors, waits and postconditions.

This change introduces a reviewed, typed block layer between the plan and the
browser. Blocks hold the mechanics of one user intention; the plan holds the
chain; the runner holds the execution and evidence.

The existing browser tools remain available. Blocks are additive: a flow with no
matching block can still be executed exploratorily, and that gap is visible as a
deviation rather than hidden in a prompt.

## Goals / Non-Goals

**Goals:**

- Make a stage flow block a typed, versioned, reviewable function with a stable
  contract: id, inputs, outputs, effects and postcondition.
- Generate the agent-facing catalog from the same definition, so the catalog
  cannot drift from the code.
- Let the planner chain blocks by id and arguments, and let one `stage_run` call
  execute a validated linear plan.
- Execute a plan without touching the browser when validation fails.
- Record per-block and per-sub-step journal entries and evidence without one
  model turn per entry.
- Keep write/destructive actions behind the existing stage policy and approval.
- Make "change one block" real through contract tests, consumer smoke tests,
  versioning and a promotion workflow.

**Non-Goals:**

- A YAML/JSON action DSL. Plans name blocks; blocks are TypeScript.
- One tool per block, or agent-published blocks at runtime.
- An LLM call inside a block.
- Replacing `browser_snapshot`/`browser_click`/`browser_run_script` for
  exploration and gaps.
- Running a saved spec without an LLM; that is `add-stage-flow-replay`.
- Any browser-engine or CDP change.

## Decisions

### D1. `defineBlock` is the single source of truth

A block is a TypeScript module exporting the result of `defineBlock`:

```ts
export const fillCustomerAddress = defineBlock({
  id: "crm.customer.fillAddress",
  version: "1.0.0",
  app: "crm",
  title: "Fill customer address",
  description: "Fill and save the address on the open customer detail page.",
  params: Type.Object({
    street: Type.String(),
    city: Type.String(),
    postalCode: Type.String(),
    country: Type.Optional(Type.String({ default: "DE" })),
  }),
  returns: Type.Object({
    addressId: Type.Optional(Type.String()),
  }),
  effects: ["write"],
  requires: ["crm.customer.detail"],
  provides: ["crm.customer.address-saved"],
  examples: [{ street: "Teststr. 1", city: "Berlin", postalCode: "10115" }],
  async run(ctx, args) {
    // Playwright locators and assertions owned by the block.
  },
});
```

The definition supplies the schema used by the runner, the metadata used by the
catalog and policy, and the implementation. There is no second hand-written
manifest.

**Alternatives rejected:**

- **YAML/JSON block DSL:** reimplements Playwright's locators, waits,
  assertions and control flow, and makes debugging worse.
- **Page objects as the public unit:** groups by page rather than intent, tends
  toward stateful god objects, and composes poorly across pages.
- **Saved snippets:** no schema, no policy, no contract test, no discoverability.
- **One tool per block:** tool-schema bloat and a growing prompt surface.

### D2. One `StageContext` runs blocks in the agent runner and in Playwright

Blocks receive a `StageContext`, never a global `page` or configuration:

```ts
interface StageContext {
  page: Page;                    // existing allow-listed browser facade
  expect: Expect;
  step<T>(label: string, fn: () => Promise<T>): Promise<T>;
  capture(label: string, opts?: { view?: boolean }): Promise<string>;
  secret(name: string): string;
  run: { id: string; dataPrefix: string };
  app: string;
  role: string;
}
```

`ctx.step` has two hosts:

- in the server plan runner, it appends a journal event and eventually a
  `stage-journal.jsonl` entry;
- in a Playwright spec, it delegates to `test.step`.

`ctx.page` is the existing allow-listed facade, so stage origin, read-only and
credential restrictions continue to apply. Blocks do not receive raw
`BrowserContext` operations that the facade refuses.

**Alternative rejected:** a block that imports and drives a global Playwright
`Page`. It cannot run under the server's session policy, cannot emit journal
events, and is harder to test.

### D3. Plans are linear and validated before execution

The plan is:

```ts
interface StageBlockPlan {
  inputs?: Record<string, JsonValue>;
  steps: Array<{
    routeStepId?: string;
    block: string;
    args: Record<string, unknown>;
  }>;
  save?: boolean;
}
```

A step argument MAY bind a plan input with exactly
`{{ inputs.<name> }}`, or an earlier step's output with exactly
`{{ steps.<id>.outputs.<path> }}`. The placeholder is the whole string value, so
its resolved type is preserved. The same plan structure can be executed with a
different `inputs` object; this is the mechanism that makes a saved flow
reusable with different parameters.

A route step in `core.stage-test-plan@1` gains an optional block reference:

```ts
{
  id: string;
  application: string;
  role?: string;
  action: string;
  expected: string;
  capture: string[];
  block?: { id: string; args: Record<string, unknown> };
}
```

A route that has blocks for every step can be executed by `stage_run`. A route
with mixed steps runs contiguous block steps through `stage_run` and the
remaining steps through the existing browser tools. A step without a block is
still a valid plan; it is a visible exploratory gap.

Validation happens before a browser session is touched:

1. every block id exists and is visible to the pinned stage;
2. every argument matches the block's parameter schema after input and output
   references are resolved;
3. the block's `app` matches the route application;
4. every `requires` state is provided by an earlier step or is already present
   in the plan's initial state;
5. no step declares a `provides` state that conflicts with an earlier one;
6. every `{{ inputs.<name> }}` reference resolves to a declared plan input and
   the resolved value preserves its type;
7. every `{{ steps.<id>.outputs.<field> }}` reference resolves to an earlier
   step with that output;
8. every write/destructive block is permitted by the stage's access policy and
   the approved plan;
9. the block version recorded in the result is the version that executed.

A dry-run mode (`stage_run({ plan, dryRun: true })`) returns the validation
result without opening a browser.

**Alternative rejected:** allowing arbitrary JavaScript in args. It turns the
plan into unreviewed code and defeats the policy boundary. Branching and loops
are expressed in a generated Playwright spec (see `add-stage-flow-replay`), not
in the plan.

### D4. Effects, scope and approval

Every block declares:

- `app`: the application scope, or `*` for a genuinely shared block;
- `effects`: `read`, `write` or `destructive`;
- `idempotent`: whether the block may be retried safely;
- optional `requires`/`provides`: state tags used for plan validation.

The runner enforces:

- a block whose `app` is not in the pinned stage's declared applications is
  refused with `block-app-not-allowed`;
- a write/destructive block on a read-only stage is refused with
  `stage-read-only`;
- a write/destructive block not covered by the approved plan is refused with
  `stage-action-not-approved`;
- a non-idempotent write is never retried automatically; an idempotent read may
  be retried once on a transient browser failure, and the retry is recorded.

The catalog exposes effects so the planner can choose read blocks during
planning without opening a browser.

### D5. Journal and evidence belong to the runner, not the model

`ctx.step` emits a bounded event with a label and optional expected/observed
text. The runner translates events into `stage-journal.jsonl` entries using the
same fields and redaction path as `stage_step`:

- sequence number, server time, session, application, role, sanitized URL;
- label, expected, observed, captures, evidence ids, knowledge observation;
- segment number and offset while recording.

On success, the runner returns per-block results and journal ids. It does not
return a full page snapshot. On failure, it returns:

- the failing block id and version;
- the failing sub-step;
- expected and observed text;
- a screenshot evidence id;
- a scoped snapshot of the failing region, not the whole page;
- a bounded console/network tail;
- whether the failure is retryable.

`stage_step` remains for exploratory steps that are not part of a block. The
runner does not write a `stage_step` for a block step that emitted no journal
events; a block is expected to emit at least one.

### D6. Catalog and tools are one surface, not one tool per block

The build generates a catalog from every public `defineBlock` export:

```json
{
  "id": "crm.customer.fillAddress",
  "version": "1.0.0",
  "app": "crm",
  "title": "Fill customer address",
  "description": "Fill and save the address on the open customer detail page.",
  "params": { "type": "object", "properties": { "...": "..." } },
  "returns": { "type": "object", "properties": { "...": "..." } },
  "effects": ["write"],
  "idempotent": true,
  "requires": ["crm.customer.detail"],
  "provides": ["crm.customer.address-saved"],
  "examples": [{ "street": "Teststr. 1", "city": "Berlin", "postalCode": "10115" }]
}
```

Two tools are added:

- `stage_blocks({ query?, app?, effect?, limit? })` returns compact catalog
  entries; `stage_blocks({ id })` returns the full entry including the JSON
  schema and examples.
- `stage_run({ plan, session?, dryRun?, save? })` validates and executes the
  plan in one call. It accepts either the approved `core.stage-test-plan@1` with
  block-backed route steps or a standalone `StageBlockPlan`; a stage plan is
  projected to the same linear block plan internally, preserving route step ids.
  `save: true` is valid only for the approved stage plan with a flow identity and
  a block on every route step; a standalone block plan is refused with
  `flow-identity-missing`. The saved-spec contract is defined by
  `add-stage-flow-replay`.

The catalog is served from the generated manifest. The agent never receives
block source code unless it explicitly asks for the source through a development
tool; the default surface is metadata, schema and examples.

### D7. Contract tests and promotion

A public block is not accepted without:

- a contract test that opens the required state, runs the block, asserts its
  postcondition and checks the output shape;
- at least one example that validates against the parameter schema;
- a consumer smoke test that chains it with at least one other block;
- a catalog build check that the block has a unique id, a version, a schema, an
  effect and an app scope.

Contract tests run in CI against the pinned test stage (or a stage fixture with
the same UI contract). They are not run on every workflow execution.

The promotion path is explicit:

```text
ad-hoc browser_run_script
  → candidate block (local/PR)
  → contract test + example
  → review
  → public catalog entry
```

An agent may propose a block patch. It may not write directly into the runtime
catalog.

### D8. The planner/executor boundary is the integration point

`stage.plan` may include block references in route steps. The plan review still
shows the human-readable action and expected result, plus the block id and its
chosen arguments. `stage.execute` prefers `stage_run` for contiguous block
steps and falls back to the existing tools for gaps. The report consumes the
runner's journal/evidence ids exactly as it consumes `stage_step` ids today.

This keeps the existing approval and report contracts. It does not require a
new workflow family.

## Risks / Trade-offs

- **A block becomes a god object.** Mitigation: one intent, one postcondition,
  roughly 2–10 UI actions; split when it has multiple reasons to change.
- **The catalog grows faster than it is maintained.** Mitigation: public vs
  internal blocks, promotion criteria, contract tests, owner metadata, and a
  build check that fails on missing tests.
- **The plan format becomes a hidden DSL.** Mitigation: linear plans only; no
  expressions, no selectors, no control flow; branching goes to a spec.
- **The agent cannot see enough to repair a failure.** Mitigation: the runner
  returns a scoped snapshot, screenshot, console/network tail and the failing
  sub-step, not just an error string.
- **A block's postcondition is too weak.** Mitigation: contract tests must
  assert the same postcondition the block declares; a block without an
  assertion is rejected at review.
- **Journal granularity is lost.** Mitigation: `ctx.step` sub-steps are written
  as nested journal entries; the report still receives stable ids.
- **Version skew between plan and catalog.** Mitigation: plans record resolved
  block versions; the runner refuses an id/version that is not registered; a
  deprecated block names its replacement.

## Migration Plan

1. Ship the block core, catalog and `stage_run` behind the existing stage
   workflow without changing the default instruction.
2. Add three blocks for one representative flow and a contract test for each.
3. Add an opt-in planner instruction `blockPlan: true`; plans that use it carry
   block references, other plans behave as before.
4. Run one flow through `stage_run` and compare turns, wall-clock and repair
   time with the current stepwise path.
5. Make block plans the default for the planner once the pilot flow passes; keep
   `browser_snapshot`/`browser_run_script` as the fallback.
6. Promote only blocks with contract tests. No runtime rollback is needed: an
   unused block is inert, and a plan that cannot validate falls back to the
   stepwise path with a visible deviation.

## Open Questions

- **Source location:** `src/stage-blocks/` is the default; if blocks should ship
  per customer, they can move to a separate package later.
- **Plan schema:** add optional `block` to `core.stage-test-plan@1` route steps
  (recommended) rather than a separate parallel plan document. The field is
  optional, so existing plans decode unchanged.
- **Catalog visibility:** planner and tester see the catalog; other roles do
  not. The planner uses it to choose blocks; the tester uses it only for
  validation/fallback.
- **Version coexistence:** one active version per block id in the first
  release. A breaking change uses a new major version and a deprecation window;
  plans record the resolved version.
- **Contract tests against hosted stages:** run them in CI/nightly; a block
  whose contract test cannot reach its stage is marked stale in the catalog
  rather than silently treated as passing.
