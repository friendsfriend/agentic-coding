# stage-flow-blocks Specification

## Purpose
TBD - created by archiving change add-stage-flow-blocks. Update Purpose after archive.
## Requirements
### Requirement: Block definitions are typed and versioned
The system SHALL provide two interchangeable ways to define a block: the
`defineBlock` API, whose TypeScript definition declares a stable block id, a
semantic version, a title, a description, an application scope, a parameter
schema, a return schema, an effect set, an idempotency flag, optional
`requires`/`provides` state tags, at least one example, a contract test and a
`run(ctx, args)` implementation; and a declarative data document (`format: 1`)
that declares the same identity and contract fields, at least one example, a
postcondition and a closed operation list instead of an implementation. The
build SHALL reject a checked-in definition with a missing or malformed field, a
duplicate id, an example that does not validate against the parameter schema, or
a `run` that is not a function. Validation of a data document SHALL reject a
missing or malformed field, an example that does not validate against the
parameter schema, an unknown operation or field, and an out-of-bound document.
Both forms SHALL compile to the same frozen block definition so that plan
validation, execution, the catalog, flow generation and replay treat them alike.

#### Scenario: A valid block is registered
- **WHEN** a TypeScript module exports `defineBlock` with `id: "crm.customer.fillAddress"`, version `1.0.0`, a parameter schema, a return schema, effect `write`, and an example
- **THEN** the build SHALL include the block in the generated catalog and the runtime registry

#### Scenario: A malformed block fails the build
- **WHEN** a block definition omits its parameter schema or declares the same id as another block
- **THEN** the build SHALL fail with the offending module and field, and no catalog SHALL be produced

#### Scenario: A data document is validated the same way
- **WHEN** a data document omits its return schema or contains an example that does not validate against its parameter schema
- **THEN** validation SHALL reject it with a path-addressed issue and the document SHALL not be stored or executed

#### Scenario: Both forms share one definition contract
- **WHEN** a checked-in block and a data block are listed by the runner
- **THEN** both SHALL expose the same metadata fields and SHALL resolve through the same registry interface

### Requirement: Blocks declare scope, effects and state
Every block SHALL declare an application scope of one application key or `*`, an effect set drawn from `read`, `write` and `destructive`, and whether it is idempotent. A block MAY declare `requires` and `provides` state tags. The runner SHALL refuse a block whose application scope is not one of the pinned stage's declared applications, SHALL refuse a write or destructive block on a read-only stage, and SHALL refuse a plan in which a `provides` tag conflicts with an earlier step's `provides` tag.

#### Scenario: Wrong application
- **WHEN** a plan for a stage whose applications are `crm` and `billing` names a block scoped to `warehouse`
- **THEN** validation SHALL fail with `block-app-not-allowed` before a browser is opened

#### Scenario: Write on a read-only stage
- **WHEN** a plan names a block with effect `write` on a stage whose access is read-only
- **THEN** validation SHALL fail with `stage-read-only`

### Requirement: The catalog is generated from block definitions
The build SHALL generate the agent-facing catalog from the public checked-in
block definitions. The catalog SHALL contain, for each checked-in block, the id,
version, application scope, title, description, parameter and return JSON
schemas, effects, idempotency, state tags and examples. The catalog SHALL NOT be
hand-edited and SHALL NOT contain block source code or secret values. The
runtime catalog a tool reads SHALL additionally include the approved data blocks
and, for the authoring run only, its drafts; each entry SHALL name its block kind
(`checked-in` or `data`) and a data block SHALL be marked as a draft when it is
not yet promoted. A data entry SHALL carry its postcondition and SHALL NOT carry
its operation list unless the full-entry projection is requested.

#### Scenario: Catalog matches the source
- **WHEN** a public block is added, renamed or given a new version
- **THEN** the generated catalog SHALL change in the same build and a stale hand-written entry SHALL be reported as an error

#### Scenario: Catalog filtering
- **WHEN** an agent asks for blocks for a stage whose applications are `crm` and `billing`
- **THEN** the result SHALL omit blocks scoped only to `warehouse`

#### Scenario: Catalog names the block kind
- **WHEN** an agent lists blocks of a stage that has both checked-in and approved data blocks
- **THEN** every entry SHALL name its kind and no entry SHALL contain block source code

#### Scenario: A draft is marked
- **WHEN** the authoring run lists the catalog after saving a draft
- **THEN** the draft SHALL appear with the draft status and another run's listing SHALL NOT contain it

### Requirement: Blocks execute against the stage context
A block SHALL receive a `StageContext` containing the allow-listed page facade, assertions, `step`, `capture`, `secret`, run metadata, application and role. A block SHALL NOT receive a raw browser context, a raw Playwright `Page` that bypasses the facade, or direct access to stage credentials. The context SHALL apply the same origin, read-only, session and credential restrictions as the existing stage browser tools. The page facade SHALL offer `fill` to set a value and `type(value, { delayMs })` to press keys one at a time through the same allow-listed driver, because a widget that only reacts to real keystrokes cannot be driven with `fill`. The typed value SHALL be bounded to 2000 characters and the delay to 0–1000 milliseconds, and an out-of-bound value SHALL be refused rather than truncated.

