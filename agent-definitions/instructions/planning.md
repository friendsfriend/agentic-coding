# Planning

HERDR_* identifies this run, not a change id. Choose the change id. Do not re-read run.env, workflow status or `.herdr-workflow` except the review context below.

Use ordinary clarification only for a material unresolved decision; do not ask for facts available in the repository or substitute a chat confirmation for the plan-review gate. The attached Home can ground an answer in agreed evidence or discuss and relay an explicitly confirmed exact proposal. A mutable design file alone does not establish approval; the operator plan-review gate pins approved design evidence.

You own change scope. Decide whether the requested work fits one well-sized change or should be split, then:

1. Choose the change id(s). An id is 1-80 lowercase letters, digits, or hyphens. Pick one that names the change, not the workflow (`$HERDR_WORKFLOW_ID` identifies the workflow; the change ids identify the OpenSpec changes).
2. Author the **primary change** — the change this workflow will implement — using an id you chose (NOT `$HERDR_CHANGE_ID`; it is not defined here). The change directory does not exist at run start. Create it first — this is the only setup command, no other openspec CLI exploration is needed:

```bash
openspec new change "<primary-change-id>" --description "<one-line summary>"
```

3. Author well-scoped follow-ups as **additional proposal drafts**, each created with `openspec new change "<id>" --description "..."` and independently valid proposal/design/tasks/specs (at least one scenario). Only the primary is implemented here; humans may promote follow-ups later. A single-change plan needs no follow-ups.

Then let openspec drive the artifact set instead of assuming it:

```bash
openspec status --change "<primary-change-id>" --json
```

Use `artifactPaths`/`resolvedOutputPath` and `requires` for paths/build order; track them in your todo list.

Create every required artifact in dependency order. For each:

```bash
openspec instructions <artifact-id> --change "<primary-change-id>" --json
```

Follow `template`, `instruction` and `rules` without copying constraints into artifacts. Write to `resolvedOutputPath`; read dependency artifacts from disk, never memory. Re-run status after each artifact until all required artifacts exist.

As soon as `openspec status` names the first artifact's `resolvedOutputPath` and `openspec instructions` returns its template, write that artifact's skeleton — its headings, the id's intent, and what you already know — then extend it and each later artifact in place as you learn. Write nothing before the resolved path exists: the artifact set is openspec's to name, not yours to assume.

Understand the task's domain surface: read only the files the change touches and their direct dependencies. Do not explore workflow-engine internals (workflow/, tui/dash engine plumbing), git history archaeology, other workflows' change directories, or archived changes for reference. Budget orientation to a small share of your turns; when a question cannot be settled within this surface, record it in the plan's `openQuestions` instead of reading further. The budget bounds exploration, not the required reads: still read every dependency artifact from disk before writing the one that depends on it.

Finish with `openspec validate "<primary-change-id>" --strict`. The output artifact's payload **must** declare `primaryChangeId` set to the id of the change you chose as primary — the engine records that id as the change this workflow implements and rejects the plan without it. You may additionally include `summary` (the plan's intent and open steering calls), `artifacts` (the plan's file list: the change's artifact paths, then every repository-relative file the plan creates or changes — the implementation assignment forwards it), `risks` (material uncertainties), and `openQuestions` (decisions a human may want to answer) for developer review, plus any validated files and evidence. Do not implement or approve the plan.

## Validation ownership

When defining implementation tasks or required validation, require focused, change-relevant checks that cover the changed behavior. Do not require the worker to run the complete repository test suite or add a complete-suite worker task. The workflow-owned `test-verifier` runs the complete configured repository test suite after implementation and selected verifier checks complete; do not prescribe a repository-wide test command in planning artifacts.

## Revising after plan review

When the plan gate returns the workflow to planning (a plan review requested changes), the run context carries the review comments. Read them with `agentic-coding workflow status --json`: the current `step.context.comments` array lists each comment with `comment` (body), `file`, and optional `line`/`startLine`/`endLine` pointing at the reviewed artifact.

Revise the plan against those comments, not around them:
- Re-read the flagged artifacts from disk, apply each comment to the relevant artifact, and record which comment each edit resolves.
- If a comment is genuinely invalid or already satisfied, say so explicitly in your summary rather than silently ignoring it.
- Do not introduce unrelated changes while revising.
- Keep the artifact set in sync — re-run `openspec status --change "<primary-change-id>" --json` after editing and re-validate with `openspec validate "<primary-change-id>" --strict`. Do not change the declared primary id on revision; the engine preserved the previous plan artifacts for you to amend in place.

## Knowledge wiki

Consult durable context with `agentic-coding workflow wiki search` and `show` before deciding; wiki reads are exempt from the do-not-explore restriction. Treat each concept as advisory: weigh its status, trust tier and staleness. Use `projects/<project-id>/<concept>` for knowledge specific to one project and `shared/<concept>` only for claims with evidence from every covered project; a repository-relative source path is meaningful only in the context of the project named by its concept. Update existing concepts in place in any future documentation step and do not create active near-duplicates. Do not write wiki concepts from planning: report documentation gaps in the plan's risks or questions for the dedicated wiki step, which owns draft authoring (human approval owns promotion).