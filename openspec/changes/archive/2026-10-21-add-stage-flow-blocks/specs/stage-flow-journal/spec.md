## ADDED Requirements

### Requirement: Plan runner writes journal entries without a model call
`stage_run` SHALL append one `stage-journal.jsonl` entry for each `ctx.step` event emitted by an executing block, in event order, without requiring the agent to call `stage_step` for that event. Each entry SHALL use the same sequence, server time, session, application, role, sanitized URL, label, expected, observed, captures, evidence ids and knowledge-observation rules as `stage_step`, and SHALL additionally name the plan id, route step id when present, block id, block version and sub-step label. Every entry SHALL pass through the shared redactor before it is written. A referenced evidence id that does not exist SHALL be refused. A block that completes without emitting at least one sub-step SHALL be recorded as a block contract violation.

#### Scenario: Block sub-steps are recorded
- **WHEN** `fillCustomerAddress` emits `ctx.step("fill street")` and `ctx.step("save address")`
- **THEN** the journal SHALL gain two entries in that order with the block id and version and no separate `stage_step` call

#### Scenario: Block emits no sub-step
- **WHEN** a block returns successfully without calling `ctx.step`
- **THEN** the runner SHALL record a contract violation for that block and SHALL NOT silently accept the step as journalled

### Requirement: Block sub-steps retain plan order and identity
A runner-written journal entry SHALL carry the plan's step index, the route step id when the plan came from a stage plan, the block id and version, and the sub-step label. Entries from one block SHALL appear consecutively and in the order the block emitted them. `stage_journal` SHALL return these fields beside the existing entry fields so the report can reconstruct the block-backed timeline and attribute a failure to one sub-step.

#### Scenario: Timeline reconstruction
- **WHEN** an agent reads back the journal for a plan with three blocks
- **THEN** the entries SHALL show the three plan steps in order and each block's sub-steps consecutively beneath it

#### Scenario: Failure attribution
- **WHEN** the second sub-step of the second block fails
- **THEN** the journal entry SHALL identify plan step 2, the block id and version, and the second sub-step

### Requirement: Block failure evidence is scoped and bounded
On a block failure, the runner SHALL store a screenshot and a scoped snapshot of the failing region as evidence, together with a bounded console tail and a bounded network tail. It SHALL NOT store a full-page DOM snapshot on failure. The screenshot SHALL count against the stage's per-workflow `limits.maxScreenshots`; a failure beyond that limit SHALL be recorded with the available evidence and the refusal reason rather than bypassing the limit. The failure result and journal entry SHALL name the evidence ids and captions.

#### Scenario: Failure captures the failing region
- **WHEN** a block fails on a validation message inside a form
- **THEN** the journal entry SHALL reference a screenshot and a scoped snapshot containing the form region, plus the console and network tails

#### Scenario: Screenshot limit
- **WHEN** a workflow has already stored `maxScreenshots` screenshots and a block fails
- **THEN** the runner SHALL record the failure with the remaining evidence types and SHALL note that the screenshot was refused by the stage limit
