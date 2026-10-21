## ADDED Requirements

### Requirement: Reproducible prompt inventory

The repository SHALL provide a prompt inventory that renders, for every registered agent step and role, the generation-1 assignment through the production renderer with the step's real output contract and empty run inputs, and reports per row the bytes and rough tokens (bytes / 4, rounded up) of each protocol section, each role instruction asset, each envelope part and the total. A script SHALL print the inventory as Markdown or JSON, SHALL be able to print one role's full static prompt, and SHALL be able to add the system-side blocks (preamble, context files, tool descriptions and parameter schemas by group, `codemode` section) measured from a durable host on in-memory storage. The script SHALL set a temporary `HOME`, `AGENTIC_CODING_CONFIG_DIR` and `PI_CODING_AGENT_DIR` before loading any module, and SHALL NOT read or write the developer's store or configuration.

#### Scenario: Inventory covers every agent role
- **WHEN** the inventory runs over the built-in registry
- **THEN** it SHALL contain one row per agent step and role, including every verifier role, every wiki role and the stage roles
- **AND** each row SHALL report protocol, role, envelope and total bytes with rough tokens

#### Scenario: Inventory is isolated from real configuration
- **WHEN** the inventory script runs on a developer machine
- **THEN** it SHALL resolve home, configuration and pi agent directories to fresh temporary directories
- **AND** SHALL leave the developer's store and configuration untouched

### Requirement: Per-family static prompt budgets

Every agent step and role SHALL belong to a prompt family with a byte budget for its static first assignment, and a test SHALL fail when a role's static assignment exceeds its family budget or when a registered agent step and role has no budget. The `codemode` system-prompt section for the full workflow tool set SHALL have its own budget.

#### Scenario: A brief grows past its budget
- **WHEN** an instruction asset or a protocol section grows so that a role's static first assignment exceeds its family budget
- **THEN** the budget test SHALL fail and name the step, role, measured bytes and budget

#### Scenario: A new role is registered without a budget
- **WHEN** a step or role is registered that the budget table does not cover
- **THEN** the budget test SHALL fail naming the uncovered step and role
