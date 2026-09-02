# Planning

Your run environment is already set: `$HERDR_WORKFLOW_ID` and the other HERDR_* variables identify this run (there is no change id yet — you choose it). Do not re-read run.env, run `agentic-coding workflow status`, or inspect `.herdr-workflow` state — the engine owns the workflow.

You own change scope. Decide whether the requested work fits one well-sized change or should be split, then:

1. Choose the change id(s). An id is 1-80 lowercase letters, digits, or hyphens. Pick one that names the change, not the workflow (`$HERDR_WORKFLOW_ID` identifies the workflow; the change ids identify the OpenSpec changes).
2. Author the **primary change** — the change this workflow will implement — using an id you chose (NOT `$HERDR_CHANGE_ID`; it is not defined here). The change directory does not exist at run start. Create it first — this is the only setup command, no other openspec CLI exploration is needed:

```bash
openspec new change "<primary-change-id>" --description "<one-line summary>"
```

3. If the remaining work is well-scoped follow-up that this workflow should not implement, author it as **additional proposal drafts**, each its own change directory with its own `openspec new change "<id>" --description "..."`. Each follow-up must be independently valid (own proposal/design/tasks/specs with at least one scenario), but this workflow only implements the primary; follow-up drafts are handed off to a human to promote into their own workflows later. When the requested work fits one change, author only the primary — the absence of follow-ups never fails the plan.

Then let openspec drive the artifact set instead of assuming it:

```bash
openspec status --change "<primary-change-id>" --json
```

Parse the JSON: `artifactPaths` gives each artifact's `resolvedOutputPath`, and the `requires` edges give the build order. Track the artifacts with your todo list.

Create every required artifact in dependency order. For each:

```bash
openspec instructions <artifact-id> --change "<primary-change-id>" --json
```

Use the returned `template` as the structure, follow `instruction` and `rules` (constraints for you — never copy them into the file), and write to `resolvedOutputPath`. Read the completed dependency artifacts from disk before writing the next one — always from disk, never from memory. After each artifact, re-run `openspec status --change "<primary-change-id>" --json` until every required artifact exists.

Understand the task's domain surface: read only the files the change touches and their direct dependencies. Do not explore workflow-engine internals (workflow/, tui/dash engine plumbing), git history archaeology, other workflows' change directories, or archived changes for reference.

Finish with `openspec validate "<primary-change-id>" --strict`. The output artifact's payload **must** declare `primaryChangeId` set to the id of the change you chose as primary — the engine records that id as the change this workflow implements and rejects the plan without it. You may additionally include `summary` (the plan's intent and open steering calls), `artifacts` (the change's artifact paths), `risks` (material uncertainties), and `openQuestions` (decisions a human may want to answer) for developer review, plus any validated files and evidence. Do not implement or approve the plan.

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

Consult durable context with `agentic-coding workflow wiki search` and `show` before deciding; wiki reads are explicitly exempt from the do-not-explore restriction. Treat each concept as advisory and weight its status, trust tier, and staleness rather than treating it as authoritative. Identify the project before recording facts: use `projects/<project-id>/<concept>` for knowledge specific to one project or repository, and use `shared/<concept>` only for claims that apply across projects and have evidence from every covered project. A repository-relative source path is meaningful only in the context of the project named by its concept; never present it as a universal location or rule. Search and read before deciding, update existing concepts in place in any future documentation step, and do not create active near-duplicates. Do not write wiki concepts from planning. Report useful documentation gaps in the plan's risks or questions for the dedicated wiki step; that step owns draft authoring and human approval owns promotion.