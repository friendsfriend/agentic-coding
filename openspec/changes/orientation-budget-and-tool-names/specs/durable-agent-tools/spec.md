## ADDED Requirements

### Requirement: Tool descriptions state the inspection default and the batching rule

The `read`, `grep` and `bash` tool descriptions SHALL each state that tool's part
in the split the agent works with, and the `codemode` description SHALL state
its own: `read` (with
`offset`/`limit`) and `grep` (with a `path` filter) are the default way to inspect
code, `bash` is for builds, tests and `openspec`, and `codemode` chains a search →
filter → summarise pipeline into one turn. The `read`, `grep` and `bash`
descriptions SHALL repeat the batching rule there — independent calls are emitted
in one message rather than one call per turn — rather than leaving it only in the
protocol document. A description SHALL name a tool only when the run's tool set
contains it: the host SHALL resolve whether the run's global agent settings
register `codemode` and SHALL pass that to the description builders, so a run
without `codemode` is not told about it. Every contract these descriptions
already carry SHALL be preserved: the `bash` bound, its ceiling and the override,
the elapsed-time note; `grep`'s refusal of an absolute or escaping path, its line
bound and its platform-grep fallback; `read`'s off-target refusal.

#### Scenario: The inspection default is stated where the tool is chosen

- **WHEN** a durable run is offered `read`, `grep` and `bash`
- **THEN** each of their descriptions SHALL state that `read` and `grep` are the default way to inspect code and that `bash` is for builds, tests and `openspec`

#### Scenario: The batching rule is repeated in the tool descriptions

- **WHEN** a durable run reads the description of `read`, `grep` or `bash`
- **THEN** it SHALL state that independent calls are emitted in one message rather than one call per turn

#### Scenario: `codemode` is described only where it is registered

- **WHEN** the run's global agent settings register `codemode`
- **THEN** the `read`, `grep` and `bash` descriptions SHALL name it as the tool that chains a search → filter → summarise pipeline into one turn
- **AND** when they do not, those descriptions SHALL NOT mention it

#### Scenario: The existing bounds survive the rewrite

- **WHEN** the `bash` description is rendered
- **THEN** it SHALL still state the 120-second default bound, the 3600-second ceiling and the caller's override
- **AND** the `grep` description SHALL still state its line bound and its platform-grep fallback
