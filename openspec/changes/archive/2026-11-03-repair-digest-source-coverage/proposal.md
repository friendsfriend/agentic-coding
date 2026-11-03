## Why

The daily digest returned Wiz only despite required Jira, GitLab and production-log coverage. JSON-only parsing, absent source bindings and incomplete pagination make successful delivery misleading and the analysis insufficiently actionable.

## What Changes

- Repair source adapters against actual connector schemas and support explicit partial coverage.
- Collect bounded, read-only Jira, authorized local-repository GitLab, verified production logs and paginated Wiz evidence.
- Lead reports with prioritized cross-source analysis and group repetitive evidence without losing identities.
- Provide an operator-applied migration for the existing stored task/session binding without changing live state during implementation.
- Preserve schedule, nominal windows, session behavior and collection/destination safety fences.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `daily-task-digest`: actual connector response adaptation; complete-or-explicitly-bounded Jira/Wiz/local GitLab collection; evidenced MR activity beyond creation; verified iConnect production log analysis; grouped evidence and prioritized cross-source recommendations; prominent coverage verdict independent of delivery success; supported nonactivated update of an existing collection session and stored digest task.

## Impact

Scheduling digest source contracts, collection policy/extension, report tool, setup/session commands, their focused tests and daily digest documentation. No live session/job/config mutations, credential changes or duplicate schedules.
