# stage-configuration Specification

## Purpose
TBD - created by archiving change add-stage-testing-foundation. Update Purpose after archive.
## Requirements
### Requirement: Stage definitions are global, file-authored configuration
The system SHALL read stage definitions only from `stages/definitions/<ident>.json` under the canonical configuration root and global stage policy only from `stages/policy.json` there. It SHALL NOT read stages from `config.json`, from a repository overlay, from an env-setup staged root or from any workflow worktree. A stage's `ident` SHALL equal its file stem and match `^[a-z0-9][a-z0-9-]{0,62}$`. A stage SHALL declare `displayName`, `environment`, `system`, `access` (`read-only` or `writable`) and at least one application under `apps`, each with a `label`, an absolute `url` and a `kind` (`ui`, `api`, `mail-catcher` or `probe`).

#### Scenario: Stage file in the configuration root
- **WHEN** `~/.config/agentic-coding/stages/definitions/grid-int.json` declares a valid stage `grid-int`
- **THEN** the stage catalog SHALL contain `grid-int` with its applications, roles and access marker

#### Scenario: Stage declared by a repository overlay
- **WHEN** a repository's `.pi/herdr-workflow.json` contains a stage-like block
- **THEN** the stage catalog SHALL NOT contain it

#### Scenario: Ident does not match the file stem
- **WHEN** `stages/definitions/a.json` declares `"ident": "b"`
- **THEN** the stage SHALL be excluded from the catalog with a diagnostic naming the file and the `ident` field

### Requirement: The stage catalog is the allow-list and refuses production-like stages
Only stages that pass validation SHALL be part of the allow-list. Validation SHALL exclude a stage whose `ident` or `environment` matches `prod`, `production`, `prd` or `live` (case-insensitive, as a whole token); whose application URL or allowed origin host matches a `deniedHostPatterns` entry of `stages/policy.json`; whose URL is not `https` unless the host is a loopback address or the stage sets `insecureHttp: true`; or whose role names a login recipe the stage does not declare; or whose application `app` names an ident absent from `apps/definitions`. Limits above the policy `ceilings` SHALL be clamped to the ceiling with a diagnostic. Every diagnostic SHALL name the file and field and SHALL NOT contain a credential value.

#### Scenario: Production environment refused
- **WHEN** a stage declares `"environment": "production"`
- **THEN** the stage SHALL NOT be in the allow-list
- **AND** the catalog diagnostics SHALL name the file and the `environment` field

#### Scenario: Denied host refused
- **WHEN** `stages/policy.json` declares `"deniedHostPatterns": ["*.prod.example.com"]` and a stage app URL is `https://clerk.prod.example.com`
- **THEN** the stage SHALL NOT be in the allow-list

#### Scenario: Unknown app ident
- **WHEN** a stage application declares `"app": "no-such-app"` and no `apps/definitions/no-such-app.json` exists
- **THEN** the stage SHALL NOT be in the allow-list and the diagnostic SHALL name the `app` field

#### Scenario: Limit above the ceiling
- **WHEN** the policy ceiling for `maxWaitSeconds` is 900 and a stage declares 3600
- **THEN** the stage SHALL be in the allow-list with `maxWaitSeconds` 900 and a clamping diagnostic

### Requirement: Stage credentials are `.env` references only
Every credential field of a stage role (`username`, `password`, `totp`) SHALL be exactly one `${VARIABLE}` reference resolved from the configuration root `.env`. A stage carrying any other value in a credential field SHALL be excluded from the allow-list with a diagnostic that names the field and not the value. A referenced variable that is absent or empty SHALL NOT exclude the stage; the role SHALL report credential status `missing` naming the variable. Credentials SHALL be resolved only inside the server at the moment of use.

#### Scenario: Literal password refused
- **WHEN** a stage role declares `"password": "hunter2"`
- **THEN** the stage SHALL NOT be in the allow-list
- **AND** no diagnostic, log line or response SHALL contain `hunter2`

#### Scenario: Missing variable
- **WHEN** a role declares `"password": "${STAGE_GRID_INT_CLERK_PASSWORD}"` and `.env` has no such key
- **THEN** the stage SHALL be in the allow-list and the role's credential status SHALL be `missing STAGE_GRID_INT_CLERK_PASSWORD`

### Requirement: Stage read surfaces never return a secret
The server SHALL expose the stage catalog to the authenticated dashboard/Settings client and to agent runs through an owner-scoped agent route and the `stage_info` tool. Each SHALL return stage structure (ident, display name, environment, system, access, plan-approval policy, exclusivity, application keys, labels, URLs, kinds, role names, login recipe kinds, data conventions, limits, wiki hints), per-role credential status (`set` or `missing <VAR>`) and diagnostics. None SHALL return a credential value or a resolved reference. `stage_info` SHALL additionally report, per application that declares a `version` probe, the probed version or `not discoverable`, fetched by the server with a bounded timeout and passed through the shared redactor.

