# Planning

Your run environment is already set: `$HERDR_CHANGE_ID` and the other HERDR_* variables identify this run. Do not re-read run.env, run `agentic-coding workflow status`, or inspect `.herdr-workflow` state — the engine owns the workflow.

The change directory does not exist at run start. Create it first — this is the only setup command, no other openspec CLI exploration is needed:

```bash
openspec new change "$HERDR_CHANGE_ID" --description "<one-line summary>"
```

Then let openspec drive the artifact set instead of assuming it:

```bash
openspec status --change "$HERDR_CHANGE_ID" --json
```

Parse the JSON: `artifactPaths` gives each artifact's `resolvedOutputPath`, and the `requires` edges give the build order. Track the artifacts with your todo list.

Create every required artifact in dependency order. For each:

```bash
openspec instructions <artifact-id> --change "$HERDR_CHANGE_ID" --json
```

Use the returned `template` as the structure, follow `instruction` and `rules` (constraints for you — never copy them into the file), and write to `resolvedOutputPath`. Read the completed dependency artifacts from disk before writing the next one — always from disk, never from memory. After each artifact, re-run `openspec status --change "$HERDR_CHANGE_ID" --json` until every required artifact exists.

Understand the task's domain surface: read only the files the change touches and their direct dependencies. Do not explore workflow-engine internals (workflow/, tui/dash engine plumbing), git history archaeology, other workflows' change directories, or archived changes for reference.

Finish with `openspec validate "$HERDR_CHANGE_ID" --strict`. Output artifact must identify validated files and evidence. Do not implement or approve plan.

## Validation ownership

When defining implementation tasks or required validation, require focused, change-relevant checks that cover the changed behavior. Do not require the worker to run the complete repository test suite or add a complete-suite worker task. The workflow-owned `test-verifier` runs the complete configured repository test suite after implementation and selected verifier checks complete; do not prescribe a repository-wide test command in planning artifacts.

## Revising after plan review

When the plan gate returns the workflow to planning (a plan review requested changes), the run context carries the review comments. Read them with `agentic-coding workflow status --json`: the current `step.context.comments` array lists each comment with `comment` (body), `file`, and optional `line`/`startLine`/`endLine` pointing at the reviewed artifact.

Revise the plan against those comments, not around them:
- Re-read the flagged artifacts from disk, apply each comment to the relevant artifact, and record which comment each edit resolves.
- If a comment is genuinely invalid or already satisfied, say so explicitly in your summary rather than silently ignoring it.
- Do not introduce unrelated changes while revising.
- Keep the artifact set in sync — re-run `openspec status --change "$HERDR_CHANGE_ID" --json` after editing and re-validate with `openspec validate "$HERDR_CHANGE_ID" --strict`.

The revision runs on the same change directory; the engine preserved the previous plan artifacts for you to amend in place.

## Knowledge wiki

Consult durable context with `agentic-coding workflow wiki search` and `show` before deciding; wiki reads are explicitly exempt from the do-not-explore restriction. Treat each concept as advisory and weight its status, trust tier, and staleness rather than treating it as authoritative. Identify the project before recording facts: use `projects/<project-id>/<concept>` for knowledge specific to one project or repository, and use `shared/<concept>` only for claims that apply across projects and have evidence from every covered project. A repository-relative source path is meaningful only in the context of the project named by its concept; never present it as a universal location or rule. Search and read before writing, update an existing concept in place, and do not create active near-duplicates. Planning writes are drafts only: preserve unverified status and leave promotion to the archive role. When a gap is worth preserving, `wiki write` may capture a draft.
