## Why

A stage block is today a checked-in TypeScript function loaded once at process
start (`src/stage-blocks/registry.ts`, `blocks/pilot.ts`). The stage-tester can
read that catalog (`stage_blocks`) and run a plan of it (`stage_run`), but it
cannot add or adjust a block while it tests. The developer's decision is that
blocks are the normal way a stage test is done and that the tester itself
creates or adjusts them during the run, with no separate builder step, role or
manual authoring task: a test ends in blocks, or it records why it did not.

Making the tester an author needs blocks to become data: a reviewed JSON
document over the existing allow-listed browser surface, stored beside the stage
definitions, runnable in the run that drafted it and promotable into the shared
store at the existing review gate — with no rebuild and no restart in between.
The same change has to close two gaps that block a real authoring run against
the qa-ava address form: `fill` does not trigger the suggestion widgets the form
only opens on real keystrokes, and a Playwright action timeout currently makes
the replay process exit `1` while `stage-run.json` still says `passed`.

## What Changes

- **Declarative block documents (`stages/blocks/<system>/<id>.json`).** A JSON
  document carries the `defineBlock` metadata and a bounded, closed list of
  operations over exactly the existing allow-listed surface (`goto`,
  `getByRole`/`getByLabel`/`getByTestId`/`getByText`/`locator`, `click`, `fill`,
  `type`, `press`, `selectOption`, `waitFor`, `expect`, journalled sub-steps,
  `capture`, `read` into a typed output, an optional-operation form, and secret
  references by name). Parameters are referenced only as `{{ args.<name> }}`.
  No code, expressions, scripts, raw URLs outside the declared application or
  credentials.
- **A pure interpreter, so everything downstream is unchanged.** A data document
  compiles to the same frozen `BlockDefinition` the runner, the plan validator,
  the catalog, the flow generator and the Playwright fixture already consume;
  the digest covers the document body, not only the interpreter source.
- **Load at use time, never at start-up.** The registry a tool sees is composed
  per call from the checked-in blocks (unchanged, still the only source of the
  generated catalog) plus the approved data blocks under the configuration root
  plus the calling workflow's drafts — so a block approved in one run is in
  `stage_blocks`, `stage_run` and the planner's reach in the next run without a
  rebuild or restart. A malformed document, a duplicate id or a breaking change
  without a major bump is excluded with a value-free diagnostic, never loaded.
- **`stage_block_save`** (stage-tester only, stage-bound session only) validates
  a document against the closed schema, the pinned stage's declared applications
  and roles and the effect policy, and writes it as a **draft scoped to the
  workflow run**. A draft is runnable through `stage_run` in that run, records
  its live proof, and is invisible to every other run. An approved block is
  never edited in place: adjusting one saves a new version under the same
  breaking-contract rules, and a checked-in block is read-only to the tester.
- **Blocks-first policy in the plan and the report.** The stage-planner
  instruction and `core.stage-test-plan@1` gain "the block to use, or the block
  to create/adjust, else `noBlockReason`" per route step; the report gains the
  blocks used/created/adjusted with their proof and every route step that ended
  unblocked with its reason, and a report whose unblocked steps have no reason is
  refused. **BREAKING** for a plan route step that names none of these.
- **Review and promotion at the existing gate.** `stage.review` shows one
  readable diff per created/adjusted block with its recorded proof; approving
  the review promotes the drafts into the shared store atomically, a follow-up
  request keeps them as drafts. No new step, gate or role.
- **Flows and replay for data blocks.** The generated spec interprets a data
  block inline (no barrel, no `exportName`, no stage-app-key collision), the
  flow manifest pins each data block's version and digest so an edit makes the
  flow ineligible as `flow-block-drift`, and a flow may never pin a draft.
- **Typed key input.** `BlockLocator.type(value, { delayMs })` (a real
  `pressSequentially` with a bounded delay and bounded text) in the server
  session adapter, the replay fixture and the data-block operation set.
