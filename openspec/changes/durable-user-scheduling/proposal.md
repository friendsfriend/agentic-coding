## Why
Deferred checks currently depend on an interactive conversation remembering to act. Users need durable, explicit scheduling with safe admission and visible results, shared between tools and the manual shell.

## What Changes
- Separate reusable jobs from once, interval and timezone-aware calendar schedules.
- Persist occurrences and recover idempotent admissions for conversation wake-ups, isolated standalone agents and supported workflow launches.
- Add shared management APIs and a full manual Schedules surface, including history, policy and service availability.
- Preserve human gates and existing execution restrictions; do not promise OS wake-up or new authority.

## Capabilities

### New Capabilities
- `durable-scheduling`: Persistent scheduling, target admission, management surfaces and recovery policy.

### Modified Capabilities
None; existing execution and review contracts remain authoritative.

## Impact
Background server lifecycle, storage, orchestrator tools/guidance, execution admission adapters and shell navigation/help. Exact integration boundaries will be recorded in design after scoped inspection. One primary change includes all three targets and the manual UI; no reduced backend-only follow-up.
