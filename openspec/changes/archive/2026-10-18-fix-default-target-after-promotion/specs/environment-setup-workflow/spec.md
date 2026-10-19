# environment-setup-workflow Specification

## ADDED Requirements

### Requirement: A default declaration is authored, shown and promoted

The family SHALL accept a drafted per-app default declaration at `apps/defaults/<app>.json` as a normal draft: the write guard covers its tree, the gate validates it, the approval diff renders the decision it states, and the promotion publishes it with a backup of the live file it replaces, so a rollback restores the previous declaration or removes the added one.

#### Scenario: The approval diff states the decision

- **WHEN** the author drafts `apps/defaults/<app>.json` declaring a build target while the live configuration offers a Dockerfile target and a script target
- **THEN** the approval diff for that draft SHALL begin with a line naming the action, the app and the target it declares, and SHALL state that the default was ambiguous and which runtime families it chose between

#### Scenario: Promotion and rollback cover the declaration

- **WHEN** the developer approves and the promotion publishes the declaration, and a rollback follows
- **THEN** the promotion SHALL have backed up a live declaration it replaced, the live configuration SHALL resolve the declared default afterwards, and the rollback SHALL restore the previous declaration or remove the added one

#### Scenario: The linked definition stays untouched

- **WHEN** the live build path is a symlink into the developer's own configuration and the draft does not change it
- **THEN** the promotion SHALL leave the link and the file it points at byte-identical

## MODIFIED Requirements

### Requirement: Deterministic validation gate

Before approval the workflow SHALL validate every drafted and affected target against the staged configuration root both structurally (parse, discover, compile, OTel variables, no host-port collision with another app) and by executing the developer's real path — the default build action, then the default run target to readiness, then the default test action when one exists — with bounded per-step time and bounded output; a failure or a step the machine cannot run SHALL return to authoring with the failure report naming each step and its result, bounded to five rounds. The gate SHALL resolve each action's default through the one shared rule (a drafted declaration first, then a drafted target that supersedes a live one of the same action and profile, then the only runtime family on offer, then the platform's run order), SHALL report every default with the reason it was resolved, SHALL refuse a declaration that names no target or that a superseding draft displaces, and SHALL build, start and test exactly the targets it resolved.

#### Scenario: Port collision

- **WHEN** a drafted compose target publishes host port 8080 already used by another app's definition
- **THEN** validation SHALL fail and the author SHALL receive the collision finding

#### Scenario: Default build fails

- **WHEN** the default build action of the app under setup fails against the staged root
- **THEN** validation SHALL fail with a finding naming the target, its exit status and a bounded log tail
- **AND** the workflow SHALL return to the author instead of offering the approval

#### Scenario: The gate runs the default it resolved

- **WHEN** the live configuration offers a Dockerfile build target and the draft adds a script build target of the same action and profile
- **THEN** the gate SHALL build the drafted script target, SHALL report it as the default build with the reason it was resolved, and SHALL name the live target it superseded

#### Scenario: An ambiguous default is a finding

- **WHEN** two default-profile build targets of different runtime families are live and nothing declares which is the default
- **THEN** validation SHALL fail with a finding naming both candidates and the `apps/defaults/<app>.json` file that settles the choice, and SHALL NOT silently build one of them

#### Scenario: Default test fails

- **WHEN** the default build and the start succeed and the default test action fails
- **THEN** validation SHALL report the test step's exit status and bounded output as a finding

#### Scenario: Step cannot run on this machine

- **WHEN** a step needs a tool or daemon this machine does not have
- **THEN** the report SHALL state the step as `skipped` with the reason and SHALL fail the gate rather than pass it

### Requirement: Post-promotion smoke check with rollback

After a successful promotion the system SHALL resolve the **live** defaults of build, run and test through the same rule every other consumer uses, SHALL compare them with the defaults the gate validated (recorded in the run's own snapshot), and SHALL fail the check with the drift named — offering the developer the rollback from the promotion backup, or the explicit choice to keep the promotion — when they differ, instead of starting a target the gate did not validate; no part of this SHALL run without the developer's approval. When they match the system SHALL start the resolved live default run target once, record the result, and report what it did not rebuild.

#### Scenario: The live default is not the validated one

- **WHEN** the gate validated the promoted script build target and the live configuration resolves the Dockerfile target beside it
- **THEN** the smoke check SHALL fail without starting or building anything, SHALL name the action, the validated target and the live answer, and SHALL offer the rollback

#### Scenario: Live start fails after promotion

- **WHEN** the promoted configuration starts and does not reach readiness
- **THEN** the workflow SHALL record the failure and SHALL offer the developer the choice to roll back or to keep the promotion

#### Scenario: Rollback restores the previous files

- **WHEN** the developer chooses to roll back
- **THEN** every file the promotion wrote SHALL be restored to its previous content and the files it added SHALL be removed
- **AND** the staged root SHALL be restored so the author can revise it

#### Scenario: Build is not repeated when it was proven

- **WHEN** the promoted build definition's content is the content the gate already built and tested and the live default build resolves to that same target
- **THEN** the smoke step SHALL report the build as `skipped` with that reason, naming the target, and SHALL only start the resolved run target

#### Scenario: Promoted definition diverged from the reviewed one

- **WHEN** a promoted file's content differs from the content the gate built and tested
- **THEN** the smoke step SHALL rebuild the app's resolved default build target against the live configuration, SHALL report the rebuild with its exit status and a bounded log tail, and SHALL fail the check (offering the rollback) when that build does not succeed

#### Scenario: The approval view is served from the recorded review

- **WHEN** the developer opens the approval view for a staged root whose content no longer matches the digests the validation gate recorded
- **THEN** the view SHALL state that the drafts changed after the gate ran, naming the files, instead of rendering them as the content being approved
- **AND** the promotion SHALL refuse to publish them
