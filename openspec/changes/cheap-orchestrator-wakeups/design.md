## Context

The orchestrator is the one agent with a long-lived transcript: every byte a tool
returns and every byte the model writes as a tool argument is re-carried for the
rest of the session. Backlog items 4 and 5 already narrowed the *output* side
(`src/agent-host/orchestrator-compact.ts`: compact rows, compact JSON, the
`sinceRevision` short-circuit) and the clean-tree refusal already reports the
dirty paths (`src/workflow/startup.ts` `cleanTreeRefusal`, bounded to 20 paths
plus a count). What remains is the *input* side and the guessing, measured in
`docs/efficiency/02h-orchestrator.md`:

- 54 `start_workflow` calls / 163,350 B of arguments, 93 % of it `task` prose the
  developer had already written;
- `read` failed 24 of 41 times, 22 ENOENT, guessing
  `openspec/changes/<id>/proposal.md` in five repositories;
- wrong-id polls (`add-environment-instances` vs
  `add-environment-instance-lifecycle`) because `list_workflows` and
  `workflow_status` did not agree on one identifier.

The relevant current state:

- `src/agent-host/orchestrator.ts` holds the tool surface; every tool reaches
  the unified server only (`POST /api/v1/observe`, `GET /api/v1/workflow/view`,
  `POST /api/v1/workflow/start`, …) under the orchestrator capability
  (`src/server/orchestrator-policy.ts`).
- `observe` already answers `{ kind: "changes", repo }` with a bare id list (the
  new-workflow form reads it), and `src/server/operations/observations.ts` also
  owns `discoverChanges` and the OpenSpec artifact readers.
- `start_workflow`'s `task` is required and travels straight to
  `POST /api/v1/workflow/start` → `startWorkflowInProcess` →
  `prepareWorkflowStart` (`src/workflow/startup.ts`), which runs the family's
  start guard (clean tree, task, OpenSpec artifacts, branch rules) and then
  hands the input to the engine, whose own start guard repeats the rules.
- `workflow_status` requires `repo` + one `workflowId`; `list_workflows` returns
  `workflowId` and `target` per row from the same workflow board.
- A durable run's tool context (`DurableRunContext` in
  `src/agent-host/tools.ts`) carries the run id, cwd and env; it carries no
  conversation content, because `pi-durable`'s tool API does not expose the
  transcript.

Constraints carried from the workflow: `STORE_SCHEMA_VERSION` stays 6, no
migration and no compat shim; every answer stays compact (the additions are
opt-in or appear only on a refusal/start); tool descriptions keep the existing
"Use to …" style and stay short; no gate is weakened — a task reference goes
through exactly the same start guard, preset/branch rules and human reviews as
inline text; the change-listing primitive reads only the repository's
`openspec/changes` directory. Another running change
(`orientation-budget-and-tool-names`) edits the `read`/`grep`/`bash` tool
descriptions, so this change does not touch them and keeps its
`orchestrator.ts` edits additive.

## Goals / Non-Goals

**Goals:**

- A start that references work instead of re-typing it: an OpenSpec change id or
  path, or the session's previous developer message, with the resolution echoed
  (change id + task length) so a wrong resolution is visible.
- A primitive that answers "which changes exist in this repository, how far along
  are they, is one already being implemented", so the orchestrator stops probing
  paths with `read`.
- One identifier: the `workflowId` `list_workflows` returns is the one
  `workflow_status` accepts, with the repository resolved from the same board,
  several ids polled in one call with per-id `sinceRevision`, and an unknown id
  answered with candidates instead of a dead end.

**Non-Goals:**

- No separate orchestrator answer cache, no new server route, no new entry in the
  orchestrator capability allowlist (the observe route is already allowed).
- No change to `workflow_action` / `drain_workflow` (both still take `repo` +
  `workflowId`); the measured failure was polling, and extending them is a
  follow-up once a measurement shows the same waste.
