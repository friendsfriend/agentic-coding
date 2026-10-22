## Context

A stage block today is a checked-in TypeScript function: `defineBlock` validates
it at module load, `registry.ts` builds the one registry the process ever has,
`catalog.generated.ts` is a build artifact of it, and `stage_run` executes a
plan of it against a stage-bound session. The planner reads the catalog
(`stage_blocks`) and names a block per route step; the tester runs the blocked
steps and explores the rest by hand.

The developer's decision changes who authors blocks: blocks are the normal way a
stage test is done and the stage-tester itself creates or adjusts them while it
tests. There is no builder step, role or workflow for blocks. That requires the
block unit to stop being process-loaded code and become reviewed data:

- the tester must be able to add or change a block **during** a run, against the
  real stage, and prove it works there (`stage_run`) before anyone reviews it;
- a block approved in one run must be usable by the next run's planner and
  tester **without a rebuild or restart**, because the developer rebuilds and
  restarts the server deliberately, not per stage test;
- the surface a data block can reach must stay exactly the allow-listed one
  (`BlockPage`/`BlockLocator`/`StageContext`) so the stage's origin, read-only,
  write-approval and redaction policy is unchanged;
- the existing review gate has to become the place where authored blocks are
  reviewed and promoted, so an unapproved block is never visible to another run
  or flow.

Existing constraints this design keeps: `STORE_SCHEMA_VERSION` (6) does not
change and there is no migration or compatibility shim; `destructive` stays
refused; writes still need the approved plan's `createsData`; the journal,
redaction and sanitised-URL rules are the existing ones; tests never touch a
real hosted stage, the real configuration root or credentials; the checked-in
generated catalog and its build gate keep covering the checked-in blocks
unchanged.

Two gaps must close in the same change because the first real authoring run
needs them: the qa-ava address fields (`addressPage__search`, `addressPage__street`)
only open their suggestion widgets on real keystrokes, and `fill` does not
produce keystrokes, so the block operation set needs `type`; and a replay whose
Playwright action times out currently exits `1` while `stage-run.json` reports
`passed`, which surfaces as `replay-result-invalid: the replay process exited 1
but reported a pass` instead of a failure that names the step.

## Goals / Non-Goals

**Goals:**

- One closed, reviewable JSON block document that compiles to the *same*
  `BlockDefinition` every existing consumer already understands (plan
  validator, runner, catalog, flow generator, replay fixture, eligibility).
- Approved data blocks and the calling workflow's drafts load at use time, so
  `stage_blocks`, `stage_run`, flow eligibility and the next run's planner see a
  block saved minutes ago without a rebuild or restart.
- A tester-only `stage_block_save` that validates hard, writes a run-scoped
  draft, and never touches an approved block in place.
- Blocks-first plan and report contracts: every route step names the block to
  use, to create or to adjust, or records `noBlockReason`; the report proves
  every authored block and explains every step that ended unblocked.
- Review shows the diff of each authored block with its proof; approval promotes
  it atomically into the shared store; follow-up keeps it a draft.
- Flows and replay understand data blocks: generation, inline interpretation,
  pinned version+digest and a drift refusal.
- Typed key input (`type`) in both adapters, and a replay that fails honestly
  when Playwright times out.

**Non-Goals:**

- Writing the real qa-ava (or clerk/Entra) blocks: the tester authors those in
  its first real run after this ships.
- A separate builder step, role, workflow or manual authoring task. Authoring
  happens inside `stage.execute`.
- Any widening of what a block may do: no raw URLs outside the declared
  application, no arbitrary selectors beyond the existing `locator(selector)`,
  no scripts, expressions, branches, loops, API calls or credential literals.
- Changing `STORE_SCHEMA_VERSION`, adding a migration, or keeping two block
  formats alive (a checked-in block is not rewritten as data by this change).
- Making the generated catalog (`catalog.generated.ts`) cover data blocks: it
  stays the checked-in build artifact and its gate semantics are unchanged.

## Decisions

### D1. A data block is data; the interpreter is the only code

A data block document is JSON with `format: 1` and the `defineBlock`
metadata (`id`, `version`, `title`, `description`, `app`, `roles`, `effects`,
`idempotent`, `requires`, `provides`, `params`, `returns`, `examples`,
`postcondition`) plus `operations`. There is no `contractTest` and no
`exportName` (a data block has no TypeScript export and no barrel entry).

`operations` is a closed discriminated union over exactly the allow-listed
surface:

