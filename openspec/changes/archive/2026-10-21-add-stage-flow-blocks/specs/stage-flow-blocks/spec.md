## ADDED Requirements

### Requirement: Block definitions are typed and versioned
The system SHALL provide a `defineBlock` API whose definition declares a stable block id, a semantic version, a title, a description, an application scope, a parameter schema, a return schema, an effect set, an idempotency flag, optional `requires`/`provides` state tags, at least one example, and a `run(ctx, args)` implementation. The build SHALL reject a definition with a missing or malformed field, a duplicate id, an example that does not validate against the parameter schema, or a `run` that is not a function.

#### Scenario: A valid block is registered
- **WHEN** a TypeScript module exports `defineBlock` with `id: "crm.customer.fillAddress"`, version `1.0.0`, a parameter schema, a return schema, effect `write`, and an example
- **THEN** the build SHALL include the block in the generated catalog and the runtime registry

#### Scenario: A malformed block fails the build
- **WHEN** a block definition omits its parameter schema or declares the same id as another block
- **THEN** the build SHALL fail with the offending module and field, and no catalog SHALL be produced

### Requirement: Blocks declare scope, effects and state
Every block SHALL declare an application scope of one application key or `*`, an effect set drawn from `read`, `write` and `destructive`, and whether it is idempotent. A block MAY declare `requires` and `provides` state tags. The runner SHALL refuse a block whose application scope is not one of the pinned stage's declared applications, SHALL refuse a write or destructive block on a read-only stage, and SHALL refuse a plan in which a `provides` tag conflicts with an earlier step's `provides` tag.

#### Scenario: Wrong application
- **WHEN** a plan for a stage whose applications are `crm` and `billing` names a block scoped to `warehouse`
- **THEN** validation SHALL fail with `block-app-not-allowed` before a browser is opened

#### Scenario: Write on a read-only stage
- **WHEN** a plan names a block with effect `write` on a stage whose access is read-only
- **THEN** validation SHALL fail with `stage-read-only`

### Requirement: The catalog is generated from block definitions
The build SHALL generate the agent-facing catalog from the public block definitions. The catalog SHALL contain, for each block, the id, version, application scope, title, description, parameter and return JSON schemas, effects, idempotency, state tags and examples. The catalog SHALL NOT be hand-edited and SHALL NOT contain block source code or secret values.

#### Scenario: Catalog matches the source
- **WHEN** a public block is added, renamed or given a new version
- **THEN** the generated catalog SHALL change in the same build and a stale hand-written entry SHALL be reported as an error

#### Scenario: Catalog filtering
- **WHEN** an agent asks for blocks for a stage whose applications are `crm` and `billing`
- **THEN** the result SHALL omit blocks scoped only to `warehouse`

### Requirement: Blocks execute against the stage context
A block SHALL receive a `StageContext` containing the allow-listed page facade, assertions, `step`, `capture`, `secret`, run metadata, application and role. A block SHALL NOT receive a raw browser context, a raw Playwright `Page` that bypasses the facade, or direct access to stage credentials. The context SHALL apply the same origin, read-only, session and credential restrictions as the existing stage browser tools.

#### Scenario: Block uses the context
- **WHEN** a block calls `ctx.step("save address", ...)` and drives `ctx.page`
- **THEN** the sub-step and the browser actions SHALL be subject to the stage's normal origin and access policy

#### Scenario: Block attempts a forbidden origin
- **WHEN** a block navigates `ctx.page` to an origin outside the stage allow-list
- **THEN** the action SHALL fail with the existing origin refusal and the plan SHALL stop at that block

### Requirement: Public blocks require contract tests
A public block SHALL have a contract test that reaches the block's required page state, runs the block, asserts the declared postcondition, validates the return schema and, where applicable, checks that the persisted UI state survived a reload. The build or CI SHALL fail when a public block has no contract test, no example, or no consumer smoke test that chains it with at least one other block.

#### Scenario: Missing contract test
- **WHEN** a public block is added to the catalog without a contract test
- **THEN** the block check SHALL fail and the catalog SHALL not be publishable

#### Scenario: Contract test asserts the postcondition
- **WHEN** the `fillCustomerAddress` contract test runs
- **THEN** it SHALL assert the saved address is visible after saving and that the returned output matches the declared schema

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
An agent MAY propose a new block or a change to an existing block, but SHALL NOT add a block to the runtime catalog, publish a version, or mark a block public. A block SHALL enter the public catalog only through review and the contract-test gate. An ad-hoc `browser_run_script` flow SHALL remain a script and SHALL NOT be treated as a catalogued block until it has been promoted.

#### Scenario: Agent proposes a block
- **WHEN** an agent writes a candidate block and its contract test into the repository
- **THEN** the block SHALL remain outside the catalog until a review promotes it

#### Scenario: Runtime publish is refused
- **WHEN** an agent attempts to register a block through a stage tool
- **THEN** the call SHALL be refused because no runtime block-publishing tool exists
