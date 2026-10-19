## 1. Server policy and configuration

- [x] 1.1 Delete the active-count and trailing-24 h checks and the
  `409 orchestrator-limit` refusal from `src/server/orchestrator-policy.ts`, and
  the launch guard from the `/api/v1/workflow/start` route; keep ownership,
  provenance, preset/mode guards and the human-review gate pin.
- [x] 1.2 Remove the `limits` table from `OrchestratorConfig`, delete
  `OrchestratorLimitsConfig`/`OrchestratorLimits`/`orchestratorLaunchLimits`, and
  let `parseAgentsConfig` refuse a `limits` key with its normal
  `unsupported key limits` error.
- [x] 1.3 Delete `src/workflow/runtime/orchestrator-launches.ts` and every
  consumer (`orchestratorLaunchCeiling`, the agents read field, the transport
  operation, the contracts).
- [x] 1.4 Remove the Settings inventory entry, the `agents.launch-limits` row,
  the `AgentStatus`/`AgentConfigEntry` limit fields and their plumbing.

## 2. Events and guidance

- [x] 2.1 Remove `limit.hit` from the workflow event contract (id, payload
  schema, category and severity) and delete `recordLimitHit` from the event bus;
  the bus no longer special-cases a workflow-less event.
- [x] 2.2 Remove the launch-ceiling sentences from the orchestrator docs, the
  event-catalog docs and the Settings inventory; confirm no orchestrator prompt
  or tool description names a ceiling.

## 3. Tests

- [x] 3.1 Delete the launch-ceiling tests (policy, transport, config parse,
  Settings row, `orchestrator-launches.test.ts`) and the `limit.hit` event-bus,
  subscription and monitor cases; keep the generic bounded-log, filtering and
  delivery coverage through derived `workflow.started` events.
- [x] 3.2 Add a transport test that an orchestrator start is not refused while a
  very large number of workflows already exist, and a config test that a
  `[agents.orchestrator.limits]` table is rejected with an error naming `limits`.

## 4. Verification

- [x] 4.1 `bun run type-check` 0 errors, `bun run test` passes, and
  `bun run lint` is clean on the changed files.
- [x] 4.2 `openspec validate "2026-10-18-remove-orchestrator-launch-limits" --strict`
  and `openspec validate --specs --strict` pass.
- [x] 4.3 Grep `src/`, `test/`, `docs/` and `openspec/specs/` for
  `max_active`, `max_starts_per_day`, `maxActive`, `maxStartsPerDay`,
  `orchestratorLimits`, `OrchestratorLimits`, `orchestrator-limit`,
  `recordLimitHit`, `limit-hit`, `Launch limits` and `launch limit`: no matches
  remain outside the archived changes and the two deliberate rejection tests.
