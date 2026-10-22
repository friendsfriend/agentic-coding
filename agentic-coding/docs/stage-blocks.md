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

## Blocks as data (`data-block.ts`, `data-store.ts`, `scope.ts`)

A block is either a checked-in TypeScript module (`defineBlock`) or a
reviewed `format: 1` JSON document that the stage-tester authored while
executing the test. Both compile to the same frozen `BlockDefinition`, so the
plan, runner, catalog, flow generator and replay fixture never branch on the
kind — the only difference is that a data block carries `data` (its document),
a `postcondition` instead of a `contractTest`, and no `exportName`.

A document is `{format, id, version, app, roles, title, description, effects,
idempotent, requires, provides, params, returns, examples, postcondition,
operations}`. `operations` is two levels deep — `step`/`optional` groups of
actions — and an action is one of `goto`, `click`, `fill`, `type`
(`pressSequentially`, the only action that may take a delay), `press`,
`select`, `waitFor`, `wait`, `expectVisible`, `expectText`, `capture` and
`read`. A value is a bounded string, `{{ args.<name> }}` interpolation of a
declared parameter, or `{secret: "NAME"}` — never a literal credential, a raw
URL, a script or an expression. `validateDataBlock` enforces the bounds
(64 KiB document, 64 operations, 2000-character text, 1000 ms delay, 10 s wait)
and reports one issue per problem with its JSON path.

`interpretDataBlock(block)(ctx, args)` runs one `ctx.step` per group and checks
the outputs against the documented `returns` schema; an `optional` group
records its own journal entry and swallows its failure so a page's matching
behaviour can be recorded without failing the whole block.

### Drafts, the approved store and promotion

| path | what it holds |
| --- | --- |
| `<configDir>/stages/blocks/<systemSlug>/<id>.json` | the approved document, shared by every workflow of that system |
| `<dataRoot>/stage-block-drafts/<workflowId>/<id>.json` | this run's draft (`{draft, document}`), executable by `stage_run`/replay-free execution in that run only |

A workflow id is reusable, so the id alone cannot say whose draft a file is. The
draft record carries the authoring run's immutable identity (`runId`, the
workflow's `createdAt`) and every read that knows its own run filters on it: a
draft a deleted predecessor left under the same id is not listed, not
executable, not promotable and not a diagnostic of the current run.

`loadStageBlockRegistry` composes the registry per call — checked-in modules,
then approved documents, then this workflow's drafts, a draft superseding an
approved document of the same id — so a draft saved a moment ago is already
executable and nothing is cached across runs. Only a checked-in collision or a
duplicate inside one store is a `block-duplicate`; a draft over an approved
version is a normal, reported replacement.

`stage_block_save` is the only write path for a draft. It is available to the
stage-tester only during `stage.execute` and only with a stage-bound session.
The draft's `planId` and `revision` are the workflow's pinned plan and revision,
derived by the engine, so an authoring call cannot claim to be part of a plan it
is not running. It refuses (`block-document-invalid`, `stage-app-unknown`,
`block-role-undeclared`, `block-destructive-refused`, `block-checked-in`,
`stage-read-only` for a `write` document, `block-secret-literal`,
`block-contract-breaking`). A draft never widens stage policy: writes still
need an approved plan that `createsData`, and `destructive` stays refused.

Promotion is the `stage.blocks.promote` edge effect on `stage.review → approve`
(and `approve-and-update-wiki`): it reads the drafts this run saved that the
report claims (`blocksCreated`/`blocksAdjusted`), validates the claim against
`stageReportBlockIssues` (a claimed draft must carry a passed proof from this
run), writes every approved document atomically and removes the drafts only
after all writes landed. A claimed draft that is missing, unpromoted or
unproven blocks approval, and there is no no-op promotion of a checked-in id.
The run's drafts are removed after a successful promotion, so "keep the drafts"
is the promise of the *decision* (a follow-up comment re-enters `stage.execute`
with the drafts intact), not of the approval.

The promotion is scoped by what the report *claims*, never by what happens to be
on disk:

