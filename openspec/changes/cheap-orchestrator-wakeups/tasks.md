## 1. Pure resolution helpers

- [ ] 1.1 Add `src/agent-host/orchestrator-resolve.ts` with `rankSimilarIds(ids,
  wanted, limit)`: score by shared lowercase token overlap first and edit distance
  second, drop zero-score ids, cap the answer at 5 and report the remaining count;
  plus `decodeWorkflowIds(value)` (one id or an array, at most 8, duplicates
  dropped) and `decodeSinceRevisions(value, ids)` (one number for every id, or a
  per-id map). No I/O, no Effect wrapper: these are pure functions.
- [ ] 1.2 Add `src/workflow/startup.ts` `resolveTaskReference(repo, ref)`:
  path form inside `<repo>/openspec/changes/<id>` (refusing `..`, escapes and
  `archive/**`), exact id, then prefix, then substring; one match resolves, more
  than one is refused as ambiguous with the matches named, none is refused with
  `rankSimilarIds`-style candidates bounded to 5 plus a `(+n more)` count; the
  refusal is one line with no file content.
- [ ] 1.3 Build the task text from whole `##` sections of `proposal.md` in file
  order, then `tasks.md`'s checkbox list, capped at the existing 16,000-character
  task bound; drop a section that does not fit whole and name it in a trailing
  `[task truncated: …]` marker.

## 2. Start from a reference

- [ ] 2.1 Add `taskRef: Schema.optional(Schema.Struct({ change: Schema.String }))`
  to `workflowStartRequestSchema` (`src/contracts/actions.ts`), carry it through
  `StartRequest`/`startArgs` into `WorkflowStartRequest` (`src/workflow/startup.ts`),
  and refuse a request that carries both `task` and `taskRef`.
- [ ] 2.2 Resolve the reference in `prepareWorkflowStart` before the start guard
  and return `{ change, taskChars }` on `PreparedWorkflowStart`, so the resolved
  text is the task every rule and review already sees; append
  `— task from change "<id>", <n> task chars` to the built-in start answer and to
  the blueprint start answer.
- [ ] 2.3 Make `start_workflow`'s `task` optional and add `taskRef` as a union of
  `{ change }` and `{ previousMessage }`; refuse both/neither locally with one
  line naming both parameters; send `taskRef` for a change reference and echo the
  server's message unchanged.
- [ ] 2.4 Record the session's last developer message in `DurableHost.submit`
  (excluding `[workflow-monitor]` notes and the abort marker), expose it on
  `DurableRunContext` as `lastDeveloperMessage?: () => string | undefined`, and
  substitute it as `task` for `{ previousMessage: true }`, appending
  `— task from the previous developer message, <n> task chars`; refuse with one
  line naming `task` and `taskRef.change` when the session has none.

## 3. The change listing

- [ ] 3.1 Add the `{ kind: "openspec-changes", repo }` observation to the contract
  (`src/contracts/environment.ts`) and to `runLocalObservation`
  (`src/server/operations/observations.ts`): one compact row per active change —
  `changeId`, first heading of `proposal.md` (bounded read, 80 characters),
  `tasks` as `<checked>/<total>` when the change has checkboxes, `path` as
  `openspec/changes/<id>` — sorted by id, at most 100 rows, empty list when the
  directory is missing. Reuse `discoverChanges`; leave `{ kind: "changes" }`
  untouched.
- [ ] 3.2 Mark a change a non-closed workflow of that repository already
  implements, joining the repo-scoped workflow views on the recorded change id
  (falling back to the workflow id) and reporting `workflowId` + `status`.
- [ ] 3.3 Add the `list_changes` orchestrator tool: `repo` required (the same
  target parameter the other tools take), optional `limit`, one "Use to …"
  description line, and an answer that passes the rows through unchanged.

## 4. One identifier and keyed polls

