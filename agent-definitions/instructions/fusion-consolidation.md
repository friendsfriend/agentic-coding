# Plan fusion

You receive the validated plan drafts from every fusion planner under Inputs — read each one from disk; none may be skipped. Fuse them into one consolidated OpenSpec proposal; do not concatenate them.

Reconcile before writing:

- Prefer convergent choices — the approach most drafts agree on wins by default.
- Where drafts conflict, pick the single strongest approach and record the rejected alternatives with the reason they lost in the proposal's design notes.
- Carry each draft's `risks` that still applies into the artifacts. Answer every `questions` entry you can from the repository; surface the remainder as explicit open questions in the design.
- Never blend incompatible half-measures from different drafts into one plan.

Then create the normal OpenSpec change artifacts exactly as the planning step does. The change directory does not exist at run start. Create it first — this is the only setup command, no other openspec CLI exploration is needed:

```bash
openspec new change "$HERDR_CHANGE_ID" --description "<one-line summary>"
```

Then let openspec drive the artifact set instead of assuming it:

```bash
openspec status --change "$HERDR_CHANGE_ID" --json
```

Parse the JSON: `artifactPaths` gives each artifact's `resolvedOutputPath`, and the `requires` edges give the build order. Create every required artifact in dependency order; for each, use:

```bash
openspec instructions <artifact-id> --change "$HERDR_CHANGE_ID" --json
```

Use the returned `template` as the structure and follow `instruction` and `rules` (constraints for you — never copy them into the file). Read dependency artifacts from disk before writing the next one. Re-run `openspec status --change "$HERDR_CHANGE_ID" --json` until every required artifact exists.

When reconciling implementation tasks or required validation, preserve focused, change-relevant checks that cover the changed behavior. Do not require the worker to run the complete repository test suite or add a complete-suite worker task. The workflow-owned `test-verifier` runs the complete configured repository test suite after implementation and selected verifier checks complete; do not prescribe a repository-wide test command in the consolidated plan.

Finish with `openspec validate "$HERDR_CHANGE_ID" --strict`. The consolidated proposal goes to the developer through the standard plan review — do not implement or approve the plan.

Consult `agentic-coding workflow wiki search` and `show` while reconciling; wiki reads are exempt from the file-scope restriction. Weight status, trust tier, and staleness, preferring verified stable concepts over contradictory drafts and recording that reason in design notes. Identify the project context for evidence: use `projects/<project-id>/<concept>` for facts specific to one project, and use `shared/<concept>` only for claims covering multiple projects with evidence from every covered project. Repository-relative source paths must be labeled with the project whose concept documents them, never presented as universal locations or rules. Search and read before deciding, update existing concepts in place in any future documentation step, and do not create active near-duplicates. Do not write wiki concepts from consolidation; report durable documentation gaps in the consolidated plan for the dedicated wiki step, which writes unverified drafts and leaves promotion to human approval.
