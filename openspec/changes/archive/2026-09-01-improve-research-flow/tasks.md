## 1. Handoff contract and recording action

- [x] 1.1 Add a dedicated handoff contract (subject required; canonical target optional; findings/outline required; source citations required unless explicitly stated no external sources were used) in `agentic-coding/src/workflow/definitions.ts`, following the existing `core.findings`-style dedicated-contract pattern, and verify with a focused unit test that valid payloads parse and payloads missing subject/findings/citations are rejected.
- [x] 1.2 Add an authenticated action, restricted to the active `core.research` researcher run (mirroring the run-scoped authorization already used for `wiki write`), that validates a submitted handoff against the new contract and stores it in `snapshot.step.context.handoff` in `agentic-coding/src/workflow/runtime.ts`, without transitioning the step, ending the run, or creating a new run generation. Verify with a focused test that recording a handoff does not change `currentStep`, run status, or run generation.
- [x] 1.3 Allow re-recording: verify with a focused test that a second valid submission overwrites the previously recorded handoff for the same active run rather than erroring or accumulating duplicates.
- [x] 1.4 Expose the recording action to the researcher's runtime/CLI surface consistently with how `research-follow-up` and `wiki write` are exposed to their respective roles, and verify the command is reachable and rejected for any role/run other than the active `core.research` researcher.

## 2. Gate `request-research-wiki` on a valid handoff

- [x] 2.1 In the `request-research-wiki` handler in `agentic-coding/src/workflow/runtime.ts`, validate `snapshot.step.context.handoff` against the contract from 1.1 before any other check (before `validateSourceBaseline`, workspace checks, and active-run lookup), and throw an actionable `WorkflowRuntimeError` when it is missing or invalid. Verify with a focused test that dispatching without a recorded handoff is rejected, the researcher run is not expired or stopped, and the workflow remains at `core.research`.
- [x] 2.2 Remove the current best-effort optional read of `researcher.outputPath` for a "summary" (the size-capped try/catch path) now that a validated handoff is required, and verify with a focused test that a valid handoff is used even when the researcher run never wrote to its own output path.
- [x] 2.3 Verify with a focused test that when a valid handoff exists, `request-research-wiki` still expires the researcher run, stops its session, and transitions to `core.wiki` only after the handoff check passes (matching the existing expire/stop/transition ordering).

## 3. Wiki stage receives the full handoff

- [x] 3.1 Update the `core.wiki` assignment/context construction in `agentic-coding/src/workflow/assignment.ts` (and `runtime.ts`/`effect-runner.ts` where the research-to-wiki context is assembled) to include the full recorded handoff (subject, canonical target, findings/outline, citations) alongside the existing `task` and repository context, replacing the previous truncated `followUps`-only fallback. Verify with a focused test that the `core.wiki` run's assignment content contains the recorded handoff fields verbatim.
- [x] 3.2 Verify with a focused test that recording a handoff, by itself, writes no centralized wiki concept and leaves any supplied repository unchanged.

## 4. Agent instructions

- [x] 4.1 Update `agent-definitions/instructions/research.md` so the "Wiki drafting handoff" section requires recording the structured handoff (subject, canonical target if known, outline, citations) as the explicit first step once the user asks for a wiki entry, before telling the developer that `request-research-wiki` is available, and clarifies that the action fails until a valid handoff is recorded.
- [x] 4.2 Update `agent-definitions/instructions/wiki.md` to state that the assigned task now includes a researcher-recorded handoff as authoritative research-provided input, without changing the existing update-first search/write conventions or verification boundaries. Verify both instruction files render/parse correctly wherever `agent-definitions/instructions/*.md` is validated (e.g. existing instruction-loading test or lint step already used for these files).

## 5. Spec and focused regression coverage

- [x] 5.1 Confirm `openspec/specs/research-workflow/spec.md` matches the delta in this change once applied, and run `openspec validate improve-research-flow --strict` before implementation is considered complete.
- [x] 5.2 Add or update focused tests in `agentic-coding/test/workflow-runtime.test.ts` covering: recording a handoff mid-session, rejecting `request-research-wiki` without one, accepting it with one, and the wiki assignment containing the full handoff content — run just this test file (not the full repository suite) to confirm these scenarios pass.