#### Scenario: Agent lists stages
- **WHEN** an agent calls `stage_info` with no argument
- **THEN** the result SHALL list every allow-listed stage with its applications and role names
- **AND** the result SHALL NOT contain any `.env` value

#### Scenario: Version probe
- **WHEN** a stage application declares `"version": { "path": "/actuator/info", "field": "build.version" }` and the probe answers `{"build":{"version":"1.42.0"}}`
- **THEN** `stage_info` for that stage SHALL report version `1.42.0` for the application

#### Scenario: Version probe fails
- **WHEN** the version probe times out or answers an error
- **THEN** `stage_info` SHALL report `not discoverable` for that application and SHALL still answer

### Requirement: Settings shows stages and sets stage credentials safely
The Settings application SHALL show a read-only **Stages** section listing every stage file with its validation state, diagnostics, access marker, applications and per-role credential status. It SHALL let the developer set or replace a role's credential value through the existing protected `.env` credential flow, writing only the referenced `.env` key and displaying the value masked. Stage structure SHALL remain file-authored.

#### Scenario: Setting a missing credential
- **WHEN** the developer sets the value of `STAGE_GRID_INT_CLERK_PASSWORD` from the Stages section
- **THEN** only that `.env` key SHALL be written
- **AND** the role's credential status SHALL become `set` without the value being displayed or logged

### Requirement: Interactive login policy

`stages/policy.json` SHALL accept `interactiveLogin` with the value `local` or `never`. The default SHALL be `local`. A stage definition MAY set `interactiveLogin: "never"` to narrow the policy for that stage. A stage value of `local` under a `never` policy SHALL be ignored, with a diagnostic naming the file and field. The effective mode SHALL decide whether `stage_login` may hand a login to the developer. Neither file SHALL be able to carry a credential value through this key.

#### Scenario: Default policy allows a hand-off

- **WHEN** `stages/policy.json` has no `interactiveLogin` key
- **THEN** the effective mode for every stage SHALL be `local`

#### Scenario: A stage narrows the policy

- **WHEN** the policy is `local` and the stage `grid-int` sets `interactiveLogin: "never"`
- **THEN** the effective mode for `grid-int` SHALL be `never`

#### Scenario: A stage cannot widen the policy

- **WHEN** the policy is `never` and a stage sets `interactiveLogin: "local"`
- **THEN** the effective mode SHALL be `never` and a diagnostic SHALL name the stage file and field

### Requirement: Roles without credentials and the interactive recipe kind

A stage role MAY omit all credential references. Such a role SHALL stay in the allow-list, and its credential status SHALL be `none`. A stage MAY declare a login recipe of kind `interactive`. That kind SHALL declare no fields and SHALL require a `success` condition. A recipe of kind `interactive` without a `success` condition SHALL exclude the stage, with a diagnostic naming the recipe. Credential references that are declared SHALL keep the foundation's rule: exactly one `${VARIABLE}` per field.

#### Scenario: Role without credential references

- **WHEN** a role names a `form` recipe and declares no `username`, `password` or `totp`
- **THEN** the stage SHALL be in the allow-list, and the role's credential status SHALL be `none`

#### Scenario: Interactive recipe without a success condition

- **WHEN** a stage declares a recipe `{ "kind": "interactive" }` with no `success`
- **THEN** the stage SHALL be excluded, with a diagnostic naming the recipe

### Requirement: Login hand-off limit

A stage's `limits` SHALL accept `maxLoginHandoffSeconds`, default 900. The policy `ceilings` SHALL accept `maxLoginHandoffSeconds`, default 1800. A stage value above the ceiling SHALL be clamped, with a diagnostic, like every other limit. This limit SHALL bound a login hand-off from request to end, including queue time. It SHALL be independent of `maxWaitSeconds`.

#### Scenario: Hand-off limit is clamped

- **WHEN** the ceiling is 1800 and a stage declares `maxLoginHandoffSeconds: 7200`
- **THEN** the stage's effective `maxLoginHandoffSeconds` SHALL be 1800, with a clamping diagnostic

### Requirement: Login mode is reported per role

`stage_info` and the Settings Stages section SHALL report a `loginMode` for every role, together with its credential status:

- `automated`: every referenced variable is set and the recipe is automatable;
- `handoff`: the role would hand off under the effective mode `local`, per the login hand-off trigger requirement in the browser-sessions spec;
- `unavailable`: the role cannot be logged in interactively — the effective mode is `never`, or its recipe can never be answered in a hand-off window (an `http-basic` recipe, whose browser authentication dialog does not appear in a window the server launched).

Neither surface SHALL report a credential value or a resolved reference.

#### Scenario: Role without credentials under the local policy

- **WHEN** `stage_info` is called for a stage whose role `sachbearbeiter` has credential status `none` and the effective mode is `local`
- **THEN** the role SHALL be reported with `loginMode: "handoff"`

#### Scenario: Role with a missing variable under the never policy

- **WHEN** a role's password variable is absent and the effective mode is `never`
- **THEN** the role SHALL be reported with credential status `missing <VAR>` and `loginMode: "unavailable"`

