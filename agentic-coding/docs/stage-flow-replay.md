# Compiled stage flow replay

A reviewed stage-test scenario does not need a model in its per-step loop
every time it runs. `add-stage-flow-blocks` gives a scenario a typed block
plan; this layer compiles one approved, all-block route into a readable
`@playwright/test` spec that replays deterministically, with the model doing
exploration and healing instead of driving every action.

## Flows: identity, generation, parameterization

A flow is one directory under `stage-flows/<flowId>/`:

- `flow.spec.ts` — the generated, human-readable Playwright test. Edit the
  block or the approved plan, never this file; it is overwritten on the next
  save.
- `flow.json` — the sidecar manifest: title, pinned stage (or `stages`),
  declared applications/roles, derived input schema and examples, route hash,
  spec hash, block versions/digests and the route-step/block/input/expectation
  mapping.

Generation (`stage_run save`, or `generateFlow` directly) maps the approved
stage plan's validated all-block route to the spec. Every block argument that
reads `{{ inputs.<name> }}` becomes a `stage.input<T>("name")` call in the spec
and a property of the derived input schema; `{{ steps.<id>.outputs.<name> }}`
becomes a local variable bound to that step's own typed output. The generated
spec never contains an input *value* — only the binding. That is what makes
one flow reusable: the same reviewed route replays for a different customer,
order or search term by supplying different approved inputs, with a
byte-identical spec, route hash and spec hash; only `inputsHash` changes.

A plan binds a flow with three additive `core.stage-test-plan@1` fields:
`flowId`, `inputs` and, per route step, `expectationIds`. An existing plan
without them is still valid — this is why there is no `@2`. A plan input
binding must be the whole string (`"{{ inputs.customerId }}"`), never an
embedded fragment inside a longer string; a fragment is refused at generation.

Generation itself refuses: a plan that mixes blocked and unblocked steps, a
missing `flowId`, an unresolved output reference, a secret value in an
argument, and a block with no registered digest. The spec is formatted and
type-checked (`bunx tsc --ignoreConfig --noEmit --target es2022 --types node`)
before it is written; a failure there is a generation failure, not a silently
broken checked-in file.

### Data blocks carry their document

A data block (`docs/stage-blocks.md`, "Blocks as data") has no module to
import, so a flow that executes one writes the reviewed document beside its
manifest as `stage-flows/<flowId>/blocks/<id>.json` and the generated spec
calls `stage.runData("<routeStepId>", args)` instead of importing a barrel
symbol. The fixture reads the document from the flow's own directory, so a
replay runs exactly the reviewed document the manifest pinned — never whatever
the live store holds at replay time. The manifest pins each sidecar in its
optional `blockFiles` map (`{ "<blockId>": "blocks/<blockId>.json" }`), so the
reader resolves the file the manifest names instead of guessing a filename from
the id. `flowDocumentIssues` therefore refuses a flow whose `blockFiles` has no
entry for a data block, whose sidecar is missing or unreadable
(`flow-block-document-missing`), or whose sidecar parses into a document that
fails validation or hashes to a different digest (`flow-block-digest`, with the
validation issue as the message) — the difference matters, because "the file is
gone" and "the document changed" are two different repairs — and a flow that
names a block which exists only as an authoring workflow's draft is refused with
`flow-block-draft`: a draft is executable by its own run, never by a replay.
Generation also refuses while the run still holds a draft of the same id — the
flow would otherwise be written from, and hash, a document no checked-in flow
can ever replay.
`bun run stage-flows:check` applies the same rule to the checked-in flows by
compiling each sidecar document, so the gate stays hermetic. The replay side is
A document is validated once and then compiled through the non-revalidating
entry point (`compileValidatedDataBlock`), and a pinned digest is compared
against the digest the block registry already computed (`registry.digest(id)`)
rather than a fresh hash of the function source or the document: eligibility is
checked on a polled read path, so it may not redo what building the registry
already did.

`pinnedDataBlock({ manifest, directory, routeStepId })` in
`src/stage-blocks/fixture.ts`: one exported seam that does the `blockFiles`
lookup, the read, `validateDataBlock`, the digest comparison and the compile,
and that `runData` then executes — so the refusal a replay would hit can be
tested without a browser.

## Eligibility

