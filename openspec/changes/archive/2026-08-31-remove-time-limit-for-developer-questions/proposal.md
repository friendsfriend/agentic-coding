## Why

Managed agents currently have only five minutes to receive developer guidance. That window is too short when the developer is in a meeting or otherwise temporarily unavailable, causing otherwise valid implementation, planning, or verification work to stop and questions to expire prematurely. Extending the bounded wait to 24 hours preserves automatic cleanup while supporting long-running workflows.

## What Changes

- Extend the shared developer-question timeout and persisted question expiry from five minutes to 24 hours.
- Permit the CLI question timeout override to use any positive duration up to 24 hours.
- Preserve the existing authenticated question flow, explicit cancellation behavior, and automatic expiry after the 24-hour bound.
- Add focused regression coverage for the 24-hour default, maximum, validation boundary, and persisted expiry behavior.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `workflow-developer-question`: Increase the maximum/default bounded wait for agent questions from five minutes to 24 hours while retaining expiry and cancellation semantics.

## Impact

- `agentic-coding/src/workflow/runtime.ts`: shared question wait constant and persisted `expiresAt` calculation.
- `agentic-coding/src/workflow/cli.ts`: timeout validation and default used by the authenticated question command.
- `agentic-coding/test/workflow-question.test.ts` and relevant CLI tests: focused timeout and expiry regression coverage.
- No external API, dependency, schema, or dashboard interaction changes are expected.
