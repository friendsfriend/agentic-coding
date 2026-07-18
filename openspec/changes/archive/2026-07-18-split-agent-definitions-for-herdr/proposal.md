# split-agent-definitions-for-herdr

## Why

Herdr agent definitions — role-specific skills (planner, worker, verifiers, triage, recovery, archive) and herdr extensions (herdr-telemetry.ts, herdr-workflow.ts) — currently reside under `pi/skills/` and `pi/extensions/`. The stow script (`scripts/stow.sh`) links `pi/` into `~/.pi/agent/`, making these herdr-specific assets auto-discovered by every pi session. This means the user's own interactive pi sessions and any pi agents they manually spawn load herdr skills into their system prompt and see herdr extensions. Herdr-spawned workflow agents get these same assets incidentally via global discovery, not by explicit design.

Consequence: self-spawned pi agents follow workflow patterns they shouldn't. The user's interactive pi is cluttered with herdr-specific skills (herdr-openspec-planner, herdr-openspec-worker, etc.) that are never useful outside a herdr pipeline.

## What Changes

- Herdr-specific agent definitions (skills + extensions) move from `pi/skills/herdr-*` and `pi/extensions/herdr-*` to a dedicated `agent-definitions/skills/herdr-*` and `agent-definitions/extensions/herdr-*`.
- `agent-definitions/` is NOT stowed into `~/.pi/agent/`. Only herdr-spawned agents load these assets via explicit `--skill` and `--extension` flags from `herdr-workflow`.
- `pi/skills/opentui/` stays under `pi/` — it is a general-purpose documentation skill, not herdr-specific.
- `pi/bin/` and `pi/herdr-workflow.toml` stay under `pi/` — they are workflow infrastructure, not agent definitions.

### New Capabilities

- `agent-definition-isolation`: Herdr agent definitions are isolated from pi's global discovery. User pi sessions and manual agent spawns no longer see herdr-specific skills or extensions.
- `explicit-agent-definition-loading`: `herdr-workflow` loads agent definitions by source-controlled repo path rather than relying on global discovery.

### Modified Capabilities

- `scripts/stow.sh`: No longer links herdr agent definitions into `~/.pi/agent/`. Removes stale herdr skill/extension symlinks during stow.
- `pi/bin/herdr-workflow`: `SKILLS` constant and extension paths now reference `agent-definitions/` instead of `~/.pi/agent/`.
- `scripts/test-plugin-system.sh`: Test scaffolding uses `agent-definitions/` paths.

## Impact

- `scripts/stow.sh` — modified to skip `agent-definitions/` and clean stale symlinks.
- `pi/bin/herdr-workflow` — `SKILLS` constant and `pi_arguments()` extension paths updated.
- `agent-definitions/` — new directory, herdr agent definitions moved into it.
- `pi/skills/herdr-*` — removed (moved to `agent-definitions/`).
- `pi/extensions/herdr-*.ts` — removed (moved to `agent-definitions/`).
- `scripts/test-plugin-system.sh` — test setup handles `agent-definitions/`.
- `openspec/specs/scripts/spec.md` — update spec for new agent-definitions layout.
- `openspec/specs/pi-agent-plugin-system/spec.md` — update spec for new source path.
- `.pi/verifier/stow-installation.md` — update verifier policy for agent-definitions.
- User's `~/.pi/agent/skills/herdr-*` and `~/.pi/agent/extensions/herdr-*` stale symlinks are cleaned by updated stow.
