## Why

The `stage-tester` role executes a UI plan one browser action at a time. Its
instruction requires a fresh `browser_snapshot` before every action, the action
tools return no page observation, and every meaningful action is journalled with
a separate `stage_step` call. A single UI step therefore costs roughly
`snapshot → action → stage_step`: two to three model turns. A 20-step flow is
40–60 turns before screenshots, and each full snapshot remains in the
conversation.

The same selectors, waits and assertions are also re-derived on every run. When
a stage changes, every flow that touches the changed page can break in a
different place, and the agent has to rediscover the page rather than repairing
one known intent.

The proposed unit is a **typed stage flow block**: one deterministic,
reviewable function for one user intention (`fillCustomerAddress`,
`submitOrder`, `loginAsRole`) with typed inputs and outputs, an owned
postcondition, and a generated catalog entry. A planner chains blocks by id; a
runner executes the chain in one tool call and records the evidence. A block can
be changed without changing its callers, provided its contract and contract test
still hold.

## What Changes

- Add a `defineBlock` contract for TypeScript blocks: stable id, version, title,
  description, parameter and return schemas, effects, `requires`/`provides`
  state tags, examples, and the `run(ctx, args)` implementation.
- Generate a machine-readable block catalog from the definitions. The catalog is
  the agent-facing surface; the source of truth remains reviewed TypeScript.
- Add `stage_blocks` (search/describe the catalog) and `stage_run` (validate and
  execute a plan of blocks) tools. One runner tool serves every block; do not
  add one tool per block.
- Add a plan format: an optional typed `inputs` object and an ordered list of
  `{ block, args }` steps. Arguments may bind a plan input with
  `{{ inputs.customerId }}` or an earlier step's output with
  `{{ steps.1.outputs.customerId }}`. Plans are linear and may not execute
  arbitrary JavaScript; the same plan structure can run with different input
  values.
- Validate a plan before touching the browser: unknown block ids, invalid
  arguments, unmet `requires`, conflicting `provides`, unapproved write effects
  and missing output references are refused with a bounded error.
- Execute a validated plan in one model turn. Return per-step status, typed
  outputs, evidence ids, a compact failure observation and the resolved block
  versions.
- Write the journal from the runner. A block's `ctx.step` calls become
  `stage-journal.jsonl` entries with the same sequence, time, session,
  application, role, sanitized URL, expected/observed and evidence rules as
  `stage_step`, without one model turn per entry.
- Require every public block to have a contract test and an example. Add a build
  check that fails on a missing schema, duplicate id, missing contract test, or
  a breaking contract change without a version bump.
- Integrate blocks with the stage workflow: `stage.plan` may emit a block plan;
  `stage.execute` runs it; the existing report path consumes the per-step
  results. A flow gap may still use the existing browser tools or
  `browser_run_script` and is recorded as a deviation.
- Provide a promotion path: an ad-hoc script is not a block until it has a
  stable contract, a contract test and review. The agent may propose a block,
  but may not publish one at runtime.

## Capabilities

### New Capabilities

- `stage-flow-blocks`: the typed block contract, generated catalog, versioning,
  effects/policy metadata, context, contract tests, promotion rules, and
  secret-safe argument handling.
- `stage-block-plans`: the plan schema, validation rules, input/output references,
  runner result contract, journal/evidence integration, and failure semantics.

### Modified Capabilities

- `stage-test-workflow`: the planner may emit a block plan, the executor runs
  that plan through `stage_run`, and the report consumes the runner's structured
  results while retaining an exploratory fallback.
- `stage-flow-journal`: the runner may append journal entries from block
  sub-steps without a per-entry `stage_step` model call; entries keep the
  existing sequence, redaction and evidence rules.

## Impact

- New `src/stage-blocks/` package (or equivalent server-owned module):
  `define-block.ts`, `context.ts`, the block definitions, generated catalog,
  registry, contract tests and examples.
- `src/agent-host/browser-tools.ts` (or a sibling stage-block tool module):
  `stage_blocks` and `stage_run`, plan validation and compact result shaping.
- `src/server/browser/` session/journal integration: a block context over the
  existing allow-listed page facade, `ctx.step` to journal events, evidence
  capture, and stage policy enforcement.
- `src/workflow/steps/` for the `stage.plan`/`stage.execute` behavior and
  `agent-definitions/instructions/stage-test-execute.md` (and the planner
  instruction) for the plan-first workflow.
- New tests: block contract tests, catalog generation, plan validation, runner
  execution, journal output, policy refusals, secret redaction, and the
  `stage-test` workflow path.
- Documentation: the block authoring guide, the catalog/plan format, the
  promotion policy, and the workflow architecture map.

## Non-Goals

- A YAML/JSON DSL as the source of truth for browser actions; plans describe
  block chains, not selectors or Playwright steps.
- One agent tool per block, or blocks published at runtime by an agent.
- An LLM call inside a block. Blocks are deterministic; ambiguity stays in the
  planner.
- Replacing the existing browser tools. They remain the exploratory and
  fallback surface.
- Running saved specs without an agent; that is the follow-up
  `add-stage-flow-replay` change.
- A CDP/browser-engine rewrite.
