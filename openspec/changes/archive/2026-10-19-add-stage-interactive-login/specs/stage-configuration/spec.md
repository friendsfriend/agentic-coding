## ADDED Requirements

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
