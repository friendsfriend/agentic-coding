## 1. Default model routing

- [x] 1.1 Replace the shipped agent catalog in `pi/herdr-workflow.toml` with only the documented `use-default-model` preset and its default Pi harness; update README guidance and verify the template contains no shipped profiles, routes, or model-specific presets.
- [x] 1.2 Make agent configuration parsing accept absent custom profiles and global defaults while retaining compatible parsing of valid legacy configuration and validating the built-in preset's `pi`, `opencode`, or `opencode-v2` harness; verify focused profile-configuration tests cover empty, legacy, valid harness, and invalid harness inputs.
- [x] 1.3 Implement the reserved `use-default-model` fallback through preset resolution, coverage checks, and pinned routing so its configured harness produces launch data without `model`; verify Pi, OpenCode, and OpenCode V2 adapter tests assert fallback launches omit `--model`.
- [x] 1.4 Reserve the built-in name from conflicting custom profile/preset definitions; verify invalid conflicts return a clear configuration error.

## 2. Dashboard configuration management

- [x] 2.1 Update new-workflow preset choices and model-configuration lists to expose the immutable built-in preset while showing only persisted custom entries as editable/deletable; verify focused OpenTUI tests cover a fresh configuration and custom-entry management.
- [x] 2.2 Stop profile and preset saves from creating or depending on `agents.default_profile`; verify a first custom profile/preset persists without a global default and remains selectable after reload.
- [x] 2.3 Reproduce the Linux configuration-edit failure and harden the shared configuration read/write seam for canonical, legacy, project-overlay, environment-selected, and symlinked targets; verify successful writes preserve unrelated TOML and failed/conflicting writes notify without changing the source.

## 3. Regression coverage and validation

- [x] 3.1 Extend workflow model-config, adapter, and dashboard modal tests for model-less routing through each configured harness, no-custom-config startup, built-in-preset protection, and Linux write-back behavior; verify `cd agentic-coding && bun test test/workflow-model-config.test.ts test/workflow-adapters.test.ts test/dash/modelConfigModal.test.tsx` passes.
- [x] 3.2 Run project quality checks after implementation; verify `cd agentic-coding && bun run lint && bun run type-check` passes and `openspec validate refine-preset-and-profile-management --strict` succeeds.
