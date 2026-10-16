# environment-setup-workflow Specification

## Purpose
TBD - created by archiving change add-environment-setup-workflow. Update Purpose after archive.
## Requirements
### Requirement: Drafts only, repository read-only

The `env-setup` family SHALL write definitions only inside its own staged configuration root; any change to the live configuration directory or to the repository checkout during authoring SHALL put the workflow in `attention-required`.

#### Scenario: Agent edits live config

- **WHEN** the author run modifies a file in the live `apps/compose` directory
- **THEN** the workflow SHALL enter `attention-required` and SHALL NOT promote

#### Scenario: Author writes inside the staged root

- **WHEN** the author run writes `apps/compose/<app>-compose.yml` inside its staged root
- **THEN** the write guard SHALL NOT report a change to the live configuration
- **AND** the staged root's entry SHALL appear in the workflow's changed-file diff

#### Scenario: The server's own state changes while the author works

- **WHEN** the server mutates its own live state during the author turn (`orchestrator/**`, `classifier/**`, `.agentic-coding-workflow/**`, `tui.json`) or the product's browser install grows under `browsers/**`
- **THEN** the write guard SHALL NOT report a violation and SHALL NOT report its scan as incomplete

#### Scenario: A live definition changes outside the drafts

- **WHEN** a file under `apps/`, `infrastructure/` or `libraries/` changes during the author turn
- **THEN** the workflow SHALL enter `attention-required` and SHALL NOT promote
- **AND** the violation SHALL name the changed paths, bounded, with the number that changed
- **AND** it SHALL state that an incomplete read is reported only when a scan inside those trees really was cut short

#### Scenario: A write through a symlinked definition

- **WHEN** a definition inside a checked tree is a symlink into a file outside the configuration and that file's content changes during the author turn
- **THEN** the guard SHALL report a violation naming the symlinked path and the target it points at

#### Scenario: Baseline armed by an older guard

- **WHEN** the armed baseline was taken by a guard version without the definition-tree scope
- **THEN** the guard SHALL fail with one actionable violation saying the baseline is of an older version and the workflow must be restarted, instead of comparing the two fingerprints

### Requirement: Drafts are runnable before approval

During authoring and validation, every app run, build, test, log, browser, HTTP, telemetry or database read a run of the setup workflow performs SHALL resolve definitions from the workflow's staged configuration root before the live configuration, so drafted files and the live files they coexist with are reached through one layout.

#### Scenario: Agent starts its draft

- **WHEN** the author run calls `env_start` for its app
- **THEN** the drafted compose target SHALL be used even though no live target exists

#### Scenario: Drafted compose includes shared infrastructure

- **WHEN** a staged `apps/compose/<app>-compose.yml` names `../../infrastructure/compose/network-compose.yml`, which exists only in the live configuration
- **THEN** the resolved path SHALL be inside the staged root and the composed definition SHALL reach readiness

#### Scenario: Drafted build target is what env_build runs

- **WHEN** the author run calls `env_build` for an app whose build definition it staged
- **THEN** the build SHALL run the staged target, not the live one

### Requirement: Deterministic validation gate

Before approval the workflow SHALL validate every drafted and affected target against the staged configuration root both structurally (parse, discover, compile, OTel variables, no host-port collision with another app) and by executing the developer's real path — the default build action, then the default run target to readiness, then the default test action when one exists — with bounded per-step time and bounded output; a failure or a step the machine cannot run SHALL return to authoring with the failure report naming each step and its result, bounded to five rounds.

#### Scenario: Port collision

- **WHEN** a drafted compose target publishes host port 8080 already used by another app's definition
- **THEN** validation SHALL fail and the author SHALL receive the collision finding

#### Scenario: Default build fails

- **WHEN** the default build action of the app under setup fails against the staged root
- **THEN** validation SHALL fail with a finding naming the target, its exit status and a bounded log tail
- **AND** the workflow SHALL return to the author instead of offering the approval

#### Scenario: Default test fails