- [ ] 4.1 Make `workflow_status`'s `repo` optional: when it is omitted, resolve
  each id's repository from `observe { kind: "workflows" }` (one read for the
  call), answer one row per repository when an id exists in several, and keep the
  single-id single-repository answer identical to today's.
- [ ] 4.2 Widen `workflowId` to `string | string[]` (at most 8) and
  `sinceRevision` to `number | Record<id, number>`; answer one id exactly as today
  and several ids as an array in the requested order, with `workflowId` named on
  each `unchanged` short-circuit; keep `detail`/`includeTask` working for both.
- [ ] 4.3 Answer an unknown id instead of failing it: one entry naming the id,
  `unknown: true` and the bounded candidates from `rankSimilarIds` over the
  board's ids (plus `more` when the list was capped), and point the description at
  `list_workflows` for the no-candidate case.
- [ ] 4.4 Update the `start_workflow`, `workflow_status` and prompt text of
  `ORCHESTRATOR_PROMPT` where they now differ, keeping every addition to one
  sentence and never touching the `read`/`grep`/`bash` descriptions owned by
  `orientation-budget-and-tool-names`.

## 5. Tests

- [ ] 5.1 `test/agent-host-orchestrator-resolve.test.ts`: closest-id ranking
  (`add-environment-instances` → `add-environment-instance-lifecycle` first;
  token-overlap case; empty and capped lists), id/revision decoding, and the
  multi-id answer shape including the per-id `unchanged` entry.
- [ ] 5.2 A focused startup test (extend the existing start-guard test file or add
  `test/workflow-start-task-reference.test.ts` with temp repositories): change id
  and path resolve, resolved task text is proposal sections + tasks checkboxes,
  truncation marker, ambiguous prefix refused with matches, unresolved refused
  with candidates, archived change refused, and `cleanTreeRefusal` bounded at 20
  paths plus `(+n more)`.
- [ ] 5.3 `test/agent-host-orchestrator.test.ts`: a `taskRef: { change }` call
  sends `taskRef` and no `task` and relays the echo; `{ previousMessage: true }`
  sends the submitted developer text and echoes its source and length; no previous
  message and both/neither are refused locally; a dirty-tree refusal is relayed
  verbatim by `start_workflow`.
- [ ] 5.4 `test/agent-host-orchestrator.test.ts` / `-compact.test.ts`: a
  `workflow_status` poll without `repo` resolves from the board, an unknown id
  answers with candidates, three ids poll in one call with per-id
  `sinceRevision`, and the existing single-id assertions still pass unchanged.
- [ ] 5.5 A focused observation test for `{ kind: "openspec-changes" }`: rows for
  a temp repository, the in-flight mark, the empty answer without the directory,
  and the unchanged `{ kind: "changes" }` id list.

## 6. Finishing

- [ ] 6.1 Run `bun run type-check`, `bun run lint`, and the focused suites
  (`bun test test/agent-host-orchestrator-resolve.test.ts
  test/agent-host-orchestrator.test.ts test/agent-host-orchestrator-compact.test.ts
  test/workflow-start-task-reference.test.ts test/agent-host-tools.test.ts`) with a
  temporary `HOME`, `AGENTIC_CODING_CONFIG_DIR` and `HERDR_WIKI_DIR`; fix every
  diagnostic. Do not run the repository-wide suite: the engine-owned test-verifier
  does that.
- [ ] 6.2 Record the verification plan from `design.md` (the `failed-chains`
  checks for `read` and `workflow_status`, `start_workflow` argument bytes and the
  refusal count, with the baselines 58/479 failed calls, 22 ENOENT, 163,350 B and
  12 refusals, and the targets ENOENT < 3, refusals < 4, args < 40 kB) in the
  change, and confirm `openspec validate --changes --strict` passes.
- [ ] 6.3 Commit as one logical change with a clean `git status --short`; leave
  `embedded.generated.ts` alone unless a build regenerates it for something this
  change touches.
