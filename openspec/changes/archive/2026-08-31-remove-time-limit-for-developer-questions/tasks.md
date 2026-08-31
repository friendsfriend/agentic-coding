## 1. Shared timeout policy

- [x] 1.1 Change `QUESTION_WAIT_MS` in `agentic-coding/src/workflow/runtime.ts` from five minutes to 24 hours, preserving its use for new questions' durable `expiresAt` values.
- [x] 1.2 Verify the authenticated question CLI in `agentic-coding/src/workflow/cli.ts` derives its default, upper-bound validation, and diagnostic from the shared 24-hour constant, while retaining positive shorter timeout overrides and rejecting values above the bound.

## 2. Focused regression coverage

- [x] 2.1 Extend `agentic-coding/test/workflow-question.test.ts` to assert a newly created question remains pending before 24 hours and expires at the 24-hour boundary, without changing lifecycle or authorization behavior.
- [x] 2.2 Add focused CLI coverage in `agentic-coding/test/workflow-cli.test.ts` (or the closest existing CLI test seam) for accepting the 24-hour timeout maximum and rejecting invalid or over-limit values without waiting in real time.

## 3. Validation

- [x] 3.1 Run the focused workflow question and CLI tests and confirm the new timeout and expiry scenarios pass.
- [x] 3.2 Run Biome checks and TypeScript type-checking for the changed workflow source and tests; resolve any diagnostics without modifying generated artifacts.