A flow is eligible for replay only when every one of these still agrees with
the approved plan at hand: the pinned stage, the route hash (block identity,
args and structure — input *values* are deliberately excluded), the derived
input schema, the saved spec's own hash (a hand edit is refused as
`flow-spec-drift`), every block's registered version and digest, and full
application/role coverage. `flowEligibility` returns the first drift reason
rather than guessing a fix. Changing a flow's route requires a new `flowId`;
reusing an existing id with a different route is refused as
`flow-route-changed`.

## Replay

`stage_replay({ flowId, inputs?, dryRun? })` is the agent-facing tool (and the
`stage.replay` workflow step's only call). `dryRun: true` validates a proposed
input set — and derives the typed input schema — without approval and without
a browser. A real run:

1. refuses an explicit `inputs` whose hash differs from the approved plan
   revision's (`flow-inputs-unapproved`) — changed values need a new approved
   revision, reusing the same route hash and spec;
2. launches a **separate Playwright process** (a generated, run-local config;
   no server browser session), with the stage id, declared applications/roles,
   the approved plan id/revision and `inputsHash`, a bounded run-input file
   (removed after the process exits), a short-lived run token (never raw
   credentials) and the trace/video policy;
3. ingests the process's bounded result: validates every event, redacts it,
   allocates journal sequence numbers, appends to the normal stage journal
   (`source: "replay"`, `flowId`, `revision`, `inputsHash`, `replayRunId`) and
   merges evidence exactly like a model-driven run's;
4. maps a complete, redacted result deterministically to `core.stage-report@1`
   — reusing the existing validator, citation checks, redactor and render
   effect. Replay never introduces a second report type. A plan priority maps
   to failure severity unless the manifest declares an override. An
   expectation left without a verdict, or a citation of evidence/journal steps
   that do not exist, is refused the same way a model-authored report is.

Trace is `retain-on-failure` by default; video is opt-in
(`STAGE_REPLAY_VIDEO=1`), since a CI image or developer cache may not have
Playwright's ffmpeg binary. `stage_journal` may be called during replay for
read-only inspection even though replay opens no server browser session.

### Secrets

The replay fixture resolves `ctx.secret(name)` only for the stage's own
declared credential variable names (`STAGE_SECRET_NAMES`, passed as an
allow-list); any other lookup is refused. The child process's environment
drops every other configured secret plus the host/run/workflow tokens before
the process starts. Plan inputs are test data, not credentials — never put a
secret value in a plan input or a flow argument.

### Timeouts and a non-zero exit

The fixture sets `actionTimeout: 15_000`, and `stage-replay.ts` allows the
process a matching bounded budget. A replay process that exits non-zero after
reporting a pass is not a pass: the decoder marks the first non-passed step
(else the last) as `failed` with the stderr tail and returns a failed result
naming `routeStepId` and `block@version`, so the run gets the step that did not
complete instead of `replay-result-invalid`.

### Heal packet and the repair boundary

A failed replay returns to `stage.execute` carrying a bounded, redacted
`stage-heal.json`: the failing route step, block/version, sub-step,
expected/observed text, retryability, evidence ids, a trace reference, the
scoped region and the last passing step. A stage workflow never edits a block
or spec, recompiles, commits, pushes or auto-promotes a fix from this packet —
a failed replay is a signal for a *reviewed code change* (editing the block,
running its own contract test, and re-approving the plan), not something the
stage workflow repairs itself.

### API-first flows

`ctx.api` in the replay fixture is backed by the same `stage_api_request`
policy and a short-lived run token as the model-driven path: declared
application, declared role, a relative path, the origin allow-list, method,
size bounds and the stage's read-only policy are all enforced identically.
Setup, assertion and cleanup calls are journaled as sub-steps, and a
state-changing call counts as a `write` effect the same way a UI action does.

## Workflow integration

`stage.replay` is an optional step in the `stage-test` family, reached only
through the plan-review action `approve-and-replay` — offered in place of
`approve-plan` exactly when the approved-plan-to-be names a flow the engine
can independently confirm is eligible (`workflow/runtime/stage-replay-eligibility.ts`,
evaluated at the impure runtime boundary; the pure step behavior never reaches
the stage-blocks registry or the evidence store itself). A plan naming a
`flowId` always routes through plan review, even under a policy that would
otherwise skip it, so a flow can only ever replay against an *approved* plan.

The stage-tester's one job at `stage.replay` is to call `stage_replay({
flowId })` — no browser tools, no `stage_run`, no inputs (the approved plan
revision is authoritative) — and report the outcome. The engine itself reads
the already-ingested result/report/heal evidence (`workflow/runtime/stage-replay-evidence.ts`)
rather than trusting anything the model reports:

- a **passing** replay re-validates the report and attaches it through the
  same `stage.report.render` effect `stage.execute` uses, then transitions to
  `stage.review`;
- a **failed** replay attaches the heal packet and falls back to
  `stage.execute`;
- an **ineligible** result (no flow named, no result attached, an unusable
  report) falls back to `stage.execute` with a visible reason — it never
  silently claims a pass.

The mapped report (`replay-report.ts`) matches what `stage_report` accepts, so a
replayed run reaches the same `stage.review` with the same shape: `blocksUsed`
holds one `{routeStepId, block, version}` per executed step, and every planned
route step the compiled flow has no step for is listed in `unblockedSteps` with
its `noBlockReason` (or a stated "the compiled flow has no step for this route
step"), so the block accounting never reports a step as neither used nor
unblocked.

The workflow snapshot's `stageReplay` metadata summarizes the attempt (status,
flow id, plan id/revision, `inputsHash`/`routeHash`, block versions/digests,
and the result/report/heal evidence ids) so a developer reviewing the run can
see exactly what replayed without opening the evidence store.

## Parallel suites

A suite (`stage-flows/<suiteId>.suite.json`) names several **independent**
flow entries that replay as one regression/CI batch — never a shortcut to a
workflow report:

```json
{
	"version": 1,
	"suiteId": "crm-smoke",
	"parallel": true,
	"stopOnFailure": false,
	"flows": [
		{ "id": "customer-address", "flowId": "customer-address", "inputs": { "...": "..." } },
		{ "id": "customer-search", "flowId": "customer-search", "inputs": { "path": "/search?q=acme" } }
	]
}
```

Each entry's `id` defaults to `<flowId>#<index>`, so the same flow may appear
more than once with different inputs. An entry that declares `sharedData:
true`, a `sequence` or a `dependsOn` list refuses the whole suite's `parallel:
true` (`suite-parallel-dependency`) — independence is declared, never
inferred; a non-parallel suite simply runs its entries in the manifest's own
array order. `dependsOn` must name an earlier entry; a forward reference, an
unknown entry or a self-dependency is refused before any context starts.

`stage_replay({ suiteId })` runs every entry through **exactly the same**
single-flow approval/eligibility/execution path a lone `flowId` call would —
there is no second, looser approval rule for a suite entry. Concurrency is
bounded by `parallel` and a worker cap (`browser.max_sessions`, bounded
further by a fixed ceiling); `stopOnFailure: true` stops scheduling new
entries once one fails or is refused, and the rest are reported `skipped`. The
aggregate result lists every entry's own status (`passed`, `failed`,
`refused` or `skipped`), `inputsHash`/`routeHash` and evidence ids, with one
redacted aggregate evidence entry for the whole run; it is never mapped to
`core.stage-test-plan`/`core.stage-report@1`.

### Standalone CI

`bun run scripts/stage-flow-run.ts --flow <flowId> --stage <stage> --inputs
<file.json>` (or `--suite <suiteId>`) runs the same generated spec through the
same launcher and the same suite orchestration, without a workflow and without
an approved-plan gate — the design's "regression/CI path" rather than the
agent path. It resolves the stage's declared application URLs and credential
variable names from the normal configuration root, validates the supplied
inputs against the flow's own schema before starting a browser, and exits
non-zero on a schema error, a non-zero process exit, an invalid result or any
failed/refused entry. `scripts/check-stage-flows.ts` (wired into `bun run
build`) validates every checked-in flow *and* suite manifest — including a
suite's cross-reference to its flows' input schemas — with no browser needed.

## Checked-in pilot

`stage-flows/customer-address/` (writable, fills and saves an address) and
`stage-flows/customer-search/` (read-only) are the checked-in reference
flows; `stage-flows/crm-smoke.suite.json` runs both together as the pilot
parallel suite. Replaying `customer-address` with two different approved
input sets produces a byte-identical spec, route hash and spec hash, with only
`inputsHash` differing — the reuse property this whole design exists for.