| `op` | shape | notes |
| --- | --- | --- |
| `step` | `{ label, expected?, observed?, captures?, knowledge?, operations }` | the journalled sub-step; every other top-level op must sit inside one |
| `optional` | `{ reason, operations }` | runs inside one `ctx.step`; a failure is recorded in that entry's `observed` and swallowed |
| `goto` | `{ path }` | `path` starts with `/`, no `..`, no `//`, no scheme; resolved against `ctx.appUrl` |
| `click` | `{ target }` | |
| `fill` | `{ target, value }` | |
| `type` | `{ target, value, delayMs? }` | `pressSequentially`, `delayMs` 0–1000 (default 50) |
| `press` | `{ target, key }` | Playwright key names only, no modifier smuggling beyond `a+b` |
| `select` | `{ target, values }` | |
| `waitFor` | `{ target, state?, }` | `visible`/`attached` (no `hidden`, matching the session facade) |
| `wait` | `{ ms }` | ≤ 10 000 |
| `expectVisible` | `{ target }` | |
| `expectText` | `{ target, contains }` | ≤ 2000 chars |
| `capture` | `{ label }` | `ctx.capture`, attributed to the enclosing sub-step |
| `read` | `{ target, into, trim? }` | one string output; `into` must be a declared property of `returns` |

`target` is a closed union: `{ role, name?, exact? }`, `{ label }`,
`{ testId }`, `{ text, exact? }`, `{ selector }` (≤ 500 chars) — one variant per
target, mirroring `BlockPage`'s own getters.

A `value` is either a bounded string (≤ 2000 chars) or `{ secret: "<ENV_NAME>" }`;
a string may contain `{{ args.<name> }}` placeholders naming a declared
parameter (a whole-string placeholder passes the argument through, an embedded
one is interpolated). `{{ steps.<id>.outputs.<path> }}` is deliberately *not*
part of the document: that binding belongs to the plan and is resolved by the
runner before the block runs, so the interpreter only ever sees literals.

Bounds: document ≤ 64 KiB, ≤ 64 operations counting nesting, nesting depth ≤ 3,
labels ≤ 200 chars. The document must contain at least one `step` and at least
one `expect*` (the postcondition); every top-level operation is a `step` or an
`optional`. No unknown key is allowed anywhere (`additionalProperties: false`
semantics), so a `script`, `expression`, `url` or `code` field is a validation
error rather than silently ignored.

*Why this over "operations as a mini-DSL with expressions":* a validator that
must prove "no code" is only tractable when the language has no operators,
conditionals or variables beyond argument interpolation. Anything a test needs
beyond that belongs in a real checked-in block.

*Alternative considered and rejected:* a per-block sandboxed script (or a JS
subset). It would need an interpreter-level security review of its own, and the
reviewed artifact would stop being readable data.

### D2. Compilation reuses the existing `BlockDefinition`

`compileDataBlock(document)` returns a frozen `BlockDefinition` whose `run` is
`(ctx, args) => interpretDataBlock(ctx, args, document)`. The definition gains
one optional field, `data?: StageDataBlockDocument` (the frozen document), which
is what makes a block recognisably a data block downstream.

Consequences handled explicitly:

- `contractTest` becomes optional on `BlockDefinition`/`BlockMetadata`;
  `defineBlock` still requires it for a checked-in block, and the build gate's
  contract-test check keeps reading checked-in definitions only.
- `blockDigest` hashes `data ?? run.toString()` as its `body` field. Without
  that, every data block would share one interpreter source and one digest.
- `blockMetadata`/the catalog gain `kind: "checked-in" | "data"`; the full entry
  gains `postcondition` for data blocks. `status: "draft"` is added only when the
  composed registry is built for the owning run, so another run never sees it.

*Why:* every consumer already keys off `BlockDefinition` (plan validation,
`requires`/`provides` ordering, effect policy, digest pinning, flow rendering,
replay). Compiling to it means the data format cannot drift from the code format
and no consumer needs a second branch — except the two places that genuinely
differ (catalog kind, flow spec rendering).

### D3. Storage, composition and diagnostics

```
<configDir>/stages/blocks/<systemSlug>/<id>.json        approved (shared)
<dataRoot>/stage-block-drafts/<workflowId>/<id>.json    drafts (one run)
```

- One file per block id, the version inside — an adjustment replaces the file
  with a higher version, so the store can never hold two live versions of one id.