- No change to compaction, to the event/subscription surface, to the store, or to
  the `read`/`grep`/`bash` tool descriptions.
- No growth of `list_workflows` rows or of a single-id `workflow_status` answer.
- The engine's own start guard keeps its (path-less) message: it is unreachable
  from the server start path, which validates first.

## Decisions

### 1. A change reference is resolved by the server; the previous message by the host

`POST /api/v1/workflow/start` gains an optional `taskRef: { change }` next to
`task`. `startWorkflowInProcess` resolves it in `startup.ts`
(`resolveTaskReference(repo, ref)`) before `prepareWorkflowStart`, so the
resolved text is the task the guard, the preset and the reviews already see — a
reference can never take a different path than text. The answer string carries
the resolution:

`Workflow started: <id> — task from change "<changeId>", <n> task chars`

The previous-message reference has no server-side meaning (the server holds no
conversation), so the *tool* substitutes the session's own developer message as
`task` and appends its own echo:
`… — task from the previous developer message, <n> task chars`.

Whoever resolved the reference echoes it. Alternatives considered: (a) the tool
reads `proposal.md`/`tasks.md` itself and posts the text — rejected because the
tool would duplicate the start guard's resolution, the text would cross the wire
twice, and a reference could drift from what the guard validated; (b) a
structured start result (`{workflowId, taskRef}`) — rejected because it changes
the start answer for every existing caller (TUI, desktop client, CLI) to carry a
diagnostic.

### 2. Reference shape and the one-of rule

- Wire: `taskRef: Schema.optional(Schema.Struct({ change: Schema.String }))`.
- Tool: `taskRef` is a union of `{ change: string }` and
  `{ previousMessage: true }`, and `task` becomes optional.
- Exactly one of `task`/`taskRef`: the tool refuses both/neither before calling
  the server (no round trip), and the server refuses a request that carries both
  as well (the wire is the boundary, not the prompt). The refusal text names both
  parameters in one line.

### 3. Change resolution rules

Given `repo` and a reference string:

1. A path form (absolute, or relative to `repo`, containing a separator) is
   accepted only when it resolves inside `<repo>/openspec/changes/<id>` with a
   single path segment under `changes/`; `..`, symlink escapes and
   `openspec/changes/archive/**` are refused (an archived change is history, not
   work to start; the refusal says so).
2. Otherwise the reference is a change id: an exact directory match wins.
3. Failing that, the reference is matched as a prefix, then as a substring, of
   the active change ids. Exactly one match resolves; more than one is refused as
   ambiguous with the matches named; none is refused with the closest ids
   (`rankSimilarIds`, the same helper the status poll uses for an unknown
   workflow id, bounded to 5 candidates plus a `(+n more)` count).
4. The refusal is one bounded line: the rule, the reference, and the candidates.
   No file contents.

The task text is assembled from whole sections of `proposal.md` (`##` sections
in file order, `## Why` first) followed by `tasks.md`'s checkbox list, capped at
the existing 16,000-character task bound; a section that does not fit is dropped
whole and named in a trailing `[task truncated: <sections>]` marker, so the
model sees that a constraint may be missing rather than a mid-sentence cut.
`design.md` is not included: it is the implementation plan the workflow's own
planner re-derives, and it is the largest of the three artifacts.

### 4. The session's previous developer message

`DurableHost.submit` already receives the exact text the developer (or the
monitor) sends. The host keeps the last submitted text per conversation when it
is a developer message — not a `[workflow-monitor]` note and not
`DEVELOPER_ABORT_MESSAGE` — and exposes it through the run context as
`lastDeveloperMessage?: () => string | undefined`, which
`createOrchestratorExtension`'s `lookup` already yields. The getter is pure and
never throws; with no developer message in the session the tool refuses with one
line naming `task` and `taskRef.change`.

Alternatives considered: reading the conversation transcript from the tool —
impossible through `pi-durable`'s tool API, and a transcript read would re-carry
whole turns; resolving "the previous message" in the server — the server has no
conversation, and copying the transcript to it would create new state (and a
store change).