- **WHEN** the default build and the start succeed and the default test action fails
- **THEN** validation SHALL report the test step's exit status and bounded output as a finding

#### Scenario: Step cannot run on this machine

- **WHEN** no Docker daemon is reachable while the gate must build or start a target
- **THEN** the report SHALL record the step as `skipped` with the reason, SHALL NOT record it as a pass, and SHALL fail the gate

#### Scenario: Default target is ambiguous

- **WHEN** the app declares two build targets for the same default profile
- **THEN** the gate SHALL report `no-default-target` naming every candidate and SHALL fail

### Requirement: Atomic promotion with rollback

On approval the drafts SHALL be promoted with a protected backup of every replaced file and the catalog reloaded; any failure SHALL restore all replaced files and remove added ones. A replaced live path SHALL never be written through when it is a symlink.

#### Scenario: Write fails mid-promotion

- **WHEN** writing the third of five files fails
- **THEN** the live configuration SHALL be identical to its state before promotion

#### Scenario: Replacing a symlinked live file

- **WHEN** a draft replaces a live definition that is a symlink into the developer's own repository
- **THEN** the live path SHALL become a regular file holding the draft and the link's target file SHALL stay byte-unchanged
- **AND** the promotion SHALL record the replaced link's target, and the approval diff SHALL state that the symlink is replaced by a regular file

#### Scenario: Rolling back a replaced symlink

- **WHEN** a promotion that replaced a symlink is rolled back
- **THEN** the symlink SHALL be restored exactly (same target) rather than a regular file holding the target's bytes

### Requirement: Approval shows a diff and flags shared infrastructure

The approval gate SHALL show every new and modified file as a diff against the live configuration, SHALL flag changes to existing shared infrastructure, and SHALL show the validation report — the exact commands and targets run, each step's result, and the default target per action — so the developer approves only a configuration that built, started and tested.

#### Scenario: Postgres definition changed

- **WHEN** drafts modify the existing `postgres` infra definition
- **THEN** the approval view SHALL mark it as affecting all apps

#### Scenario: Approval shows what ran

- **WHEN** the validation gate passes and the developer opens the approval
- **THEN** the view SHALL list the build, start and test targets that ran, their exit statuses, and the default target per action

### Requirement: Staged configuration root mirrors the live configuration

For an `env-setup` workflow the system SHALL materialize a complete staged configuration root at the live configuration's own relative layout, holding the author's drafts at their final paths, and SHALL make that root the configuration view of every run, start, build, test and read the workflow performs.

#### Scenario: Staged root layout mirrors the live configuration

- **WHEN** the staged root for a workflow is materialized
- **THEN** every live configuration file outside the exclusion list SHALL exist at the same relative path inside the staged root
- **AND** `wiki`, `telemetry`, `snapshots`, `.drafts`, `.backups` and the server's discovery record SHALL NOT be copied
- **AND** the server's own live state and caches — `orchestrator/`, `.agentic-coding-workflow/`, `classifier*` (the classifier install and its sidecar files) and `browsers/` (the product's own Playwright install) — SHALL NOT be copied either

#### Scenario: Live symlinks are preserved as symlinks

- **WHEN** the live configuration holds `apps/build/<app>-build.Dockerfile` and `apps/compose/<app>-compose.yml` as symlinks into another directory
- **THEN** the staged root SHALL hold symlinks resolving to the same targets
- **AND** the staged Dockerfile SHALL still build and the staged compose file SHALL still start

#### Scenario: A staged path that is a symlink is reported as one

- **WHEN** the staged root holds a definition file that is a symlink to the developer's own file
- **THEN** `env_list` SHALL report it with its target
- **AND** the author instructions SHALL say that changing it means deleting the staged symlink and writing a regular file, never writing through the link

#### Scenario: Credential copies are private and unpublishable

- **WHEN** the staged root is materialized for a configuration with a `.env` file and a `providers` directory
- **THEN** both SHALL be exposed to the staged runs as private copies (`.env` as a file, `providers/` as a directory of files) with mode `0o400` inside the workflow's `0o700` state directory, and SHALL NOT be symlinks
- **AND** neither SHALL be publishable: the promotion's configuration-relative prefix allow-list excludes them, so the live credential store is never written from the staged tree
- **AND** no file the workflow writes SHALL contain their values beyond those copies (the base snapshot records digests, never content)

