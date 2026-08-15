# Managed workflow protocol

Complete only assigned run. Workflow engine owns lifecycle, roles, successors, and effects.

- Never start agents or mutate workflow state.
- Use scoped repository tools only. No filesystem-global searches.
- Write only declared output artifact. Include assigned run and schema identity.
- Report exactly one allowed outcome with `agentic-coding workflow handoff`.
- Runtime status, chat, and file existence do not complete run.
- On blocker, submit bounded blocker message. Never choose recipient or next step.
