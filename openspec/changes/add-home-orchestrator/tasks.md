# Tasks

## 1. Server boundary

- [x] 1.1 Add the `orchestrator` principal and `orchestratorTokenFor` to `src/server/auth.ts`. Verify with `test/orchestrator.test.ts` (derived, distinct, verified).
- [x] 1.2 Add `src/server/orchestrator-policy.ts` and enforce it in `src/server/app.ts` (403 `orchestrator-forbidden` routes; refused review actions). Verify with the transport tests in `test/orchestrator.test.ts`.
- [x] 1.3 Pin the plan, developer and wiki gates for orchestrator starts (`withHumanReviewGates`, `enforceHumanReviewGates` start option). Verify the operator path is unchanged and the wire field is rejected.

## 2. Orchestrator host and tools

- [x] 2.1 Add orchestrator mode to the durable host (`--orchestrator`, `orchestrator` tool policy, extension isolation). Verify with `test/agent-host-orchestrator.test.ts`.
- [x] 2.2 Add the orchestrator tools and prompt (`src/agent-host/orchestrator.ts`). Verify a scripted `list_projects` call reaches the server with the orchestrator capability and `bash` is unavailable.

## 3. Shell page and setting

- [x] 3.1 Add the `orchestrator` route, the Home destination and the page (`src/tui/orchestrator/`), with `/new` and its keybind catalog. Verify with `test/app/pages.test.ts` and in the TUI (footer and `?` help).
- [x] 3.2 Add `[agents.orchestrator]`, the `set-orchestrator` mutation and the Settings → Agent Presets picker. Verify the setting persists and the reopened session shows the model.
- [x] 3.3 Run `bun run lint`, `bun run type-check` and the focused suites with zero new failures.
