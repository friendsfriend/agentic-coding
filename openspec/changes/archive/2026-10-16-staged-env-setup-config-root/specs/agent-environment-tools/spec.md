# agent-environment-tools Specification

## MODIFIED Requirements

### Requirement: Environment tools for every durable run

Every durable run, including read-only runs, SHALL be offered `env_list`, `env_start`, `env_status`, `env_stop`, `env_build`, `env_test` and `env_logs`, and these tools SHALL NOT be replayed after an interruption. A run launched outside the server process — by the CLI or by the TUI — SHALL receive the same capability through the server's discovery record as a run the server launched itself.

#### Scenario: Read-only verifier starts the app

- **WHEN** a read-only verifier run starts
- **THEN** its tool list SHALL contain the environment tools and SHALL NOT contain write or edit

#### Scenario: Run started by the CLI

- **WHEN** an `env-setup` workflow is started by the CLI against a running server
- **THEN** its author run SHALL have the environment tools registered and a call to `env_list` SHALL answer with that workflow's apps instead of "no agent environment capability"

## ADDED Requirements

### Requirement: Every environment tool resolves the owner's configuration view

`env_list`, `env_start`, `env_build`, `env_test` and `env_logs` SHALL resolve the definitions of the requesting owner's configuration view — a setup workflow's staged root when it has one, the live configuration otherwise — so a tool never acts on a different layout than the owner's other tools.

#### Scenario: env_build uses the staged build definition

- **WHEN** an `env-setup` run calls `env_build` for an app whose build definition it staged
- **THEN** the run SHALL execute the staged definition, not the live one

#### Scenario: Another owner is unaffected

- **WHEN** a run of a workflow with no staged root calls `env_build`
- **THEN** the live configuration SHALL be used exactly as before

### Requirement: env_list reports staged and default targets

`env_list` SHALL report the targets of the owner's configuration view, SHALL mark each target that resolved from a staged root, and SHALL mark the default target per app and action — or mark the action as having an ambiguous default instead of silently choosing one.

#### Scenario: Staged target is marked

- **WHEN** an `env-setup` run lists an app whose run and build targets were staged
- **THEN** those targets SHALL be marked as staged, and the target the tools would run by default SHALL be marked as the default

#### Scenario: Ambiguous default is reported

- **WHEN** an app declares two build targets for the same default profile
- **THEN** the listing SHALL mark the build action's default as ambiguous and SHALL name both targets
