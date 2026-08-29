## 1. Workflow contracts and durable question state

- [x] 1.1 Extend `src/workflow/contracts.ts` with bounded developer-dialogue/question types, parser compatibility for snapshots missing the new field, authenticated question command input, answer action input, and validated workflow-view fields; verify malformed, oversized, legacy, and valid payload cases in focused contract tests.
- [x] 1.2 Implement transactional question creation, answer/cancel/expiry reduction, capability checks, FIFO pending ordering, dialogue bounds, and revision-safe `answer-question` action handling in `src/workflow/runtime.ts`; verify persistence across engine reload, concurrent requests, unauthorized requests, stale responses, and unchanged workflow lifecycle in `test/workflow-question.test.ts`.
- [x] 1.3 Add the managed-agent `workflow question` CLI operation and structured bounded wait/timeout path in `src/workflow/cli.ts`; verify it authenticates from the managed run environment, returns the matching option/custom/cancel result, and fails without hanging when no response arrives.

## 2. Assignment protocol and runtime tool delivery

- [x] 2.1 Add the shared dialogue section and `developer_question`/CLI fallback guidance to `agent-definitions/instructions/workflow-agent-protocol.md`, and include validated prior dialogue in `src/workflow/assignment.ts`; verify planner, worker, and security-verifier rendered assignments contain bounded untrusted history without tokens or content in telemetry.
- [x] 2.2 Add the bundled Pi `developer_question` extension under `agent-definitions/extensions/`, including its bounded schema, CLI invocation, cancellation/abort handling, and concise tool result rendering; extend `scripts/generate-embedded.ts` to embed it and verify the generated asset is materialized by the normal build path.
- [x] 2.3 Pass the trusted workflow extension path through `LaunchContext` and `src/workflow/effect-runner.ts`, and load it explicitly in `PiAdapter` from `src/workflow/adapters.ts` even for read-only verifier profiles while continuing to suppress user extensions there; verify adapter launch arguments and runtime-neutral OpenCode fallback behavior in focused adapter tests.

## 3. Dash projection and response modal

- [x] 3.1 Project pending questions and bounded dialogue from `WorkflowView` through `src/tui/dash/engine.ts` and `src/tui/dash/data.ts`, and add a dashboard response helper that submits the revision-bound answer action; verify stale responses refresh without losing the queue and current question ordering is preserved.
- [x] 3.2 Create `src/tui/dash/ui/DeveloperQuestionModal.tsx` using existing modal, selectable-list, and focused input patterns to show requester, description, recommendations, custom response, and cancellation controls; verify option selection, non-empty custom input, empty-input handling, and Escape cancellation at the renderer boundary.
- [x] 3.3 Integrate question discovery, modal precedence while busy, keymap routing, accepted-response progression, and refresh polling into `src/tui/dash/App.tsx`; verify a question created externally opens without a workflow phase gate, the modal remains responsive during effect draining, and queued questions are answered independently in `test/dash/developerQuestionModal.test.tsx`.

## 4. Focused integration validation

- [x] 4.1 Add focused tests covering the CLI/tool-to-engine round trip, assignment propagation to a later security verifier, content redaction from telemetry/diagnostics, and old snapshot loading; verify only change-relevant workflow and dash checks are required from the worker.
- [x] 4.2 Regenerate embedded assets and run `bun run type-check`, `bun run build`, and `bun run lint`; verify generated files are produced by the build and all diagnostics pass without running the repository-wide test suite from the implementation task.
- [x] 4.3 Run `openspec validate "$HERDR_CHANGE_ID" --strict` after all implementation tasks are complete; verify the new capability and both modified capability deltas validate against the approved artifact set.
