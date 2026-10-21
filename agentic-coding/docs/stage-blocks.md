# Stage blocks

A stage block is one reviewed, typed unit of browser work between a stage
plan and the browser: the plan owns the chain, inputs and approval; the block
owns the mechanics of one user intention (sign in, open a record, fill and
save a form); the runner owns the browser session, journal and evidence. A
block is an ordinary async TypeScript function, not an Effect service or a
generated artifact — the same function executes under `stage_run` (the plan
runner, backed by the existing browser session) and under a generated
Playwright spec's `flow.spec.ts` (the replay fixture), so reviewing a block
once covers both paths.

## The contract (`define-block.ts`)

`defineBlock(definition)` validates a block at definition time and returns
its frozen `BlockDefinition` plus a content-addressed `digest`:

| field | meaning |
| --- | --- |
| `id` | `app.intentName` (for example `crm.customer.fillAddress`); validated by pattern |
| `version` | semver (`major.minor.patch`) |
| `app` | the stage application key, or `*` for a cross-application block |
| `roles` | the roles it is approved for; empty means every role of the app |
| `params` / `returns` | the supported JSON-schema subset (`schema.ts`) |
| `effects` | `read`, `write` or `destructive` |
| `idempotent` | whether a failed read may retry once |
| `requires` / `provides` | state identifiers a plan's steps must satisfy/declare in order |
| `examples` | validated against `params` at definition time |
| `contractTest` | the repository test file that proves this block against its real application |
| `exportName` | the symbol a generated spec imports from the application's block barrel (public blocks only) |
| `internal` | excluded from the generated catalog and from flow generation |
| `deprecated` | optional `{ replacementId?, removalDate? }`, surfaced in the catalog |

Definition-time validation rejects a malformed id/version/app/role, an empty
title/description, an invalid parameter/return schema, and an example that
does not validate against its own parameter schema — a block the registry
loads is already a block whose contract makes sense.

### `StageContext`

A block's `run(ctx, args)` sees only the allow-listed facade, never a raw
Playwright handle: `ctx.page` (navigation and allow-listed locators),
`ctx.expect` (assertions over a locator), `ctx.app`/`ctx.role`/`ctx.stage`/
`ctx.appUrl`, `ctx.run` (plan id/revision/flowId/route-step id/block
id+version/index), `ctx.api` (the same `stage_api_request` policy, for an
API-first block), and three journal/evidence primitives:

- `ctx.step(label, fn, details?)` — runs one journalled sub-step; a block must
  emit at least one, or the runner raises a block-contract violation
  (`block-no-step`). `details` may carry `expected`/`observed`/`captures`/
  a `knowledge` observation.
- `ctx.capture(label, options?)` — stores a screenshot (or another bounded
  capture) and returns its evidence id, attributed to the current sub-step.
- `ctx.secret(name)` — resolves one `.env` value by the stage's own declared
  credential variable name; it never accepts a literal secret, and an
  unconfigured/unknown name is refused rather than silently returning nothing.

## Catalog

`scripts/generate-stage-blocks.ts` writes the machine-readable, sorted,
internal-excluding catalog (`src/stage-blocks/catalog.generated.ts`) from the
registry; `--check` fails when the checked-in artifact differs from the
generator's current output (wired into `bun run build`, so the catalog can
never silently drift from the block source). The build gate additionally
fails a block missing a title, description, parameter schema, return schema,
an effect, scope or an example, and a block whose `contractTest` file does
not exist.

The agent tool `stage_blocks({ query?, app?, effect?, id?, limit? })` returns
**compact** entries by default (id, version, app, effects, title — no schema,
no examples) and the **full** entry (parameter/return schema, validated
examples, source digest) only for one named `id`. No per-block tool is ever
registered; the catalog is the whole surface.

## Plan format and the runner (`plan.ts`, `runner.ts`)

A `StageBlockPlan` is `{ planId, flowId?, revision?, inputs?, steps[] }`: each
step is `{ id?, block, args, save? }`, bounded in count. An argument may bind
a later value instead of a literal:

- `{{ inputs.<name> }}` — the plan's own named input;
- `{{ steps.<routeStepId>.outputs.<path> }}` — another step's own typed
  output.

