## 1. Briefs: budget and the plan's file list

- [x] 1.1 `agent-definitions/instructions/planning.md`: after the
  `openspec new change` step, add the skeleton-first sentence (create the change
  directory, write a skeleton of the first artifact, extend it and each later
  artifact in place); in the domain-surface paragraph add the exploratory budget
  with the restated dependency-read rule and the `openQuestions` fallback; change
  the plan-result field description so `artifacts` is documented as the plan's
  file list (the change's artifact paths, then every repository-relative file the
  plan creates or changes, forwarded to the implementation assignment). Added
  bytes: 661 net (skeleton 209, budget sentence 319, `artifacts` description
  +133), as measured in `design.md` D6.
- [x] 1.2 `agent-definitions/instructions/wiki-openspec.md` and
  `agent-definitions/instructions/wiki-research.md`: insert the `## Write early`
  section after their first section, in each brief's own vocabulary (discovery
  search names a target / first directive's claim is corroborated), keeping the
  update-first sequence as the thing that decides the write path. Added bytes:
  413 B (`wiki-openspec.md`) and 438 B (`wiki-research.md`).
- [x] 1.3 Regenerate `src/workflow/embedded.generated.ts` with
  `bun run scripts/generate-embedded.ts`; confirm the pinned digests match the
  on-disk assets and that the file is only machine-written.

## 2. The tool surface in the assignment

- [x] 2.1 Add the `## Tool surface` section to the dynamic envelope in
  `src/workflow/assignment.ts` (`renderAssignment`), between the identity lines
  and `## Objective`, with the exact text from `design.md` D1 — `read` with
  `offset`/`limit` and `grep` with a `path` filter as the default way to inspect
  code, `bash` for builds, tests and `openspec`, `codemode` only "when this run
  offers it" chaining a search → filter → summarise pipeline into one turn, and
  the batching rule. No `edit`/`write` claim for a read-only run.
- [x] 2.2 Keep the block inside the dynamic envelope so a follow-up
  attempt/round re-sends it, and assert that in a test (follow-up rendering).

## 3. Forwarded scope in the assignment

- [x] 3.1 Add a bounded reader for a recorded run artifact under
  `src/workflow/runtime/` (the runtime layer, not a step hook): resolve the
  `snapshot.evidence` entry by kind, read the artifact with a byte cap, decode
  `{runId, schemaId, schemaVersion, payload}`, and return a decoded payload or
  `undefined`. Every failure mode (missing, unreadable, oversized, undecodable)
  degrades to `undefined` — never a launch failure, never a fallback to reading
  the change documents or the worktree.
- [x] 3.2 Plan files: read the plan run's recorded artifact
  (`core.plan:planner`, or `fusion.consolidate:consolidator` where the family
  consolidates), take its declared file list, and render one `Plan files: …`
  input line for `core.implementation` runs only, bounded to 40 paths followed by
  the count of the remainder, paths only. Render nothing when the plan declares
  none.
- [x] 3.3 Verification changed files: extend the `core.triage`-only condition to
  `core.verification` in `src/workflow/effect-runner.ts` (the launch path at
  `assignmentFor`'s call site plus the two re-render paths) so the existing
  `Changed files:` line is rendered for verifiers, bounded to 100 paths followed
  by the count of the remainder. Leave the triage line exactly as it is.
- [x] 3.4 Prior findings: for `core.verification` runs, decode the latest
  recorded artifact per `core.verification:<role>` evidence kind (validating each
  recorded finding's severity, path, line and detail) and render one
  untrusted-context input block of
  `severity path:line — detail` lines, bounded to 8 findings per role, 200
  characters of finding text, 4 KiB for the block, passed through the engine's
  existing text redaction. Render no block when nothing is recorded.
- [x] 3.5 Wire the forwarded values into `assignmentFor`'s `## Inputs` (plan
  files before the changed-files line, prior findings after it, both before the
  step input) and keep the existing input order otherwise unchanged.
- [x] 3.6 Confirm the change adds no persisted state: no `STORE_SCHEMA_VERSION`
  bump, no store column, no new snapshot field, no migration and no compat shim.

## 4. Tool descriptions

- [x] 4.1 Resolve whether the run registers `codemode` in
  `src/agent-host/host.ts` before the coding tools are installed, and pass that
  boolean into `boundedCodingTools`, `suggestingCodingTools` and
  `createSearchExtension`; installation behavior itself stays exactly as it is.
- [x] 4.2 Add the tool-surface sentence and the batching rule to the `read`
  description (`src/agent-host/tool-suggestions.ts`), the `grep` description
  (`src/agent-host/tools.ts`), the `bash` description
  (`src/agent-host/bash-tool.ts`) and the `codemode` description
  (`src/agent-host/codemode.ts`), naming `codemode` in the first three only when
  the boolean says the run has it. Preserve every existing contract in those
  descriptions (the `bash` bound/ceiling/override and elapsed-time note,
  `grep`'s refusal, line bound and platform-grep fallback, `read`'s off-target
  refusal).

## 5. Efficiency query and docs

- [x] 5.1 Add the read-only `explore-tools` query to
  `scripts/efficiency/lib/queries.ts` with the columns from `design.md` D7
  (per run: role, profile, total/bash/read/`grep` calls, bash share of calls,
  exploratory calls and their result bytes, and the median result bytes per
  exploratory call). Do not modify an existing query or the CSV number format.
- [x] 5.2 Document the assignment's tool-surface section, the forwarded plan
  files / changed files / prior findings, and the description ownership in
  `docs/workflow-architecture.md`, and note the measured prompt-byte additions
  from `design.md` in the change's own record.

## 6. Verification

- [x] 6.1 Brief tests: assert the exact new text in `planning.md`,
  `wiki-openspec.md` and `wiki-research.md` and the regenerated embedded pin;
  update the existing per-role brief assertions deliberately.
- [x] 6.2 Assignment tests: the `## Tool surface` block present with the exact
  text for a planner, worker, verifier, wiki and read-only run — on a first
  assignment and on a follow-up — and no `edit`/`write` claim for a read-only
  run.
- [x] 6.3 Forwarding tests: plan files rendered from a recorded plan artifact,
  bounded (41 paths → 40 + omission count) and absent when the plan declares
  none; verification rounds render the changed files and the prior findings,
  round 1 renders no prior-findings block, a truncated block respects the
  8/200/4 KiB bounds, a credential shape is redacted, and a missing, oversized
  or undecodable recorded artifact degrades to no forwarded line with the launch
  still rendered.
- [x] 6.4 Tool-description tests: the exact new sentences with a registered
  `codemode` and the absence of any `codemode` mention without it, plus the
  preserved `bash` bound, `grep` fallback and `read` description contracts.
- [x] 6.5 Query test: `explore-tools` over a fixture dataset reports the per-run
  counts, the bash share and the median exploratory result bytes.
- [x] 6.6 Run `bun run type-check` (0 errors), `bun run lint` (zero
  diagnostics), the focused tests above with a temporary `HOME`,
  `AGENTIC_CODING_CONFIG_DIR` and `HERDR_WIKI_DIR`, then `git status --short` is
  empty and `openspec validate --changes --strict` passes.
