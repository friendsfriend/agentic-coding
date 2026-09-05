## Context

`runStart()` and `startWorkflowInProcess()` independently prepare engine input. `loadConfig()` and configuration write-back paths default to process.cwd(), while `drainEffects()` reloads remote/PR settings for pending work. The dashboard imports startup helpers through the CLI barrel.

## Goals / Non-Goals

**Goals:** equivalent starts share policy, selected repository determines configuration, and later effects use accepted non-secret settings.

**Non-goals:** new configuration syntax, credential storage, removal of final engine validation, or normalization of all CLI/TUI presentation behavior.

## Decisions

### Plain application function, not a service framework

Add a small workflow application module exporting startup preparation/execution and reusable role resolution. Accept a typed request with repository target, workflow ID/type, task, mode, preset, and optional ordered fusion profiles. CLI owns argv validation and JSON output; dashboard owns controls, prompts, and notifications. The application function owns config resolution, role routing, preflight, and Git preparation before calling `WorkflowEngine.start()`.

Keep transaction-bound invariants in the engine even when preflight provides an earlier friendly error. Reuse existing functions rather than wrapping every dependency behind an interface.

### Explicit repository context and provenance

Resolve the canonical repository before loading project settings. A linked worktree uses its canonical repository's project configuration. Repository-independent research/wiki uses global config unless an explicit repository evidence context was selected. `HERDR_WORKFLOW_CONFIG` retains full-replacement precedence and suppresses project overlays. No process.chdir or temporary global-environment mutation is permitted for selecting a project.

Return configuration provenance alongside resolved values so dashboard profile listing and write-back use the same selected source. Preserve the existing warning that repository agent configuration is trusted executable input. Validate relevant non-agent settings at this boundary as well as agent profiles.

### One fusion precedence rule

An explicit ordered fusion-profile list takes precedence over preset planner-role routes. Without it, derive a contiguous planner-1..planner-N list from the selected preset, requiring 2–5 distinct profiles. Missing/invalid configuration fails consistently before state creation or agent launch. A valid preset must work through CLI and dashboard equally.

### Persist execution settings, not secrets

Persist the effective delivery remote, resolved PR executable choice (or explicit unavailable value), and other configuration-sensitive execution settings with source provenance. Agents retain their existing profile pins; wiki root retains its existing pin. Handlers read these accepted settings, never the drainer's cwd/config. Missing PR tooling may still be diagnosed when PR creation is requested rather than making a non-PR workflow impossible to start.

For legacy workflows lacking these fields, status remains readable. Configuration-sensitive effects stop with a settings-adoption diagnostic until an operator previews and accepts settings through a revision-bound repair/migration path. Merely reading a workflow or upgrading the binary must not choose a new remote.

## Risks / Trade-offs

- Shared preparation can accidentally weaken direct-engine validation → keep negative direct-engine tests.
- Legacy workflows need one explicit adoption step → prefer a visible choice over pushing to an ambient remote.
- Multiple configuration sources complicate edits → carry provenance and preserve existing layered-write conflict checks.

## Migration Plan

Introduce the shared function first with parity tests, then route CLI, dashboard, and internal wiki starts through it. Add persisted settings and the legacy adoption path before removing handler defaults. Document CLI fusion preset support and cross-repository configuration resolution. Treat settings pins separately from executable behavior pins in `version-workflow-behavior-pins`.