### 5. The change listing is one additive observation

`POST /api/v1/observe` gains `{ kind: "openspec-changes", repo }` (contract:
`src/contracts/environment.ts`; dispatch: `src/server/operations/observations.ts`,
next to `discoverChanges`, which it reuses). The existing `{ kind: "changes" }`
id list keeps its shape, so the new-workflow form is untouched, and the
orchestrator capability allowlist needs no new entry.

One row per active change, sorted by id:

```
{"changeId":"add-stage-oauth2-auth","title":"Stage OAuth2 auth","tasks":"3/7",
 "path":"openspec/changes/add-stage-oauth2-auth"}
```

- `title` is the first Markdown heading of `proposal.md`, truncated to 80
  characters (the file is read bounded, never in full);
- `tasks` is `<checked>/<total>` from `tasks.md`, omitted when the change has no
  checkbox;
- `path` is the change's repository-relative directory, so the next `read` is
  exact instead of guessed;
- `workflowId` and `status` appear only when a non-closed workflow of that
  repository already implements the change (joined on the workflow's recorded
  change id, falling back to its workflow id, from the repo-scoped
  `listWorkflowViews(repo)` the server already reads).

The observation reads only `<repo>/openspec/changes` (never `archive/`, never a
file outside a change directory), answers at most 100 rows, and answers an empty
list when the repository has no `openspec/changes` directory.

The tool is `list_changes`, one line of description, `repo` the only required
parameter (an optional `limit` bounds a huge repository to the first n rows).
Alternatives considered: a new `GET /api/v1/workflow/changes` route — rejected
(route + protocol + allowlist entry for data the observe route already serves);
reading the directory in the agent host — rejected (the agent host has no
repository-state reader, and the observation module already owns change
discovery).

### 6. One identifier, and the repository comes from the same board

`workflow_status`'s `repo` becomes optional. When it is omitted, the tool reads
the workflow board once (`observe { kind: "workflows" }`, the same read
`list_workflows` performs) and maps `state.workflowId → target`. An id that the
board knows in one repository resolves to that repository; an id present in
several repositories answers one row per repository (each row already carries
`target`), so nothing is ambiguous and nothing is guessed. An explicit `repo`
still wins and skips the board read.

`workflow_action` and `drain_workflow` keep requiring `repo` (non-goal above);
`workflow_status`'s description points at `target` for them, which the compact
row already returns.

### 7. An unknown id is an answer, not an error

The corpus shows a failed call costs a whole turn (58 of 479 failed). An unknown
`workflowId` therefore answers, not fails:

```
{"workflowId":"add-environment-instances","unknown":true,
 "candidates":["add-environment-instance-lifecycle","add-environment-instances-fix"],
 "more":0}
```

Candidates come from the board's ids ranked by `rankSimilarIds` (token overlap,
then edit distance; bounded to 5), so the orchestrator can retry with the right
id in the same turn. When nothing is similar the entry says
`"candidates":[]` and the description tells the model to call `list_workflows`.

### 8. Multi-id polls with per-id revisions

`workflowId` becomes `string | string[]` (at most 8) and `sinceRevision` becomes
`number | Record<workflowId, number>` (a number applies to every id). Answers:

- **one id** — byte-for-byte the answer of today (`{unchanged, revision, status,
  step}` or the compact row), so nothing that reads the current shape changes;
- **several ids** — an array in the requested order, each entry the same
  per-id answer, with `workflowId` named on the `unchanged` short-circuit too
  (the compact row already names it), so every entry identifies itself.

`detail: "full"` and `includeTask` keep working for both forms. The implementation
reuses `compactWorkflowStatus` once per id and one `GET /workflow/view` per id,
so no server change is needed.

### 9. The clean-tree refusal stays as it is, and is now covered