- `<systemSlug>` is the pinned stage's `system` (`stages/definitions/*.json`)
  lowercased to `[a-z0-9-]`; a system that slugs to empty refuses the save
  (`block-store-system`).
- An approved file is the bare document. A draft file is
  `{ draft: { version, workflowId, runId, stage, planId, revision, createdAt,
  updatedAt, proofs: [...] }, document: <document> }` — `version` is the draft
  envelope's own `STAGE_BLOCK_DRAFT_VERSION`, not the block's version. `runId` is
  the run's immutable identity (`metadata.createdAt`), because a workflow id is
  reusable: a draft whose `runId` is not this run's is not read, so a deleted
  predecessor's document and its passed proof are never adopted as this run's
  work. `planId` and `revision` come from the workflow's pinned plan and
  revision, never from the tester's request (OSV-017).
- `proofs` is bounded to the newest five `{ stage, runId, planId, revision,
  status, at, journalIds, evidenceIds, version, digest }`. The last two are the
  identity of the document that actually ran: a proof is a proof of *that*
  document, not of the id. A save that changes the body drops the proofs, and a
  proof of a different body is refused at append time, so an edited block can
  never be approved on an earlier run.
- Writes are temp-file + `rename` with mode `0600` for both drafts and approved
  files, and the rollback restore re-writes the previous bytes with the same
  helper, so a restored file is byte- and mode-identical to the one it replaces.

