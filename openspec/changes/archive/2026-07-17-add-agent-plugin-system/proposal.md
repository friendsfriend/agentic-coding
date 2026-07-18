## Why

Herdr workflow agents (planner, worker, verifiers) currently run with `--no-extensions` and `--no-skills`, meaning they have zero access to the user's pi extensions, custom tools, or skills. Users who want to give their agents specialized information-gathering capabilities (e.g., Jira ticket lookup, Postgres queries, web search) have no way to do so without modifying the workflow launcher.

This forces an unnecessary separation: the user's interactive pi setup is rich with extensions and tools, but their headless agent sessions are barren.

## What Changes

- **Planner and worker agents inherit the user's full pi extension/tool/skill setup.** The `--no-extensions` and `--no-skills` flags are removed for these roles, and the hardcoded `--tools` restriction is lifted.
- **Specialized agents (verifiers, triage, recovery, archive) remain restricted** to keep their attack surface small and behavior predictable.
- **A configurable exclusion mechanism** lets users exclude specific extensions from agent roles (e.g., an interactive-only TUI extension that would stall in a headless agent).
- **A `herdr-workflow plugin` command family** provides discoverability: `plugin list` shows installed extensions and their agent role assignments, `plugin install` wraps `pi install` and adds role metadata.

## Capabilities

### New Capabilities
- `agent-plugin-inheritance`: Planner and worker agents automatically load the user's installed pi extensions, skills, prompt templates, and themes — the same setup available in interactive pi sessions.
- `agent-plugin-exclusion`: Users can blacklist extensions per agent role via a config file, preventing certain extensions from loading in headless agents.
- `agent-plugin-discoverability`: The `herdr-workflow plugin` command lets users inspect, install, and manage agent-plugin assignments.

### Modified Capabilities
- `herdr-workflow-start`: The `pi_command()` launcher no longer strips extensions/skills for planner and worker roles.
- `herdr-workflow-config`: The workflow TOML gains an optional `[plugins]` section for exclusions and role assignments.

## Impact

- Only `pi/bin/herdr-workflow` (Python) changes — the workflow launcher logic.
- Optionally adds a `~/.pi/agent/plugin-assignments.json` or inline config in `herdr-workflow.toml`.
- Users with existing pi extensions will see them automatically available in planner/worker agent sessions. This is a behavior change — previously those extensions were invisible to agents.
- No changes to the pi core, extension API, or agent-dash.