- Only a claimed id is written. Any other draft in this run's draft directory is
  scratch and is dropped with the directory once the claimed set lands, so a
  leftover draft from an earlier run can never be published by a later approval
  that does not name it (`CONC-005`). A claimed draft is publishable only with a
  passed proof recorded by *this* run, and a proof is only appended after the
  block actually executed green — so the leftover can only travel if it really
  ran and passed here.
- A claim names the *document*: `{ block, version, digest }` for a created or
  adjusted block, where the digest is the one `stage_block_save` returned. The
  report gate refuses a claim whose digest is not the draft's current body, so a
  same-version re-save cannot be approved on a claim about the earlier body.
- A claim whose draft is gone (a `workspace.cleanup` raced the approval, or a
  re-run dropped it) is a permanent failure naming the loss, never a silent
  "nothing to promote" — unless the run holds no claimed draft *and* the
  approved store holds every claim **at its claimed version and digest**, which
  means this attempt is the second half of a promotion that landed, since the
  drafts were removed by it. Then the effect reports the recovery
  (`recovered: true`) instead of failing the workflow on its own success. A
  version match alone is not a recovery: an adjustment may keep the version and
  change the body, and reporting that as promoted would drop the reviewed
  document.
- A proof is a proof of one *document*, not of a block id. Every proof records
  the `version` and the digest of the document that ran, both gates compare the
  claim against the draft's own version and digest (`proofProvesBlock`), and a
  save that changes the body drops the proofs it can no longer claim. A proof of
  a different body is refused at append time rather than silently attached, so
  "saved, executed, edited, approved" can never publish the edited document on
  the executed run's proof.
- A proof append never rewrites a document: it reads the one draft file, appends
  the proof to the document that is already there, keeps the newest
  `MAX_STORED_PROOFS` (5) proofs and refuses when the stored wrapper is a
  different draft format version.
- Everything is all-or-nothing: a document is written by compare-and-write
  against the bytes read at promotion time (`block-concurrently-changed` if
  another writer won; `block-file-unreadable` if the file exists but this build
  cannot interpret it — a newer format, a backup or a hand edit is refused, not
  overwritten), and a failed batch restores the exact bytes it replaced
  — or removes only the files it created — through the same atomic writer and
  mode, so a restored file is byte- and mode-identical to the one it replaced.
  Drafts are removed last, so the failure window cannot destroy the only copy of
  a document that was never published.

The store has one writer: the workflow engine's own process, one promotion at a
time per stage system. `MAX_STORED_BLOCKS` (200) bounds a new id in both the
draft and the approved store (`block-store-full`), one malformed file is a
`block-file-unreadable`/`block-document-invalid` diagnostic instead of a fatal
read, and the same id in two system directories is reported as
`block-duplicate` rather than resolved by directory order.

Promotion re-applies the authoring scope rules (`stage-blocks/scope.ts`) to the
stage as it is configured *now*: a stage that has become read-only, an app or a
role it no longer declares, or a `destructive` document refuses the whole
promotion, so publishing can never be the path around `stage_block_save`.

A value rule that is easy to get wrong (both are `data-block-value`/
`data-block-postcondition` issues, not silent rewrites): `exact` is only
meaningful for the `role` and `text` target strategies, and `waitFor` accepts
only `visible` and `attached` — a `hidden` wait is a removed-control check that
belongs in `expectVisible`/`expectText` semantics, not a wait. `type` uses a
`delayMs` of 50 when the document omits one (a real keystroke sequence, so a
masked or autocompleted field is not filled instantly).

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

## Writing a checked-in block

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

## Authoring a data block

The stage-tester authors a data block; no builder step or role is involved.

1. `stage_blocks` for a block that already matches the step. A plan route step
   declares exactly one of `block`, `blockToCreate`, `blockToAdjust` or
   `noBlockReason`, so the plan states which of the four it expects.
2. Explore the step with the normal snapshot/action loop until it works.
3. `stage_block_save({document})` with one `step` per intent, at least one
   `expectVisible`/`expectText` per step, a declared `params` entry for every
   `{{ args.<name> }}` and `{secret: "NAME"}` for a credential.
4. Run it once with `stage_run` so the draft carries a passed proof.
5. Report `blocksCreated`/`blocksAdjusted` with the `digest` the save returned;
   approving the report promotes the draft into the approved store, where the
   next run's planner sees it.
