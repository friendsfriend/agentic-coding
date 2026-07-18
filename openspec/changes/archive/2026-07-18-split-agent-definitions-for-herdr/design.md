# Design: split-agent-definitions-for-herdr

## Overview

The fix is a one-way split: move herdr-specific agent assets from the global pi discovery path (`pi/skills/`, `pi/extensions/`) into a dedicated `agent-definitions/` directory. The herdr workflow launcher references these assets by absolute path from the repository. User pi sessions no longer auto-discover them.

## Directory Layout

```
agentic-coding/
├── agent-definitions/          NEW — herdr-only, not stowed
│   ├── skills/
│   │   ├── herdr-openspec-planner/SKILL.md
│   │   ├── herdr-openspec-worker/SKILL.md
│   │   ├── herdr-openspec-triage/SKILL.md
│   │   ├── herdr-openspec-recovery/SKILL.md
│   │   ├── herdr-openspec-archive/SKILL.md
│   │   ├── herdr-openspec-security-verifier/SKILL.md
│   │   ├── herdr-openspec-quality-verifier/SKILL.md
│   │   ├── herdr-openspec-performance-verifier/SKILL.md
│   │   ├── herdr-openspec-test-verifier/SKILL.md
│   │   ├── herdr-openspec-agents-verifier/SKILL.md
│   │   └── herdr-openspec-openspec-verifier/SKILL.md
│   └── extensions/
│       ├── herdr-telemetry.ts
│       └── herdr-workflow.ts
├── pi/                         stays — general pi assets
│   ├── bin/herdr-*
│   ├── herdr-workflow.toml
│   ├── extensions/             non-herdr extensions only
│   ├── skills/
│   │   ├── opentui/            general skill, stays
│   │   └── ...                 other non-herdr skills
│   └── prompts/
└── scripts/
    └── stow.sh                 links pi/ but NOT agent-definitions/
```

## Changes by File

### 1. `pi/bin/herdr-workflow` — `SKILLS` and extension paths

Current:
```python
AGENT_DIR = Path.home() / ".pi" / "agent"
SKILLS = AGENT_DIR / "skills"
# ... pi_arguments() references:
#   str(AGENT_DIR / "extensions" / "herdr-telemetry.ts")
#   str(SKILLS / f"herdr-openspec-{role}" / "SKILL.md")
```

New:
```python
# Resolve agent-definitions relative to the script's repository root
AGENT_DEF_DIR = Path(__file__).resolve().parent.parent.parent / "agent-definitions"
SKILLS = AGENT_DEF_DIR / "skills"
# ... pi_arguments() references AGENT_DEF_DIR:
#   str(AGENT_DEF_DIR / "extensions" / "herdr-telemetry.ts")
#   str(SKILLS / f"herdr-openspec-{role}" / "SKILL.md")
```

`SKILLS` constant removed from the old `AGENT_DIR`-based definition. `AGENT_DEF_DIR` resolves from the script path (`pi/bin/herdr-workflow` → `../../agent-definitions/`).

### 2. `scripts/stow.sh` — link all of `pi/` but skip agent definitions

The stow script links `$root/pi` → `$HOME/.pi/agent` and `$root/herdr` → `$HOME/.config/herdr`. Since `agent-definitions/` is outside `pi/`, it is NOT linked. Additionally, stow cleans stale herdr skill/extension symlinks from `~/.pi/agent/` that were created before this change.

Add cleanup after the existing `link_tree` calls:

```bash
# Remove stale herdr agent definition symlinks from global pi discovery
# These were previously linked from pi/skills/herdr-* and pi/extensions/herdr-*
for stale in "$HOME/.pi/agent/skills"/herdr-openspec-* \
             "$HOME/.pi/agent/extensions/herdr-telemetry.ts" \
             "$HOME/.pi/agent/extensions/herdr-workflow.ts"; do
    [ -L "$stale" ] && rm "$stale"
done
```

### 3. `scripts/test-plugin-system.sh` — update test scaffolding

Currently creates stub skills/extensions under `~/.pi/agent/skills/` and `~/.pi/agent/extensions/`. The `herdr-workflow`
launcher now references `agent-definitions/` paths. Update test scaffolding to create stubs under the project's `agent-definitions/` directory instead.

### 4. Specs and policy updates

- `openspec/specs/scripts/spec.md`: Add scenario for agent-definition isolation — herdr-specific agent definitions SHALL reside under `agent-definitions/`, NOT under `pi/`.
- `openspec/specs/pi-agent-plugin-system/spec.md`: Update extension path references to `agent-definitions/extensions/`.
- `.pi/verifier/stow-installation.md`: Add `agent-definitions/` as an exempt path (not a stow-managed installable asset). Add rule that herdr-specific skills/extensions under `agent-definitions/` are loaded by explicit path, not by pi discovery.

## Backward Compatibility

- Existing worktrees and active verifications continue unaffected — they already have the agent running with `--skill` and `--extension` paths that referenced `~/.pi/agent/`. Only new agent spawns after the change use `agent-definitions/`.
- Users who run `scripts/stow.sh` after pulling get stale symlinks cleaned automatically.
- The `herdr-workflow` CLI API is unchanged. No command signatures, flags, or workflow phase names change.
