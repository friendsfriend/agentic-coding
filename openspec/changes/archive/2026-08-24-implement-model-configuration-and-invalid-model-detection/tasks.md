## 1. Model availability detection

- [x] 1.1 Add runtime model enumeration helper (parse `pi --list-models`, `opencode models`, `opencode2 models` into `Set<string>` of `provider/id`) with per-process caching in `src/workflow/profiles.ts` or a new module, plus parser tests for each runtime's output format
- [x] 1.2 Extend `preflightProfile` with model availability validation (strip pi `:<thinking>` suffix; fail closed on enumeration failure with actionable error naming profile, runtime, invalid model)
- [x] 1.3 Wire preflight coverage check in both start paths (`src/tui/dash/engine.ts`, `src/workflow/cli.ts`) and add tests for unknown-model startup failure

## 2. Preset schema and resolution

- [x] 2.1 Extend `parseAgentsConfig` to parse and validate `[agents.presets]` (existing-profile references, single entry per step/role) with error tests
- [x] 2.2 Add preset-aware resolution to `profileFor`/`resolveRouting` (preset roles → preset steps → preset default → existing chain) via optional per-start override parameter
- [x] 2.3 Implement preset coverage validation at start against the definition's agent steps (fail with uncovered step + preset name) with tests

## 3. Config persistence

- [x] 3.1 Add config write-back helper in `src/workflow/effects.ts`: resolve the source file of the edited agents section (HERDR_WORKFLOW_CONFIG > user > project), create user config if absent, read-modify-write via `Bun.TOML.stringify`
- [x] 3.2 Round-trip test: load → modify presets/profiles → save → reload preserves profiles, presets, routes, and unrelated sections

## 4. New workflow modal integration

- [x] 4.1 Add "Agent preset" list step to `NewWorkflowModal.tsx` (presets from config + "(config defaults)" entry) and thread selection through `startArgs`
- [x] 4.2 Apply selected preset as routing override in `startWorkflowInProcess`; add `--preset <name>` flag to CLI workflow start; test that started workflows pin preset-resolved routing
- [x] 4.3 Update dashboard help text for the new step

## 5. Home dashboard management UI

- [x] 5.1 Create `ModelConfigModal.tsx` with Profiles/Presets lists, key binding from Home, and help entry
- [x] 5.2 Profile editor flow: name, execution env select, model select fed by runtime enumeration, optional agent name (opencode/opencode-v2) and thinking level (pi); create/edit/delete with referenced-profile delete refusal
- [x] 5.3 Preset editor flow: per-step and per-verification-role profile assignment plus preset default; create/edit/delete persisted via write-back helper

## 6. Validation and docs

- [x] 6.1 Run `bun run lint`, `bun run type-check`, and full test suite; fix findings
- [x] 6.2 Update README / `pi/herdr-workflow.toml` example with `[agents.presets]` documentation