Nothing else is accepted as a binding — no function, script, expression or
selector. Validation (`validateStageBlockPlan`) runs entirely before any
browser opens and checks, per step: the block id is registered, its arguments
match its parameter schema (after resolving every binding), an input
reference names a real plan input, an output reference names an earlier
step's real output, the block's application/role scope matches the stage
policy, `requires`/`provides` state is satisfied in order (an unmet
requirement or a provided-twice state both refuse), and the plan does not
exceed the step-count bound. Every issue is stable and bounded: step index,
block id, field and a fixed code (`block-unknown`, `input-missing`,
`stage-app-mismatch`, `stage-role-mismatch`, `block-requires-unmet`,
`block-provides-conflict`, `route-step-duplicate`, …). `dryRun: true` returns
exactly these issues and the resolved block versions, with no browser opened.

The policy also enforces effects against the stage itself: a `destructive`
block is always refused (`stage-action-destructive`); a `write` block is
refused on a read-only stage (`stage-read-only`) or when the approved plan
does not permit data creation (`stage-action-not-approved`).

The runner (`runStageBlockPlan`) executes a validated plan's steps in order,
resolving every input/output reference, and records per step: index, route
step id, block id, resolved version, status, duration, outputs, journal ids
and evidence ids. It stops on the first failure, retries an idempotent read
at most once, and never retries a non-idempotent write or a destructive
block. The result envelope carries the plan id, `inputsHash`, the approved
plan revision, the stage, overall status, per-step results and failure
details — never raw inputs and never a full page snapshot.

## Journal and evidence

Every `ctx.step` call becomes one journal entry through the **existing**
journal writer, redactor, sanitized-URL cleaning, evidence-manifest
validation and sequence allocation — blocks do not create a second journal
format. A step failure captures a screenshot, a scoped snapshot of the
failing region, a bounded console tail and a bounded network tail, subject to
the same stage screenshot/recording limits exploratory tools already answer
to.

## Versioning and contract changes

`breakingContractChanges(previous, next)` detects a changed parameter schema,
return schema, application scope, effects, `requires` or `provides` — any of
these without a major version bump (`hasMajorBump`) is a build-time
registry failure. A block due for retirement carries `deprecated: {
replacementId?, removalDate? }`, surfaced in both the compact and full
catalog so a planner sees it before choosing it.

## The `stage_run` tool

`stage_run({ plan, session?, dryRun?, save? })` validates and executes a
linear block plan in one call and returns a compact ledger (the journal and
evidence store hold the detail). It accepts either a standalone block plan or
the approved stage-test plan whose route steps carry `block` entries — a
route step with no `block` is reported back as a `plan-route-gap` rather than
attempted, so a plan may be partly blocked and partly exploratory: the tester
runs the blocked steps through one `stage_run` call and the rest with the
normal snapshot/action tools, in the planned route order. Execution needs a
stage-bound session and the same stage/write policy as the exploratory tools;
inputs and arguments must never contain a credential — use a block's
secret-variable argument instead.

`save: true` turns a fully blocked, approved stage plan that also names a
`flowId` into a saved, replayable flow (`stage-flows/<flowId>/`) — see
[`docs/stage-flow-replay.md`](stage-flow-replay.md) for generation,
parameterized inputs and replay itself. A standalone block plan (no approved
workflow plan behind it) is refused with `flow-identity-missing` if `save` is
requested, since there is no plan revision to attribute the saved flow to.

## Writing a new block

1. Add the block to `src/stage-blocks/blocks/<app>/` with `defineBlock`,
   including a contract test that proves it against the real application and
   at least one validated example.
2. Mark it `internal: true` until it is reviewed for general use; an internal
   block is still runnable through `stage_run`/the registry, just excluded
   from the generated catalog and from flow generation.
3. Run `bun run stage-blocks:check` (wired into `bun run build`) — it fails on
   a stale checked-in catalog or a missing title/description/schema/effect/
   example/contract test.
4. Promote it by removing `internal` and setting `exportName` to the symbol a
   generated flow spec should import from the application's block barrel.
   Regenerate the catalog once more.
5. A later breaking change (schema, scope, effects, `requires`/`provides`)
   needs a major version bump; the registry refuses to load an unbumped
   breaking change.