- **Replay robustness.** The generated replay config sets `actionTimeout`
  (about 15 s), and a Playwright `timedOut`/non-reported outcome becomes a
  `failed` result naming the failing step and sub-step instead of a `passed`
  `stage-run.json` plus `replay-result-invalid`.
- `docs/stage-blocks.md` and `docs/stage-flow-replay.md` document the data
  format, the draft lifecycle, promotion and the replay failure contract.

## Capabilities

### New Capabilities

- `stage-data-blocks`: the declarative block document, its closed operation
  surface and interpreter, the approved store and per-run drafts, the
  `stage_block_save` tool, the load-at-use-time catalog merge, diagnostics for a
  refused document, and promotion of approved drafts into the shared store.

### Modified Capabilities

- `stage-flow-blocks`: block identity/digest for a data block (digest covers the
  document body), `BlockLocator.type` typed key input, and the catalog's block
  kind (checked-in vs data) in its compact and full projections.
- `stage-block-plans`: a route step selects its block by using one, creating one,
  adjusting one, or declaring `noBlockReason`; a draft is runnable inside its own
  run and a draft may never be saved into a flow.
- `stage-flow-replay`: generation and replay of routes that use data blocks
  (inline interpretation, manifest pins, drift refusal), the generated config's
  action timeout, and the mapping of a timed-out or non-reported replay to a
  failed result naming the failing step.
- `stage-test-workflow`: the blocks-first plan and report fields, the report
  validation that refuses an unexplained unblocked route step, the review gate's
  block diffs and the promotion of approved drafts on approval.

## Impact

- `agentic-coding/src/stage-blocks/`: new `data-block.ts` (document schema,
  validation, interpreter), `data-store.ts` (approved store, drafts, promotion,
  diagnostics), `registry.ts` (compose at use time), `define-block.ts`
  (`BlockLocator.type`, optional data body, digest), `catalog.ts` (kind/status),
  `flow-generator.ts`/`flow-spec.ts`/`fixture.ts`/`flow.ts` (data-block specs and
  pins), `plan.ts` (route-step block selection).
- `agentic-coding/src/server/browser/`: `stage-block-page.ts` (`type`),
  `session.ts` + `types.ts` + `playwright-driver.ts` + `fake-driver.ts`
  (`pressSequentially`), `routes.ts` (`stage_blocks`, `stage_run` and the new
  `stage_block_save` route compose the registry; review/promotion wiring),
  `stage-replay.ts` (`actionTimeout`, timed-out mapping).
- `agentic-coding/src/contracts/stage-blocks.ts`, `src/agent-host/browser-tools.ts`
  (the `stage_block_save` tool and its response projection).
- `agentic-coding/src/workflow/`: `schema.ts` (plan/report fields),
  `definitions/contracts.ts` (cross-field blocks-first check), `steps/stage-test.ts`
  (report validation, review gate presentation), `definitions/graphs/stage-test.ts`
  (promotion edge effect), `src/contracts/workflow.ts` + `src/workflow/runtime/store.ts` +
  `src/workflow/definitions/registerBuiltins.ts` + `src/workflow/effect-runner.ts`
  (`stage.blocks.promote`, plus `definitions/manifest-policy.ts` for the
  stage-test definition-version bump), `prompt-inventory.ts` (a budget
  raise only if a family exceeds its ceiling).
- `agent-definitions/instructions/stage-test-plan.md`,
  `stage-test-execute.md` and the regenerated `src/workflow/embedded.generated.ts`.
- `agentic-coding/docs/stage-blocks.md`, `docs/stage-flow-replay.md`.
- Tests: stage-block document/interpreter, data store and drafts, save tool
  route, catalog merge, plan/report contracts, review promotion, flow
  generation/replay with a data block, `type` in both adapters, replay timeout
  mapping. No test may need a real hosted stage, the real configuration root or
  credentials.
