## Context

See `proposal.md` for the motivation and user-facing scope. The current workflow is authoritative in the repository's Bun SQLite store and exposes a validated `WorkflowView`; the dash is an in-process observer/action client, while managed agents run in Herdr panes and receive rendered Markdown assignments. Existing credential prompting demonstrates that a long-running operation can wait on a dashboard-owned response, and existing OpenTUI modal/list/input components provide the interaction primitives.

The question path must work across concurrent runs, must not turn runtime idleness into lifecycle completion, and must preserve the engine's capability and revision boundaries. The shared answer must reach agents launched after the question, including read-only security verifiers.

## Goals / Non-Goals

**Goals:**

- Provide a named `developer_question` tool for Pi-managed agents and a runtime-neutral CLI fallback for other managed runtimes.
- Keep request creation, answer acceptance, ordering, and history in the transactional workflow engine.
- Show one pending question at a time in the dash, with recommended options and custom text input, without blocking ordinary engine effect draining.
- Make bounded prior question/answer context available to every later assignment and identify it as untrusted developer context.
- Fail closed for invalid/stale/unauthenticated requests and avoid leaking question contents into telemetry or capability diagnostics.

**Non-Goals:**

- Adding a new workflow phase, successor transition, verifier role, or automatic plan mutation.
- Replacing existing developer review, plan approval, credential prompting, or workflow action modals.
- Persisting an unbounded transcript or exposing a generic chat system outside a workflow.
- Adding a custom plugin implementation for every third-party runtime; runtimes without Pi-style extensions use the shared CLI interface described in assignments.

## Decisions

### 1. Use the workflow store as the question broker

Add a bounded `developerDialogue` collection to canonical workflow snapshot state. Each record contains an ID, active requester run/step/role, description, recommended options, status, answer kind/value, and timestamps. Add an authenticated agent question command to create a pending record and a revision-bound `answer-question` developer action to answer it. The validated `WorkflowView` exposes pending records and the bounded history.

This keeps the feature within the existing `dispatch` transaction, event log, CAS revision checks, and capability authorization. A FIFO/file/socket broker was rejected because it would duplicate lifecycle authority, be difficult to recover after dashboard restart, and make concurrent responses or stale answers ambiguous. The workflow does not transition to a new phase: the requesting run remains active while its tool invocation waits, so a runtime status change cannot falsely complete the run.

Question and answer validation uses strict limits for description, option count/labels/values, response length, and total retained dialogue bytes. The engine rejects new records when bounds are exceeded rather than silently pruning prior decisions. Answer events contain only question identity and outcome metadata; content stays in the validated workflow view/state needed by assignments and is not copied into telemetry.

### 2. Keep the agent interface portable while providing a real Pi tool

Add a bundled Pi extension asset that registers `developer_question` with a TypeBox schema for a description and recommended option objects. Its execution invokes `agentic-coding workflow question` using the managed environment, waits for the structured result, and renders a concise tool result. The CLI resolves the active run from `HERDR_WORKFLOW_ID`, `HERDR_STEP_ID`, `HERDR_ROLE`, and `HERDR_RUN_TOKEN`; agent-supplied workflow, role, recipient, and successor fields are ignored or rejected.

The extension is a trusted workflow asset, not a user extension: adapter launch wiring passes it explicitly even for read-only verifier profiles while retaining the existing restriction on user extensions. Asset generation includes the new extension and normal build materialization handles source and compiled binaries. The common assignment protocol documents the same CLI invocation as a fallback for OpenCode and future runtimes that do not provide the Pi custom-tool API. This avoids pretending runtime plugin APIs are equivalent while ensuring every managed role has an authenticated path.

The question command polls canonical view state at a bounded interval and returns the matching answer, cancellation, or timeout. It performs no direct database writes outside the engine dispatcher. A timeout/aborted wait resolves the request as expired/cancelled through the engine so an unavailable dashboard cannot leave a run blocked forever.

### 3. Treat prior dialogue as scoped, untrusted assignment context

Assignment rendering appends a bounded, clearly delimited developer-dialogue section after normal step inputs. It includes ordered answered records and requester identity, but no run tokens. The shared protocol instructs all roles to use the answer as decision context, not executable instructions, and to ask early when the plan or findings leave an important ambiguity. Since assignment rendering is shared by all roles, security verifiers receive the same history without a special security-only channel. The validated view also exposes the history for dash inspection and runtime-neutral tooling.

### 4. Make the dash a response client, not a second broker

Project the pending dialogue records from `WorkflowView` through the existing dash data/engine mapping. Add a `DeveloperQuestionModal` built from `GenericModal` and the existing selectable/input patterns. It shows requester role, description, options, a custom-response choice, and cancel help. App key handling owns selection, input focus, submit, and Escape behavior; it submits `answer-question` with the current revision and exact question ID.

Pending questions are checked independently of phase gates and busy/review modal state. The dashboard polls/refetches often enough to detect a question created by an agent process, while the existing file watcher and refresh behavior remain in place. Only the oldest pending question is active; after an accepted response the next one is rendered. A stale revision or question response causes a refresh and leaves the current queue intact. The modal never writes snapshot files or infers completion.

### 5. Validate at the boundaries and test the waiting edges

Extend contract parsing for question commands, snapshot/view dialogue fields, and answer action input. Runtime tests cover capability rejection, malformed/oversized input, concurrent FIFO records, answer CAS/stale responses, persistence across reload, timeout/cancellation, and assignment propagation to a security-verifier role. Adapter/asset tests cover trusted extension injection for read-only Pi and the unchanged runtime-neutral launch path. Renderer tests cover option selection, custom input, cancellation, modal discovery while busy, and queued questions. Focused checks are preferred; type-check and build catch generated asset and runtime integration errors.

## Risks / Trade-offs

- [An agent process can disappear while its question is pending] → Store a bounded pending record, expire it from the waiting command, and have the dash show only active/unexpired requests; stale run capability checks prevent unrelated answers.
- [A dashboard restart can leave a valid question waiting] → Keep the record in canonical SQLite and rediscover it from `WorkflowView` on every load; never rely on in-memory promises as the source of truth.
- [Developer text can contain prompt-injection-like instructions] → Delimit and label dialogue as untrusted context in every assignment; never interpret it as an engine command or capability.
- [Read-only profiles currently suppress extensions] → Inject only the signed/bundled workflow extension explicitly, while preserving `--no-extensions` for user-discovered extensions and testing that policy boundary.
- [Large history can inflate assignments] → Enforce total dialogue bounds before persistence and render only the bounded validated history; reject overflow rather than silently losing a decision.
- [OpenCode lacks the same custom-tool loading contract] → Make the CLI fallback part of the shared protocol and keep the engine semantics independent of the runtime adapter; a native OpenCode plugin can be added later without changing state or answer contracts.

## Migration Plan

No data migration is required for new installations. Older snapshots that lack `developerDialogue` load it as an empty collection through the existing snapshot parser. Implement the contract/view changes first, then the bundled tool and adapter wiring, then dash presentation. Regenerate embedded assets during the normal build. Rollback is safe before any question is created; for deployed binaries, an in-flight question remains bounded and is marked cancelled/expired if the answering client or tool is removed.
