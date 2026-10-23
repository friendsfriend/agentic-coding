# Compiled stage flow replay

The stage tester explores and tests in `stage.execute`. A saved flow is a
reusable deterministic tool, not a workflow step or an approved test plan.
The tester chooses a flow and inputs, reads its ledger, and authors its own
`core.stage-report@1` using the journal and evidence it produced.

## Identity, generation and parameterization

A flow lives under `stage-flows/<flowId>/`:

- `flow.spec.ts` — generated, readable `@playwright/test` code. Change the
  source blocks or standalone block plan and regenerate, not this file.
- `flow.json` — stage, applications/roles, input schema and examples,
  route/spec hashes, block versions/digests and step mapping.
- `blocks/<id>.json` — pinned documents for data blocks (when used).

`stage_run({plan, save:true})` generates a flow from a successful standalone
plan `{planId?, flowId, inputs?, steps}`. Each step names a block and its own
`args`; there is no approved-route projection or second argument source.
`flowSourceFromPlan` derives application/role metadata from the resolved blocks
and carries an empty expectation mapping. Expectation ownership stays with the
tester's report.

`{{ inputs.<name> }}` becomes `stage.input<T>("name")` and a property of the
flow's input schema. `{{ steps.<id>.outputs.<name> }}` becomes a reference to
that earlier step's typed output. Input values are examples in the manifest,
not literals in the spec: different values reuse byte-identical code and
route/spec hashes, with a different `inputsHash`. Input bindings must be whole
strings, not fragments embedded in longer strings.

Generation refuses missing flow identity, unresolved bindings, secret literals,
unregistered digests, internal blocks and unapproved drafts. It formats and
type-checks the generated spec before writing it. Reusing a flow id with a
different route is refused with `flow-route-changed`; choose a new flow id.

## Manifest-scoped eligibility

`flowEligibility` compares the saved flow with the current registry and stage,
never with an approved workflow plan. It validates:

- the spec hash (`flow-spec-drift` for hand edits);
- registered block versions/digests and pinned data documents;
- stage and declared application/role scopes;
- supplied values against the manifest's own `inputSchema` (required fields,
  types and undeclared inputs);
- absence of this run's unapproved draft blocks.

A data block has no module import. Its spec calls `stage.runData`, and
`pinnedDataBlock` reads the sidecar named by `blockFiles`, validates the
JSON document, compares its digest and compiles it. Missing documents are
`flow-block-document-missing`; invalid or changed documents are
`flow-block-digest`. A draft is executable only within its authoring run,
not by a saved flow (`flow-block-draft`). `bun run stage-flows:check` applies
the same sidecar checks without a browser.

## Calling replay

Use `stage_flows` to discover flows, then:

```text
stage_replay({flowId, inputs?, dryRun?, role?})
```

The stage defaults to the workflow's pinned stage and may not differ from it.
Omitting `inputs` selects the flow's first recorded example, or `{}` when it
has none. Both dry-run and execution answers state the values selected.
`dryRun:true` validates eligibility and inputs without opening a browser.
Execution refuses schema-invalid inputs, not inputs that lack approval: there
is no `approvedRevision`, `flow-inputs-unapproved` or plan-id equality gate.

Replay launches a separate Playwright process with stage URLs, credential
variable names, a bounded run-input file, the workflow revision and a
short-lived run token. The file is removed after exit. The process environment
drops unrelated configured secrets and host/run/workflow tokens. A block may
resolve only the stage's declared secret-variable names; inputs are test data,
never credentials.

The server validates and redacts bounded result events, allocates journal
sequence numbers (`source:"replay"`) and ingests evidence. The response contains
steps, journal/evidence ids, outputs and a heal packet on failure. It never
maps replay to a workflow report: the tester decides what those observations
establish and cites them in its report. A failed replay remains a tool result
inside the same tester run. The tester can explore, correct an own draft, or
record a failed/blocked verdict; there is no automatic spec repair or promotion.

Trace defaults to `retain-on-failure`; video is opt-in (`STAGE_REPLAY_VIDEO=1`).
The fixture's `actionTimeout` is 15 seconds and the process has a bounded total
budget. A nonzero process exit after a reported pass is still a failure, with
the stderr tail attributed to the first non-passed (otherwise last) step.
API-first blocks use the same declared app/role, relative-path, method, size,
origin and stage-access rules as `stage_api_request`.

## Suites and standalone CI

`stage-flows/<suiteId>.suite.json` holds independent flow entries:

```json
{
  "version": 1,
  "suiteId": "crm-smoke",
  "parallel": true,
  "stopOnFailure": false,
  "flows": [
    {"id": "address", "flowId": "customer-address", "inputs": {"customerId": "C-1001"}},
    {"id": "search", "flowId": "customer-search", "inputs": {"path": "/search?q=acme"}}
  ]
}
```

`stage_replay({suiteId})` sends every entry through the same manifest/input
eligibility and execution path. Concurrency is bounded by browser limits and
a fixed ceiling. Parallel suites refuse `sharedData`, `sequence` and
`dependsOn`; serial dependencies must name earlier entries. `stopOnFailure`
stops scheduling after a failed or refused entry and marks the remainder
skipped. The aggregate ledger records passed/failed/refused/skipped status and
evidence per entry, never a workflow report.

For CI, use `bun run scripts/stage-flow-run.ts --flow <flowId> --stage <stage>
--inputs <file.json>` (or `--suite <suiteId>`). It resolves the configured stage,
validates inputs and uses the same launcher without a workflow. Invalid schemas,
nonzero exits, invalid results and failed/refused entries exit nonzero.
`bun run stage-flows:check` (also in the build) validates checked-in flow and
suite manifests, sidecars and suite input schemas without opening a browser.

The checked-in pilots are `customer-address`, `customer-search` and
`crm-smoke.suite.json`.

## Pinned historical workflows and deployment

New starts use the exploration definition tier (`rounds + 1200`) without
`stage.plan`, `stage.plan-review` or `stage.replay`. Historical definitions and
their step contracts, behaviors, metadata readers and dashboard actions remain
registered so running workflows keep resolving their pinned graph/digest. A
historical replay without a usable report falls back to its tester step rather
than inventing a report from a result ledger.

After deployment, regenerate the embedded assets (`bun run
scripts/generate-embedded.ts`), perform the normal build and restart. No store
migration or schema-version bump is needed, and running workflows are not
re-pinned.
