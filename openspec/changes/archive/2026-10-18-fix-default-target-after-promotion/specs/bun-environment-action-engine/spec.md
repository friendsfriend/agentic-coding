# bun-environment-action-engine Specification

## ADDED Requirements

### Requirement: One resolver decides the default target of an app and action

The engine SHALL resolve the default target of one app and one action through a single documented rule that every consumer uses — the agent build/test tools, `env_list`, the developer's UI/TUI action, the validation gate and the post-promotion smoke check — and SHALL let the configuration declare that default in `<config>/apps/defaults/<app>.json`, whose value for an action names a target by its client-visible id, its compiled definition id, its runtime, its runtime family or its label. A declaration SHALL win over every preference, SHALL be read from the owner's staged configuration root when one exists, and SHALL be an error the gate refuses when it names no target of that app and action.

#### Scenario: A declaration decides between two families

- **WHEN** an app has a live Dockerfile build target and a live script build target, both with the default profile, and `apps/defaults/<app>.json` declares that build default
- **THEN** every consumer SHALL resolve the declared target as the default build and SHALL report the reason as declared

#### Scenario: The renderings of one family are not a choice

- **WHEN** a script build target compiles into a `tmux` window variant beside its synchronous command variant
- **THEN** the default SHALL be the synchronous rendering and the action SHALL NOT be reported as ambiguous

#### Scenario: A declaration that a draft supersedes is refused

- **WHEN** a declaration names a live target and a drafted target of the same app, action and profile supersedes it
- **THEN** the gate SHALL report a finding naming the declaration and the superseded target and SHALL NOT validate one target while running another

#### Scenario: A declaration that names nothing is refused

- **WHEN** a declaration names a target that no live or drafted definition of that app and action provides
- **THEN** the gate SHALL fail with a finding quoting the declared value and the candidates it could have named

## MODIFIED Requirements

### Requirement: Default target selection is deterministic and reported

When a request does not name a build, test or run target, the engine SHALL resolve the default through the one shared rule of "One resolver decides the default target of an app and action": a declaration wins, a single runtime family is no choice at all, a `run` falls back to the platform's documented runtime order (Docker, then a script, then Kubernetes) and reports that reason, and a `build` or `test` of several runtime families with nothing declared SHALL be refused rather than silently picked. The engine SHALL make the resolution readable by callers, so a listing, a definition list or a report can name the default target per action, the target id it resolves to and why.

#### Scenario: Two default-profile build targets are refused

- **WHEN** an app declares a Dockerfile build target and a script build target, both without a profile, nothing declares which is the default, and a caller runs the build without naming one
- **THEN** the engine SHALL fail with an error naming both candidate targets and the `apps/defaults/<app>.json` file that settles the choice

#### Scenario: A declared default is run

- **WHEN** `apps/defaults/<app>.json` declares the script build target as the build default
- **THEN** a build that names no target SHALL run that target, and a caller asking which build target is the default SHALL be told the same target and the reason

#### Scenario: Named default is reported

- **WHEN** a caller asks which build target is the default for an app with exactly one default-profile build target
- **THEN** the answer SHALL name that target and the request SHALL run it

#### Scenario: A run keeps the platform order

- **WHEN** an app offers a compose run target and a script run target, nothing declares a run default, and a caller starts the app without naming a target
- **THEN** the engine SHALL select the container target and SHALL report that the platform's runtime preference decided it

### Requirement: Build context preparation is deliberate and never hides a failure

The build-context preparation SHALL exist only for a build context that uses the configuration's `templates` directory, SHALL record exactly what it copied into the build context so the cleanup step removes exactly those entries, and SHALL fail with a message instead of swallowing an error, so a successful build's log carries no `No such file or directory` line for a directory the configuration does not have and a failed copy is never reported as success.

#### Scenario: Configuration has no templates directory

- **WHEN** the default build action is compiled for a configuration without a `templates` directory
- **THEN** the definition SHALL carry no build-context preparation step and the build SHALL write nothing into the checkout before it runs

#### Scenario: Configuration has a templates directory

- **WHEN** the default build action runs for a configuration with a `templates` directory
- **THEN** the preparation step SHALL copy its entries into the build context, SHALL record them, and the cleanup step SHALL remove exactly those entries afterwards

#### Scenario: The copy fails

- **WHEN** the preparation step cannot list or copy the configured `templates` directory
- **THEN** the step SHALL report the failure with a message instead of completing successfully