`cleanTreeRefusal` already answers
`working tree must be clean before workflow start: <n> dirty path(s): <up to 20>, (+m more)`,
and the server's start route surfaces that message, which `start_workflow`
returns verbatim as its refusal. This change adds the missing tests (the bound,
the count, and that the tool relays it) rather than changing the message: a
shorter one would hide the paths, and a longer one would break the "compact
answer" rule the same backlog item enforces. The rule itself, and the engine's
own guard, are untouched.

### 10. Assumptions (no developer question was asked)

- A reference resolves to an **active** change; an archived change is refused
  with a hint, because a workflow's change id must be startable.
- "The previous message" means the last developer message of this session, not a
  monitor note and not an abort marker.
- 8 ids per poll and 100 listed changes are enough; both are protocol bounds, not
  policy, and can move without a schema change.
- The task text is `proposal.md` sections + `tasks.md` checkboxes; `design.md`
  stays out.
- Exactly one of `task`/`taskRef` is a refusal rather than a merge (silently
  preferring one would hide a reference that did not resolve).

## Risks / Trade-offs

- [A reference resolves to the wrong change] → the resolved change id and task
  length are echoed on every reference start; a prefix with more than one match
  is refused as ambiguous; a wrong id gets the rejection plus candidates, so the
  failure is visible in one turn instead of the workflow's plan.
- [Truncating the change documents drops a constraint] → truncation happens on
  whole `##` sections and is marked inside the task text; the echo reports the
  task length, so a suspiciously short task is visible. Inline `task` remains the
  escape hatch for a constraint the documents do not carry.
- [Previous-message substitution sends something the developer did not mean] →
  it only ever sends the developer's own literal message, never model-rewritten
  prose, and the echo names the source and the length; with no developer message
  it refuses instead of falling back to a monitor note.
- [The board read on a `repo`-less poll costs a request] → only when `repo` is
  omitted; a poll that names the repository is unchanged, and one extra
  observation is cheaper than the wrong-id poll it replaces.
- [More tool description and parameter bytes] → the additions are one new tool
  plus a sentence on two descriptions; measured cost is ≈$0.13 per kB per
  session, and the listing replaces 22 ENOENT `read` probes.
- [Mechanical conflict with `orientation-budget-and-tool-names`] → this change
  touches `orchestrator.ts` additively (new tool block, widened parameter
  schemas) and never the `read`/`grep`/`bash` descriptions.

## Migration Plan

No migration. The wire field is optional and additive, the observation kind is
new, and a store written by this build is unchanged (`STORE_SCHEMA_VERSION` stays
6). Rollback is the revert of the commit: an older orchestrator tool surface
simply never sends `taskRef`, and the server's refusal for `task`+`taskRef`
never triggers.

## Verification plan

Recorded with this change, run against the efficiency dataset
(`bun run scripts/efficiency/analyze.ts <query> --dataset <dir>`) and the
orchestrator harness store the way `docs/efficiency/02h-orchestrator.md` measured
it (the orchestrator conversation is still not attributed to a durable run):

| check | query | baseline | target |
| --- | --- | --- | --- |
| failed `read` probes | `failed-chains` (`read`) | 24/41, 22 ENOENT | ENOENT < 3 |
| failed `workflow_status` polls | `failed-chains` (`workflow_status`) | 9/86 | failed polls → 0 |
| `start_workflow` argument bytes | harness args per tool | 163,350 B | < 40 kB |
| `start_workflow` refusals | harness failure kinds | 12 (8 clean-tree) | < 4 |

The change itself proves the behavior with unit tests; the table is measured
again on the next long orchestrator session.

## Open Questions

- Should `workflow_action` and `drain_workflow` also accept a bare `workflowId`?
  Deferred: polling is the measured waste; if the next session still pays for a
  repository lookup before every action, the same `rankSimilarIds` +
  board-resolution helper applies unchanged.
- Is 16,000 characters the right cap for a document-derived task? It is the
  existing task bound; if the echo shows reference tasks routinely truncated, the
  cap is the thing to move, not the resolution rule.
