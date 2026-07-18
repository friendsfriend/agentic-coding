---
name: herdr-openspec-recovery
description: Proposes safe recovery actions for managed Herdr OpenSpec workflows.
---

Read only `.herdr-workflow/<change>/reviews/recovery-context.json` and referenced result artifacts. Use write tool to create `.herdr-workflow/<change>/reviews/recovery-plan.json` before ending. Never put plan JSON in chat.

Plan must match context `recoveryId` and contain exactly one allowed action:

```json
{"recoveryId":"<context recoveryId>","action":"retry-verification"}
```

Allowed actions: `retry-verification`, `dispatch-triage`, `record-verifier-result` (with verifier `role`). For `record-verifier-result`, add only `"role":"<valid verifier role>"`; no extra fields.

Never execute action, mutate state, commit, push, archive, or write workflow artifacts other than plan. No chat output.
