# agent-environment-tools Specification

## MODIFIED Requirements

### Requirement: env_list reports staged and default targets

`env_list` SHALL report the targets of the owner's configuration view, SHALL mark each target that resolved from a staged root, and SHALL mark the default target per app and action together with the reason it is the default — a declaration in `apps/defaults/<app>.json`, the only candidate of the default profile, or the platform's documented runtime preference — or SHALL mark the action as having an ambiguous default instead of silently choosing one. A tool that builds or tests without a nameable default SHALL fail with the candidate list and the declaration file that settles it, so a non-interactive consumer never guesses.

#### Scenario: Staged target is marked

- **WHEN** an `env-setup` run lists an app whose run and build targets were staged
- **THEN** those targets SHALL be marked as staged, and the target the tools would run by default SHALL be marked as the default with the reason it is the default

#### Scenario: A declared default is reported as declared

- **WHEN** the staged root's `apps/defaults/<app>.json` declares which build target is the default and the author lists the app
- **THEN** that target SHALL be marked as the default and the listing SHALL say the default was declared

#### Scenario: A staged definition is a symlink

- **WHEN** the owner's staged root holds a definition file that is a symlink to a file outside it
- **THEN** `env_list` SHALL report that staged path and the target it points at, so the author deletes the link and writes a regular file instead of writing through it
- **AND** an owner without a staged configuration view SHALL report no such entry

#### Scenario: Ambiguous default is reported

- **WHEN** an app declares two build targets for the same default profile and nothing declares which is the default
- **THEN** the listing SHALL mark the build action's default as ambiguous and SHALL name both targets
- **AND** `env_build` without a target SHALL fail with the same candidate list and the `apps/defaults/<app>.json` path that settles it
