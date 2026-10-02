## ADDED Requirements

### Requirement: Codemode for durable runs
When the user's global pi settings enable `codemode`, durable runs SHALL offer a `codemode` tool that can call only the tools offered to that run.

#### Scenario: Read-only run uses codemode
- **WHEN** a read-only durable run calls `codemode` with a script that invokes `write`
- **THEN** the call SHALL fail because `write` is not available to the script

#### Scenario: Codemode disabled globally
- **WHEN** the global pi settings do not enable `codemode`
- **THEN** durable runs SHALL NOT offer it
