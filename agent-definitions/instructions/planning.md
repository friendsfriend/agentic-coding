# Planning

Your run environment is already set: `$HERDR_CHANGE_ID` and the other HERDR_* variables identify this run. Do not re-read run.env, run `agentic-coding workflow status`, or inspect `.herdr-workflow` state — the engine owns the workflow.

Get the exact artifact formats from openspec itself — do not copy other changes or hunt for templates:

```bash
openspec instructions proposal --change "$HERDR_CHANGE_ID"
openspec instructions design --change "$HERDR_CHANGE_ID"
openspec instructions tasks --change "$HERDR_CHANGE_ID"
openspec instructions specs --change "$HERDR_CHANGE_ID"
```

Understand the task's domain surface: read only the files the change touches and their direct dependencies. Do not explore workflow-engine internals (workflow/, tui/dash engine plumbing), git history archaeology, other workflows' change directories, or archived changes for reference.

Produce proposal, design, tasks, and delta specs. Run `openspec validate "$HERDR_CHANGE_ID" --strict`. Output artifact must identify validated files and evidence. Do not implement or approve plan.