`loadStageBlockRegistry({ configDir, dataRoot, workflowId, runId? })` returns
`{ registry, diagnostics, approved, drafts }`. `dataRoot` is required for the
drafts to be composed at all — omitted, the result carries `drafts: []` and no
draft diagnostic — and `runId` (the run's own identity) is what keeps a reused
workflow id from adopting a deleted predecessor's drafts (`CONC-103`).
Composition order: checked-in (the existing static registry, unchanged, built at
module load) → approved store → that run's drafts. A diagnostic is value-free
(`{ code, id?, file, message }`) and the document is **not** loaded:

| code | when |
| --- | --- |
| `block-duplicate` | a data id already exists in the checked-in registry or twice in the approved store. An approved document *plus* this run's draft is not a duplicate: an adjustment draft is meant to supersede the approved version on promotion |
| `block-document-invalid` | `validateDataBlock` issues (path + message, never a value) |
| `block-contract-breaking` | an adjustment changes `params`/`returns`/`app`/`roles`/`effects`/`requires`/`provides` without `hasMajorBump` against the stored version |
| `block-file-unreadable` | unparseable JSON or larger than 64 KiB |
| `block-store-full` | more than 200 approved documents |
| `block-store-system` | the stage's `system` does not slug |

Because composition is per call (a handful of small files, bounded), a save is
visible immediately to `stage_blocks` and `stage_run` *of the run that saved
it*. It is not visible to another run's catalog, to the planner, or to flow
eligibility: a draft is run scratch, flow generation refuses a route step that
names one (`flow-block-draft`), and only the approval publishes it. The composed
registry itself is not cached; the one memo in this area is the pinned flow
sidecar verdict in `flow-registry.ts`, keyed by the file's `mtimeMs`/`size` so an
edited document is re-read (`PERF-202`).

*Why not "restart the registry on save":* the server is a long-lived process
serving several workflows; a mutable module-level singleton would leak one run's
drafts into another run's catalog, which the review rule forbids.

### D4. `stage_block_save` is the tester's only authoring tool

A new browser route + agent tool
`stage_block_save({ document, session? })` that is refused unless:

- the calling workflow is at `stage.execute` (`deps.locate(workflowId).currentStep`),
  with an approved plan in the snapshot — so the planner, reviewer, replay step
  and any non-stage agent cannot author;
- the session is stage-bound to exactly the pinned stage;
- `document.app` is a declared application of that stage and `document.roles`
  are that application's declared roles;
- `effects` contains no `destructive`, and a `write` document needs a writable
  stage (execution still needs the plan's `createsData`, unchanged);
- `document.id` does not exist as a checked-in block (`block-checked-in`);
- an adjustment of an existing approved data block keeps the contract
  (`params`, `returns`, `app`, `roles`, `effects`, `requires`, `provides`) or
  bumps the major (`block-contract-breaking`) — moving a block to another
  application or role list is one of those breaking changes, so it is refused
  unless the major version is bumped;
- the document contains no configured secret value (`block-secret-literal`),
  reusing the flow generator's `containsSecret` idea;
- the document passes `validateDataBlock` with bounded, path-addressed issues.

It returns `{ status: "draft", id, version, digest, url?, replaced?:
{ version }, warnings: [], proofs: [...] }`. It never returns the document back
in full.

*Why only the tester:* the developer's decision is explicit that blocks are
authored by the tester during a test, and the tool can write a browser-driving
artifact plus a shared-store promotion — a capability no other role should
hold. The step and session gate is the enforcement point because tool
installation is not yet per step (`scope-agent-tools-per-step` is a separate,
unlanded change).

Recording proof: `stage_run` already returns per-step results. After a run, the
route appends one proof record to every draft the plan executed (status,
planId/revision, stage, journal and evidence ids). A draft without a passed
proof cannot be promoted and cannot satisfy the report's block claims.

### D5. Blocks-first plan and report (additive within version 1)

`StageTestPlanSchema.route[]` gains three optional fields beside the existing
`block`:

```jsonc
{ "blockToCreate": { "id", "version"?, "args"?, "intent" } }
{ "blockToAdjust": { "id", "version"?, "args"?, "reason" } }
{ "noBlockReason": "..." }
```

`blockPlanFromRoute` treats a route step's effective block as
`block ?? blockToCreate ?? blockToAdjust`, so a route step whose draft now
exists becomes a normal blocked step for `stage_run` without a plan revision.
The `stage.plan` completion applies `stagePlanDecisionIssues` and refuses a
route step that names none of the four, with one issue per offending step; the
rule sits in that pure function rather than in the `stageTestPlan` *decoder*
because a plan persisted before this tier still has to decode and resume, and a
decoder-level `Schema.filter` would fail it on load instead of on submission.
`stage.plan-review` shows the intents beside the block display, and the engine
enforces the same rules at `stage.plan` completion (`stagePlanBlockIssues`) from
the registry facts the run executes against: a `write`/`destructive` block needs
the plan's `createsData`, a `destructive` block is refused outright, and a block
whose `app` or `roles` the pinned stage does not declare is refused. The gate
lives in the step's completion handler rather than in the pure plan decoder, so
the reviewed plan and the plan the executor will accept are the same plan.

`StageTestReportSchema` gains:

```jsonc
"blocksUsed":    [{ "routeStepId", "block", "version" }]
"blocksCreated": [{ "block", "version", "routeStepId"? }]
"blocksAdjusted":[{ "block", "version", "routeStepId"? }]
"unblockedSteps":[{ "routeStepId", "reason" }]
```

The report carries the **claims only**; no `status`, no `proof` and no
`fromVersion` is part of it. The proof belongs to the store, not to the agent's
own handoff: `stage_run` appends it to the draft when the block actually ran
(one `appendStageBlockProof` per step, with the journal and evidence ids it
produced), and `stageReportBlockIssues` plus `stage.report.render` read it back
from the drafts at handoff and at render time. That is what makes D6's "the
render effect reads the drafts and the previous version itself" true, and it is
deliberate: a proof field in the report would be a claim the agent writes about
itself, which is exactly what this gate exists to avoid. The earlier draft of
this section listed a `proof` object (D5) and contradicted D6; the field names
here and in `workflow/schema.ts` (`block`, not `id`) are the ones the
implementation and the role instructions use.

Validation (in `stage-test.ts`'s `validReport` plus the `stage.report.render`
effect, which re-checks against the store):

- every approved-plan route step with no `block` on the plan must appear in
  `unblockedSteps` with a non-empty reason (`stage-block-unblocked-unexplained`);
- every `unblockedSteps` entry names a real route step;
- every `blocksCreated`/`blocksAdjusted` entry corresponds to a draft of this
  workflow at the claimed version **and digest** with a `passed` proof of that
  same version and digest, and a passed report never claims a block whose proof
  failed (`stage-block-proof-missing`);
- every `blocksUsed` entry names the plan's own block for that route step.

*Why still `@1`:* the same additive pattern the flow fields used — every field
is optional in the schema, and only the new cross-field rule is new. The
tightening is deliberate and marked **BREAKING** in the proposal: a route step
that says nothing is exactly the behaviour this change removes.

### D6. Review diff and promotion at the existing gate

- The report renderer (`stageReportMarkdown`, called by the existing
  `stage.report.render` effect) gains a bounded **Blocks** section: per
  created/adjusted block, its id/version/action, the postcondition, the
  operation list (for an adjustment: a unified line diff of `operations` against
  the version currently in the shared store, or against the checked-in
  definition when one exists), and the recorded proof. The render effect reads
  the drafts and the previous version itself, so no payload or snapshot field
  grows and the review gate keeps showing one markdown report exactly as today.
- `reportActions` labels the approval `Approve report and promote N block(s)`
  when the report lists created/adjusted blocks; the action id stays
  `approve-review` so the dashboard's shared review popup is unchanged.
- Promotion is a new durable effect kind `stage.blocks.promote`, enqueued as an
  **edge effect** on the two approval edges that leave `stage.review`
  (`approve` → `core.completed`, `approve-and-update-wiki` → `core.wiki`),
  exactly like `wiki.verify` on the wiki-approval edge. The runner reads the
  workflow's drafts, re-validates each document, writes the approved files
  atomically, keeps the previous bytes for rollback, and removes the promoted
  drafts last; a validation failure is a permanent failure with a bounded
  message and leaves every draft in place. Only the ids the report claims are
  published, and the effect's `observe` reports the already-published set when a
  re-run finds the drafts already removed by its own earlier attempt.
- `comments` (request follow-up) returns to `stage.execute` and keeps the drafts,
  which is what the tester needs to continue. Drafts live under the workflow id
  and are removed when that workflow's workspace is closed/cleaned, so an
  unapproved draft never becomes visible to another run, flow or planner.
- Adding the effect changes the stage-test definition version discriminator
  (the family's definition-version helper), so an already-pinned in-flight
  stage-test workflow keeps its old definition and completes without promotion.

*Why an edge effect and not a step behaviour hook:* the engine already enqueues
durable work on a transition (`enqueueEdgeEffects`), the payload can be empty
because the effect resolves the workflow's own drafts, and a developer step has
no completion handler of its own.

### D7. Flows and replay for data blocks

- A generated flow uses a sidecar per data block:
  `stage-flows/<flowId>/blocks/<blockId>.json` (the document as approved), and
  the spec calls `await stage.runData("<routeStepId>", { ...args })`. There is
  no barrel import, no `exportName` and no stage-app-key collision, because the
  spec never imports a block for a data step.
- The fixture's `runData` resolves the document from the flow manifest's own
  `blockFiles: { [id]: "blocks/<id>.json" }`, validates and interprets it with
  the same interpreter, and refuses (`flow-block-drift`) when the document's
  digest or version no longer matches `blockDigests`/`blockVersions`. The
  postcondition, sub-steps, captures, journal events and result shape are
  identical to `stage.run`.
- `flowManifestIssues` gains the flow directory so it can read and validate the
  sidecar; a missing/invalid sidecar is `flow-block-document-missing`, a
  changed document is the existing `flow-block-digest`. `blockKinds` is not
  needed: a checked-in→data swap changes the digest.
- Flow generation refuses a draft (`flow-block-draft`): a flow may only pin a
  promoted block, because review approval is what makes it shared.
- `scripts/check-stage-flows.ts` validates each sidecar document and its pinned
  digest with no browser, exactly as it validates a checked-in flow today.

### D8. `type` on the locator surface

`BlockLocator.type(value: string, options?: { delayMs?: number })`:

- server session facade: `BrowserSession.type(target, value, delayMs, timeoutMs)`
  → driver `pressSequentially`; the value bound is 2000 chars and the delay is
  clamped to 0–1000 ms, both refused (not silently truncated) outside;
- replay fixture: `locator.pressSequentially(value, { delay })`;
- data blocks: the `type` operation, as defined in D1.

Both adapters keep `fill` unchanged: `fill` sets a value, `type` presses keys,
and only the latter opens keystroke-driven suggestion widgets.

### D9. Honest replay failure

- The generated replay config sets `use.actionTimeout: 15_000` (with
  `expect.timeout` already 15 s), so a hung action fails the test instead of
  running into the process bound.
- The fixture tracks the currently open sub-step outside the `use()` scope and,
  at teardown, writes `status: "failed"` with a synthesised failed event and a
  `error` naming the route step, block and sub-step whenever
  `testInfo.timedOut === true` or `testInfo.status !== "passed"` while no event
  failed. A timeout therefore produces a failed `stage-run.json`, never a passed
  one.
- `decodeReplayResult` keeps the identity refusal, and replaces the
  `replay-result-invalid: ... reported a pass` refusal with the same honest
  mapping: a non-zero exit whose result claims a pass is returned as a failed
  result whose `error` names the last recorded step/sub-step (or says no failure
  was reported). The heal packet and the report mapping therefore see a failed
  step instead of a contract error.

### D10. Instruction and prompt changes

`agent-definitions/instructions/stage-test-plan.md` gains the blocks-first rule
(each route step names a block, a block to create, or a block to adjust; only an
extreme edge case takes `noBlockReason`), and
`stage-test-execute.md` gains the authoring loop (explore to find the approach,
then `stage_block_save` + `stage_run` to prove it, then report the proof; the
run's exploratory fallback needs a recorded reason). Nothing else is added:
these are the two instructions the change needs, and both families stay within
`PROMPT_BUDGETS` (a single number may be raised in `prompt-inventory.ts` with a
one-line reason if a role's measured assignment exceeds its ceiling). The assets
are embedded, so `bun run scripts/generate-embedded.ts` regenerates
`src/workflow/embedded.generated.ts`.

## Risks / Trade-offs

- [The blocks-first plan rule invalidates an in-flight approved plan] → the
  stage-test family is single-run and short-lived; the refusal names the route
  step and the four accepted fields, so the tester can be re-run. Recorded here
  and in the proposal as the one deliberate **BREAKING** tightening.
- [A new effect kind plus a definition-version bump strands a pinned in-flight
  stage-test workflow at `core.completed`] → the workflow still completes; only
  the promotion is skipped, and the run's report already shows the blocks for a
  later manual promotion. The alternative (mutating the definition digest in
  place) would strand every in-flight workflow of the family, which is worse.
- [A data document is code-adjacent data driven by a model] → the operations are
  a closed union with no expressions, the document is validated before storage
  and again at promotion, the stage policy is applied by the unchanged plan
  validation, and the origin guard stays in `SessionBlockPage`. Tests cover a
  document with an unknown `op`, an embedded script field and an off-app path.
- [Composing the registry per request adds file reads to hot tools] → bounded by
  200 documents ≤ 64 KiB and a few dozen files in practice; no cache is added
  now, and a mtime-keyed memo can be added behind the same function later.
- [A draft could leak into another run's catalog or a flow] → drafts are stored
  per workflow id, composed only when `draftsWorkflowId` matches, refused by
  flow generation (`flow-block-draft`), and removed on workspace close.
- [Data blocks have no contract test, so the checked-in gate no longer proves
  behaviour] → their contract is the validated examples plus the recorded live
  proof, and promotion requires a `passed` proof from this run; the checked-in
  gate semantics for checked-in blocks are untouched.
- [`actionTimeout: 15s` may cut off a legitimately slow action] → a block that
  needs longer uses `expect*` polling, `wait { ms }` or `waitFor` with its own
  bound; the heal packet names the failing sub-step so the fix is visible.
- [The review markdown grows] → the Blocks section is bounded (≤ 8 blocks,
  ≤ 60 diff lines each) and the report render already truncates at 500k chars.
- [`type` is a new mandatory driver method] → it is added to
  `DriverPage`, `playwright-driver.ts` and `fake-driver.ts` in the same change,
  so the type check fails if an implementation is missed.

## Migration Plan

1. Land the data format, interpreter, store and registry composition behind the
   existing tools (no behaviour change for a stage with no data blocks).
2. Land `type` in both adapters and the replay action-timeout mapping (pure
   additions to existing contracts).
3. Land `stage_block_save`, the draft proof recording and the catalog's
   `kind`/`status`.
4. Land the plan/report fields and their validation, then the instruction
   edits + regenerated embedded assets.
5. Land flows/replay for data blocks, then the review diff + promotion effect
   and the stage-test definition-version bump.
6. Rollback: every step is additive. The only irreversible writes are approved
   files under `<configDir>/stages/blocks/`; deleting them restores the previous
   behaviour exactly, and a promotion that fails rolls back its own writes from
   the bytes it kept. No store or database schema changes.

## Open Questions

- Should the operation set later gain an `api` operation (`ctx.api`) so
  API-first routes can be authored as data too? Out of scope here (the closed
  surface is browser work); the answer decides whether a future change extends
  this document format or adds a sibling one.
- Is the per-run draft directory the right lifetime, or should an abandoned
  run's drafts be visible to the next run of the same stage as a starting point?
  This design keeps them private and removes them at workspace close, because
  the review gate — not a later run — is where an unapproved block may return.
