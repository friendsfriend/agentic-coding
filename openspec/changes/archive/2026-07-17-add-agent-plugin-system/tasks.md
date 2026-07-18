- [x] **T1: Modify `pi_command()` for unrestricted roles**
  - Change `pi/bin/herdr-workflow` to classify planner/worker as unrestricted
  - Drop `--no-extensions`, `--no-skills`, and `--tools` restriction for those roles
  - Keep restricted behavior for verifiers, triage, recovery, archive
  - Ensure `herdr-telemetry.ts` extension is still loaded for all roles (including unrestricted)

- [x] **T2: Add exclusion config support**
  - Define `[plugins]` section schema in `herdr-workflow.toml`
  - Parse exclusions and pass `--exclude-extensions` for unrestricted roles
  - Support per-role overrides under `[plugins.roles.<role>]`
  - Fall back to empty exclusion list if config section is absent

- [x] **T3: Implement `herdr-workflow plugin list` command**
  - Discover extension files from pi standard locations
  - Cross-reference with exclusion config
  - Display extensions with their role status (active/excluded per role)

- [x] **T4: Implement `herdr-workflow plugin install` command**
  - Wrap `pi install <source>` to install the package
  - Accept `--worker`/`--planner` flags to record role assignments
  - Store metadata in `~/.pi/agent/plugin-assignments.json`

- [x] **T5: Implement `herdr-workflow plugin install-local` command**
  - Copy/symlink a local `.ts` extension into `~/.pi/agent/extensions/` or `.pi/extensions/`
  - Accept `--worker`/`--planner` flags to record role assignments
  - Store metadata in `plugin-assignments.json`

- [x] **T6: Integration test**
  - Create a test extension that registers a tool
  - Verify it's callable in planner/worker agent sessions
  - Verify it's NOT available in verifier sessions
  - Verify exclusion config removes it from unrestricted roles
