# Tasks: Make developer questions asynchronous

## 1. Bounded agent wait

- [x] 1.1 Add `AGENT_QUESTION_WAIT_MS` to `agentic-coding/src/workflow/runtime/dialogue.ts` with a doc comment naming it the agent-facing grace, shorter than `QUESTION_WAIT_MS`; verify the constant is exported and referenced.
- [x] 1.2 Default the agent-facing wait to it in `agentic-coding/src/workflow/cli/commands/dispatch-actions.ts` (`runQuestion` and `runAgentAsk`), and in the server's `agentQuestion` fallback; verify a bounded wait returns the pending record without expiring it.

## 2. Resume the blocked asking run

- [x] 2.1 Add `resumeBlockedAsker` to `agentic-coding/src/workflow/runtime/kernel.ts`: guard on parked workflow, matching current step, blocked asker run, and no active run for its role; bump the step attempt, `createRun` for the asking role, clear attention unless another run is blocked; verify with a focused engine test.
- [x] 2.2 Call it from `developer-action.ts` after an `answer-question` action returns an `answered` outcome, naming the resumed run in the recorded event data; verify both the developer and orchestrator principals resume.
- [x] 2.3 Call it from `agent-consult.ts`'s `agentAnswer` and pass `definition`/`registry` through from `runtime/engine.ts`; verify a peer answer resumes the blocked asker.
- [x] 2.4 Verify cancellation, expiry, and forwarding do not re-issue, and that an answer while the asker still works does not re-issue.

## 3. Orchestrator-routed questions keep a developer path

- [x] 3.1 Include orchestrator-routed pending records in `pendingDeveloperQuestions` (`runtime/view.ts`) with the comment updated to state why; verify the view lists a parked orchestrator-started question.
- [x] 3.2 Let the operator answer an orchestrator-routed question in `answerQuestion` (`runtime/dialogue.ts`), clearing the marker, while the orchestrator's guard stays unchanged; verify the reducer test for both actor directions.

## 4. Durable tool and host

- [x] 4.1 Pass the tool context's abort signal into `runWorkflowCli` in `agent-host/tools.ts` and update the `developer_question`/`agent_ask` descriptions for the pending result and the blocked handoff; verify an aborted call kills the child.
- [x] 4.2 Record a developer abort as a `blocked` handoff in `agent-host/host.ts` (`abort` only, never `stopRun`), best-effort, with `--no-drain`, guarded on a run identity being present; verify the guard and the failure path.
- [x] 4.3 Update `agent-definitions/instructions/workflow-agent-protocol.md` for the pending → `blocked` rule and the prior-dialogue answer, then regenerate the embedded asset with `bun run build` (never hand-edit `embedded.generated.ts`).

## 5. Focused validation

- [x] 5.1 Extend `agentic-coding/test/workflow-question.test.ts` with the resume, no-resume, and orchestrator backstop cases; run it.
- [x] 5.2 Run the focused agent-host and question suites from `agentic-coding/` and confirm they pass.
- [x] 5.3 Run `bun run lint`, `bun run type-check`, and the boundary suites from `agentic-coding/` and confirm zero diagnostics.
- [x] 5.4 Update `agentic-coding/docs/workflow-architecture.md` where it describes the dialogue tools and the durable host, and confirm the docs match the code.
