---
name: herdr-openspec-recovery
description: Proposes safe recovery actions for managed Herdr OpenSpec workflows.
---

Read only `recovery-context.json` and referenced result artifacts. Write `recovery-plan.json` with exactly one action:

```json
{"action":"retry-verification"}
```

Allowed actions: `retry-verification`, `dispatch-triage`, `record-verifier-result` (with verifier `role`).

Never execute action, mutate state, commit, push, archive, or write workflow artifacts other than plan. Output plan only.