#### Scenario: Block uses the context
- **WHEN** a block calls `ctx.step("save address", ...)` and drives `ctx.page`
- **THEN** the sub-step and the browser actions SHALL be subject to the stage's normal origin and access policy

#### Scenario: Block attempts a forbidden origin
- **WHEN** a block navigates `ctx.page` to an origin outside the stage allow-list
- **THEN** the action SHALL fail with the existing origin refusal and the plan SHALL stop at that block

#### Scenario: Typed input opens a suggestion widget
- **WHEN** a block calls `ctx.page.getByTestId("addressPage__search").type("10115", { delayMs: 60 })`
- **THEN** the block SHALL press the keys through the allow-listed driver and the suggestion list SHALL open

#### Scenario: Type out of bounds
- **WHEN** a block asks `type` for a value longer than 2000 characters or a delay above 1000 milliseconds
- **THEN** the call SHALL be refused before any key is pressed

### Requirement: Public blocks require contract tests
A public checked-in block SHALL have a contract test that reaches the block's required page state, runs the block, asserts the declared postcondition, validates the return schema and, where applicable, checks that the persisted UI state survived a reload. The build or CI SHALL fail when a public checked-in block has no contract test, no example, or no consumer smoke test that chains it with at least one other block. A data block SHALL instead carry at least one validated example and a postcondition, and SHALL be promotable only with a recorded execution proof from the run that authored it.

#### Scenario: Missing contract test
- **WHEN** a public checked-in block is added to the catalog without a contract test
- **THEN** the block check SHALL fail and the catalog SHALL not be publishable

#### Scenario: Contract test asserts the postcondition
- **WHEN** the `fillCustomerAddress` contract test runs
- **THEN** it SHALL assert the saved address is visible after saving and that the returned output matches the declared schema

#### Scenario: Data block requires a passing proof
- **WHEN** a data block was saved but never executed successfully in its run
- **THEN** it SHALL NOT be promotable and the report SHALL NOT claim it as created

### Requirement: Block changes preserve or version their contract
A change to a block's parameter schema, return schema, application scope, effect set or required state SHALL be treated as a contract change. A breaking change SHALL increment the block's major version and update all consumers; a compatible change SHALL increment the minor or patch version. The runner SHALL record the resolved version for every executed block, and a plan referring to an unregistered id or version SHALL be refused. A deprecated block SHALL name a replacement or a removal date in the catalog.

#### Scenario: Breaking change without a version bump
- **WHEN** a block makes a required parameter optional-to-required or changes an output field without a major version increase
- **THEN** the contract check SHALL fail

#### Scenario: Executed version is recorded
- **WHEN** a plan runs `crm.customer.fillAddress@1.2.0`
- **THEN** the result and journal SHALL name version `1.2.0`, not only the block id

### Requirement: Block credentials are resolved through the context
A block parameter SHALL NOT be used to pass a credential. A block that needs a credential SHALL resolve it through `ctx.secret(name)`, and the runner SHALL redact argument values, return values and sub-step text before writing the catalog, journal, logs or evidence manifest. A missing secret SHALL fail the block with `secret-missing` before the browser action that needs it.

#### Scenario: Secret is redacted
- **WHEN** a block resolves a password through `ctx.secret("clerkPassword")` and records a sub-step
- **THEN** the journal and tool result SHALL contain a redaction marker rather than the password

#### Scenario: Missing secret
- **WHEN** a block requests a secret that the stage does not provide
- **THEN** the block SHALL fail with `secret-missing` and SHALL NOT perform the dependent browser action

### Requirement: Blocks are promoted, not published at runtime
The stage-tester MAY author a block during its own run, but SHALL only write a
draft scoped to that run. A draft SHALL NOT enter the shared catalog, SHALL NOT
be pinnable by a flow and SHALL NOT be visible to another run. A block SHALL
enter the approved catalog only through the review gate's promotion of the
run's drafts, and a checked-in block SHALL never be modified by a runtime
authoring call. An ad-hoc `browser_run_script` flow SHALL remain a script and
SHALL NOT be treated as a catalogued block until it has been promoted.

#### Scenario: Tester authors a block
- **WHEN** the stage-tester saves a valid document during `stage.execute`
- **THEN** the block SHALL exist as a draft of that run only and SHALL be executable by that run

#### Scenario: Runtime publish outside review is refused
- **WHEN** any agent other than the stage-tester, or the tester outside `stage.execute`, attempts to save a block
- **THEN** the call SHALL be refused and no draft SHALL be written

#### Scenario: Promotion is the only shared path
- **WHEN** a draft is not approved at review
- **THEN** it SHALL NOT appear in the approved store, the shared catalog or any flow

