# Design: add-agent-plugin-system

## Overview

The core insight: pi already has a rich extension, skill, and tool system. Planner and worker agents are pi instances, but the Herdr workflow launcher currently disables all user extensions with `--no-extensions` and `--no-skills`. The fix is to stop disabling them for roles where custom tools are desirable, while keeping restricted roles locked down.

## Approach

### 1. Agent Role Classification

Two categories:

| Category | Roles | Extensions? | Skills? | Tool limit? |
|----------|-------|-------------|---------|-------------|
| **Unrestricted** | `planner`, `worker` | All user extensions loaded (minus exclusions) | All user skills loaded | None (all tools available) |
| **Restricted** | `triage`, `recovery`, `*-verifier`, `archive` | Only `herdr-telemetry.ts` | Only role skill | Hardcoded subset |

### 2. Changes to `pi_command()` (Python in `pi/bin/herdr-workflow`)

Current logic:
```python
tools = {"planner": "read,bash,edit,write", "worker": "read,bash,edit,write", ...}[role]
parts = [
    "pi", "--tools", tools,
    "--no-extensions",
    "--extension", str(AGENT_DIR / "extensions" / "herdr-telemetry.ts"),
    "--no-prompt-templates",
    "--no-skills",
    "--skill", str(skill),
    ...
]
```

New logic:
```python
UNRESTRICTED_ROLES = {"planner", "worker"}

if role in UNRESTRICTED_ROLES:
    parts = [
        "pi",
        # No --tools restriction — all tools available
        # No --no-extensions — user extensions load normally
        "--extension", str(AGENT_DIR / "extensions" / "herdr-telemetry.ts"),  # always loaded
        # (optional) --exclude-tools from plugin exclusion config
        # (optional) --exclude-extensions from plugin exclusion config
        # No --no-skills — user skills load normally
        "--skill", str(skill),  # role skill loaded additionally
        ...
    ]
else:
    # Keep current restricted behavior for verifiers, triage, etc.
    parts = [
        "pi", "--tools", tools,
        "--no-extensions",
        "--extension", str(AGENT_DIR / "extensions" / "herdr-telemetry.ts"),
        "--no-prompt-templates",
        "--no-skills",
        "--skill", str(skill),
        ...
    ]
```

### 3. Exclusion Configuration

Users may have extensions that are interactive-only (e.g., a TUI game, a modal dialog, a custom editor widget). These should not run in headless agent sessions.

Add an optional `[plugins]` section to `herdr-workflow.toml`:

```toml
[plugins]
exclude_extensions = ["my-interactive-tool", "game-extension"]

# Per-role overrides (optional)
[plugins.roles.worker]
exclude_extensions = ["heavy-data-fetcher"]

[plugins.roles.planner]
exclude_extensions = []
```

The exclusion list references extension names (the filename stem or package name). These are passed as `--exclude-extensions` flags to pi.

The config file location mirrors the existing config resolution:
1. `~/.pi/agent/herdr-workflow.toml` (global)
2. `.pi/herdr-workflow.toml` (project, if trusted)

### 4. Plugin Discoverability (`herdr-workflow plugin`)

New subcommands:

```bash
herdr-workflow plugin list
  # Lists all pi extensions with their role affinity
  # Reads from pi's extension discovery + agent exclusion config

herdr-workflow plugin install <source> [--worker] [--planner] [--local]
  # Wraps: pi install <source>
  # Optionally registers role metadata in plugin-assignments.json

herdr-workflow plugin install-local <path> [--worker] [--planner]
  # Symlinks/copies a local extension into the appropriate plugins directory
  # Registers role metadata
```

**Discovery logic** for `plugin list`:
1. Read `pi.getAllTools()` equivalent — enumerate all known extension tools
2. Cross-reference with exclusion config
3. Display which tools are active for which roles

Since `herdr-workflow` is a Python CLI that doesn't run inside pi, the discovery reads:
- Extension files from `~/.pi/agent/extensions/` and `.pi/extensions/`
- Installed pi packages from `~/.pi/agent/npm/` and `~/.pi/agent/git/`
- Exclusion config from `herdr-workflow.toml`

### 5. Role Metadata for `plugin install`

When installing a plugin, optionally record role assignments:

```json
// ~/.pi/agent/plugin-assignments.json
{
  "plugins": [
    {
      "source": "npm:@foo/pi-jira",
      "installType": "npm",
      "agentRoles": ["planner", "worker"]
    },
    {
      "source": "/Users/me/dev/my-ext.ts",
      "installType": "local",
      "agentRoles": ["worker"]
    }
  ]
}
```

This file is optional. If absent, all unrestricted roles get all extensions. The file exists primarily for:
- Documentation / discoverability via `plugin list`
- Future "install and assign in one step" workflow
- Potential tool-level gating (future enhancement)

### 6. Backward Compatibility

- Existing workflows are unaffected. The change only affects how future `pi_command()` invocations are constructed.
- Users who don't have custom extensions see no behavioral difference.
- Users who do have extensions will see them in planner/worker. If an extension causes issues, the exclusion config provides an escape hatch.

## Non-goals

- Tool-level white/blacklists per role (future possibility, not needed now).
- A separate plugin installation system — `pi install` remains the primary mechanism.
- Verifier or triage agent extension support — keeping them restricted reduces risk surface.
- UI in agent-dash for managing plugins — CLI only.
