## ADDED Requirements

### Requirement: Durable codemode uses the native extension within the run's policy
The durable host SHALL use `createCodemodeExtension` from `@earendil-works/pi-durable/codemode` as its codemode execution implementation. The host SHALL register it only where the user's global Pi settings enable `codemode`, and SHALL keep it excluded from orchestrator sessions. Native discovery and nested execution SHALL be limited to tools actually offered to and authorized for the current run; direct tools SHALL remain available as before, and a read-only run SHALL NOT discover or execute `write` or `edit` through codemode. The host SHALL use the extension's durable nested-call APIs and SHALL NOT retain a parallel custom sandbox or nested-call executor. It SHALL preserve bounded script output, live progress, nested-call errors, cancellation, and safe sandbox shutdown. The implementation SHALL verify and document the upstream nested-call recovery/replay contract and `store`/`load` lifetime and commit semantics; persisted values SHALL at minimum remain isolated by durable conversation, and no legacy process-local map SHALL be described as crash-persistent.

#### Scenario: User-local enablement and host exclusions
- **WHEN** a durable coding host starts with the user's global Pi settings enabling `codemode`
- **THEN** supported non-orchestrator host modes SHALL register the native codemode extension
- **AND** direct tools SHALL remain offered
- **AND** an orchestrator session SHALL NOT register codemode
- **AND** when the user setting does not enable codemode the host SHALL NOT register it

#### Scenario: Offered tool discovery is run-specific
- **WHEN** a codemode script requests the callable tool catalog for a run
- **THEN** it SHALL see only the tools offered to and authorized for that run, using the native extension's supported discovery namespace
- **AND** it SHALL NOT discover or execute a tool merely because that tool exists in another run or host surface

#### Scenario: Read-only run cannot mutate through codemode
- **WHEN** a read-only run invokes codemode and attempts to discover or execute `write` or `edit`
- **THEN** those tools SHALL be absent from its callable catalog and execution SHALL be refused without mutating files

#### Scenario: Native nested-call failure and cancellation
- **WHEN** a nested tool call fails or a running codemode invocation is cancelled
- **THEN** the script result SHALL report the nested failure or cancellation rather than false success
- **AND** cancellation SHALL propagate to outstanding nested calls and sandbox work
- **AND** host shutdown SHALL leave no codemode worker or task running

#### Scenario: Bounded output and visible progress
- **WHEN** a script emits output and performs a nested tool call with progress
- **THEN** bounded output and live progress SHALL reach the durable host through its normal result/progress path
- **AND** the final result SHALL retain the script result and nested-call outcome without duplicating streamed output

#### Scenario: Nested calls recover according to the native journal
- **WHEN** the host is interrupted during a codemode nested call and resumes its durable conversation
- **THEN** nested-call recovery SHALL follow the documented native replay policy and SHALL NOT be reimplemented by a parallel custom executor
- **AND** focused regression tests and migration documentation SHALL state which calls replay and which return an interrupted or failed result

#### Scenario: Store and load retain their documented native scope
- **WHEN** scripts store and load JSON values across codemode calls
- **THEN** the host SHALL use the native extension's documented commit and lifetime behavior
- **AND** values SHALL be scoped to their durable conversation rather than shared with another conversation
- **AND** migration documentation SHALL identify any intentional change from the former process-local, success-committed store behavior
