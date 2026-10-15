# Spec Delta: dashboard-agent-session-view

## Purpose

The agent session prompt offers `/compact` alongside `/model` and `/thinking`,
and the session view shows what a compaction is doing.

## ADDED Requirements

### Requirement: Compact command in the session prompt

The agent session prompt SHALL offer `/compact` in its command list, with an
optional free-text argument (`/compact focus on the open findings`) that is
passed to the run's agent host as the summarizer instructions, and SHALL route
it through the host control protocol exactly as `/model` and `/thinking` are
routed. The command SHALL work from both the dashboard agent session view and the
orchestrator session, which share this prompt. Its outcome SHALL be reported to
the developer as a notice: started, already compacting (naming the reason),
nothing to compact, or the failure the host returned. A finished run whose host
no longer tracks it SHALL be reported as finished with nothing compacted, never
as an unhandled error. A bare `/model`-style command without arguments SHALL keep
its current behavior.

#### Scenario: Command offered

- **WHEN** the developer types `/com` in an open agent session prompt
- **THEN** `/compact` SHALL appear in the command list with its description

#### Scenario: Instructions forwarded

- **WHEN** the developer submits `/compact focus on the open findings`
- **THEN** the host SHALL receive `compact` with those instructions and the prompt SHALL be cleared

#### Scenario: Notices per outcome

- **WHEN** the host answers `already-compacting`, `nothing-to-compact` or an error
- **THEN** the session SHALL show a notice naming that outcome instead of a success message

#### Scenario: Orchestrator session uses the same command

- **WHEN** the developer submits `/compact` in the Home → Orchestrator session
- **THEN** the orchestrator's own host SHALL serve it through the same protocol request
