# agent-definition-isolation Specification

## Purpose
Herdr-spawned agents load herdr-specific skills and extensions from a dedicated directory not discoverable by pi. User pi sessions and manually spawned agents do not see herdr agent definitions.

## Requirements

### Requirement: Agent definitions outside pi discovery
Herdr-specific agent skills and extensions SHALL reside under `agent-definitions/` rather than `pi/skills/` or `pi/extensions/`.

#### Scenario: Herdr skill is not auto-discovered
- **GIVEN** a herdr skill at `agent-definitions/skills/herdr-openspec-planner/SKILL.md`
- **WHEN** pi starts in the repository without explicit `--skill` flags
- **THEN** pi SHALL NOT advertise `herdr-openspec-planner` in its available skills

#### Scenario: Herdr extension is not auto-discovered
- **GIVEN** a herdr extension at `agent-definitions/extensions/herdr-telemetry.ts`
- **WHEN** pi starts in the repository without explicit `--extension` flags
- **THEN** pi SHALL NOT load `herdr-telemetry.ts`

#### Scenario: User pi session unaffected
- **GIVEN** no `--skill` or `--extension` flags pointing to `agent-definitions/`
- **WHEN** the user starts an interactive pi session in the repository
- **THEN** herdr skills SHALL NOT appear in the system prompt
- **AND** herdr extensions SHALL NOT be loaded

### Requirement: Herdr workflow loads definitions explicitly
The herdr workflow launcher SHALL reference agent definitions by their source-controlled path in `agent-definitions/`.

#### Scenario: Planner agent loads skill explicitly
- **GIVEN** an active workflow change in `explore` phase
- **WHEN** `pi_command()` builds arguments for the planner agent
- **THEN** the command SHALL include `--skill` pointing to `agent-definitions/skills/herdr-openspec-planner/SKILL.md`

#### Scenario: Worker agent loads telemetry
- **GIVEN** an active workflow change in `apply` phase
- **WHEN** `pi_command()` builds arguments for the worker agent
- **THEN** the command SHALL include `--extension` for `agent-definitions/extensions/herdr-telemetry.ts`

#### Scenario: Verifier agent loads role skill
- **GIVEN** a verifier role `security-verifier`
- **WHEN** `pi_command()` builds arguments for that verifier
- **THEN** the command SHALL include `--skill` pointing to `agent-definitions/skills/herdr-openspec-security-verifier/SKILL.md`

### Requirement: Stow script does not link agent definitions
The stow installation script SHALL NOT link `agent-definitions/` into pi's global agent discovery directories.

#### Scenario: Stow skips agent-definitions
- **GIVEN** `scripts/stow.sh` runs for any supported `DOTFILES_ENV`
- **WHEN** linking completes
- **THEN** `~/.pi/agent/skills/herdr-openspec-*` SHALL NOT exist as symlinks
- **AND** `~/.pi/agent/extensions/herdr-telemetry.ts` SHALL NOT exist as a symlink
- **AND** `~/.pi/agent/extensions/herdr-workflow.ts` SHALL NOT exist as a symlink

#### Scenario: Stow cleans stale herdr symlinks
- **GIVEN** stale `herdr-openspec-*` symlinks exist in `~/.pi/agent/skills/` from a previous installation
- **WHEN** `scripts/stow.sh` runs
- **THEN** the stale symlinks SHALL be removed
