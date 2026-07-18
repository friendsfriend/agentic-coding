- [x] **T1: Create `agent-definitions/` directory and move assets**
  - Create `agent-definitions/skills/` and `agent-definitions/extensions/`
  - Move `pi/skills/herdr-openspec-*/` → `agent-definitions/skills/herdr-openspec-*/`
  - Move `pi/extensions/herdr-telemetry.ts` → `agent-definitions/extensions/herdr-telemetry.ts`
  - Move `pi/extensions/herdr-workflow.ts` → `agent-definitions/extensions/herdr-workflow.ts`
  - Remove empty `pi/skills/herdr-*` dirs
  - Remove `pi/extensions/herdr-telemetry.ts` and `pi/extensions/herdr-workflow.ts` (was moved)
  - Verify `agent-definitions/` directory structure matches design

- [x] **T2: Update `pi/bin/herdr-workflow` path resolution**
  - Add `AGENT_DEF_DIR` constant resolving from script path to repo root's `agent-definitions/`
  - Change `SKILLS` from `AGENT_DIR / "skills"` to `AGENT_DEF_DIR / "skills"`
  - Update `pi_arguments()` extension references from `AGENT_DIR / "extensions"` to `AGENT_DEF_DIR / "extensions"`
  - Verify `pi_command()` logic produces correct paths for all roles

- [x] **T3: Update `scripts/stow.sh` to clean stale herdr symlinks**
  - Add cleanup loop after `link_tree` calls to remove stale `herdr-openspec-*` skill symlinks and `herdr-telemetry.ts`/`herdr-workflow.ts` extension symlinks from `~/.pi/agent/`

- [x] **T4: Update `scripts/test-plugin-system.sh`**
  - Change test scaffolding to reference `agent-definitions/skills/` and `agent-definitions/extensions/` instead of `~/.pi/agent/skills/` and `~/.pi/agent/extensions/`
  - Update assertions in plugin list tests to expect the new paths

- [x] **T5: Update specs and verifier policy**
  - `openspec/specs/scripts/spec.md`: Add scenario "Herdr agent definitions are isolated from pi discovery"
  - `.pi/verifier/stow-installation.md`: Add `agent-definitions/` as exempt from stow coverage. Add rule that herdr-specific agent definitions load by explicit path, not pi discovery.

- [x] **T6: Update `openspec/specs/pi-agent-plugin-system/spec.md` path references**
  - Change extension path references from `~/pi/agent/extensions/` to `agent-definitions/extensions/` where they describe internal herdr tooling (not user plugin extensions)

- [x] **T7: Manually verify the split**
  - Run `scripts/stow.sh` and confirm no herdr skill/extension symlinks remain in `~/.pi/agent/skills/` or `~/.pi/agent/extensions/`
  - Run `pi --version` from repo and confirm herdr skills are not in system prompt
  - Tear-down: revert stow changes and verify cleanup
