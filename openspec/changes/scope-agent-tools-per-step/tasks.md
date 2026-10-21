## 1. Tool groups per step

- [ ] 1.1 Define the tool-group ids and add a step behavior hook declaring them; default to every group.
- [ ] 1.2 Make `installWorkflowExtensions`/`toolSelectionFor` install only the declared groups for a workflow run.
- [ ] 1.3 Tests: per step, the offered tool names match the declaration; an undeclared step gets every group; the `codemode` section lists only offered tools.

## 2. Description trims

- [ ] 2.1 Trim `otel_query`, `stage_login`, `stage_info`, `browser_open`, `browser_run_script`, `env_start` descriptions to their contract; update tests that pin description text.
- [ ] 2.2 Add system-side tool-definition budgets per family to the `slim-agent-prompts` budget table; re-run the inventory with `--system` and record the before/after.
- [ ] 2.3 Focused checks (`bun test` on touched files, `bun run lint`, `bun run type-check`); rebuild and restart; manual run per family.
