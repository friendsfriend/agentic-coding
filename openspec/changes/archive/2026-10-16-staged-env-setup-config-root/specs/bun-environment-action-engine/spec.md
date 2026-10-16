# bun-environment-action-engine Specification

## ADDED Requirements

### Requirement: Symlinked definition sources resolve to their real path

A *build* definition whose source file is a symbolic link SHALL execute: the engine SHALL resolve the container tool's `-f` argument to the symlink's real path (or pass the definition as a plain file) so that a Dockerfile reached through a symlink outside the build context is read, and a link that cannot be resolved SHALL be reported as an error naming it rather than as a missing file.

A *compose* source keeps the path as given, deliberately: `docker compose` derives its project directory from the compose file path as written, so resolving a symlinked compose file to its real path would silently change how that file's relative mounts and `include:` targets resolve. The compose file is read through the link, which is what the link is for.

#### Scenario: Symlinked Dockerfile outside the build context

- **WHEN** `apps/build/<app>-build.Dockerfile` is a symlink to a file in another directory and the default build action runs with the checkout as its build context
- **THEN** the container tool SHALL be invoked with the resolved real path and the build SHALL proceed instead of failing with `failed to read dockerfile`

#### Scenario: Symlinked compose source

- **WHEN** `apps/compose/<app>-compose.yml` is a symlink to a definition elsewhere, or a staged run target is started from a staged configuration root whose compose file `include:`s a shared infrastructure definition
- **THEN** the compose command SHALL be invoked with the compose file's own path (inside the staged root when the run resolves one), the file it names SHALL be read through that path, and the start SHALL reach readiness

### Requirement: Default target selection is deterministic and reported

When a request does not name a build, test or run target, the engine SHALL select the default-profile target deterministically, SHALL refuse rather than silently pick when several candidates share the default profile, and SHALL make the selection readable by callers so a listing or report can name the default target per action.

#### Scenario: Two default-profile build targets

- **WHEN** an app declares a Dockerfile build target and a script build target, both without a profile, and a caller runs the build without naming one
- **THEN** the engine SHALL fail with an error naming both candidate targets instead of picking one

#### Scenario: Named default is reported

- **WHEN** a caller asks which build target is the default for an app with exactly one default-profile build target
- **THEN** the answer SHALL name that target and the request SHALL run it

### Requirement: Build context preparation does not emit spurious errors

The build-context preparation step SHALL NOT write an error for an absent optional input, so a successful build's log carries no `No such file or directory` line for a directory the configuration does not have.

#### Scenario: Configuration has no templates directory

- **WHEN** the default build action runs for a configuration without a `templates` directory
- **THEN** the preparation step SHALL complete successfully with empty stderr