#### Scenario: Materialization is idempotent

- **WHEN** the materialization effect is claimed a second time after the author has written drafts
- **THEN** the staged root and the author's drafts SHALL be left exactly as they are

### Requirement: Changed files are derived from a base snapshot

The system SHALL take a base snapshot of the staged root at materialization and SHALL derive the changed files by content comparison, so the approval diff, the promotion plan and the write guard all read the same set of drafts.

#### Scenario: Untouched live symlink is not a draft

- **WHEN** the staged root holds the live configuration's own symlinks under `apps/` and `infrastructure/` untouched
- **THEN** the changed-file diff SHALL be empty

#### Scenario: Drafted symlink is refused

- **WHEN** the author replaces a staged file with a symlink pointing elsewhere
- **THEN** the gate SHALL report it as a non-regular draft and the promotion SHALL refuse it

#### Scenario: Deletion is reported, not published

- **WHEN** the author deletes a staged file the base snapshot holds
- **THEN** the diff SHALL report the deletion and the promotion SHALL NOT delete the live file

### Requirement: Promotion refuses to overwrite a changed live file

The promotion SHALL refuse to write a path whose live content no longer matches the base snapshot the staged copy was taken from, SHALL name every conflicting path, and SHALL NOT silently overwrite it.

#### Scenario: Live file changed after the copy

- **WHEN** the developer edits a live file the staged root also modified after the staged copy was taken
- **THEN** the promotion SHALL fail without writing, and the report SHALL name the conflicting path

### Requirement: Post-promotion smoke check with rollback

After a successful promotion the system SHALL start the real default run target of the app once against the live configuration, record the result, and on failure SHALL offer the developer a rollback from the promotion backup that restores exactly the previously promoted files, or the explicit choice to keep the promotion; no part of this SHALL run without the developer's approval.

#### Scenario: Live start fails after promotion

- **WHEN** the promoted configuration starts and does not reach readiness
- **THEN** the workflow SHALL record the failure and SHALL offer the developer the choice to roll back or to keep the promotion

#### Scenario: Rollback restores the previous files

- **WHEN** the developer chooses to roll back
- **THEN** every file the promotion wrote SHALL be restored to its previous content and the files it added SHALL be removed
- **AND** the staged root SHALL be restored so the author can revise it

#### Scenario: Build is not repeated when it was proven

- **WHEN** the promoted build definition's content is the content the gate already built and tested
- **THEN** the smoke step SHALL report the build as `skipped` with that reason and SHALL only start the target

#### Scenario: Promoted definition diverged from the reviewed one

- **WHEN** a promoted file's content differs from the content the gate built and tested
- **THEN** the smoke step SHALL rebuild the app's default build target against the live configuration, SHALL report the rebuild with its exit status and a bounded log tail, and SHALL fail the check (offering the rollback) when that build does not succeed

#### Scenario: The approval view is served from the recorded review

- **WHEN** the developer opens the approval view for a staged root whose content no longer matches the digests the validation gate recorded
- **THEN** the view SHALL state that the drafts changed after the gate ran, naming the files, instead of rendering them as the content being approved
- **AND** the promotion SHALL refuse to publish them

### Requirement: The staged root is removed at close and swept when stale

The system SHALL remove a workflow's staged root and its promoted sibling when the workflow closes, SHALL keep the promotion backup, and SHALL sweep staged state whose workflow no longer exists rather than letting stale roots accumulate.

#### Scenario: Close removes the staged root

- **WHEN** the env-setup workflow is closed
- **THEN** its staged root SHALL be gone and its promotion backup SHALL remain

#### Scenario: Start refuses leftovers

- **WHEN** an env-setup workflow is started with an id whose staged state already exists
- **THEN** the start SHALL be refused and the message SHALL name the directory

