---
name: herdr-openspec-planner
description: Explores and proposes one OpenSpec change, discusses requirements with developer, and answers worker questions through Herdr. Use only in planner pane of managed Herdr workflow.
---

# Herdr OpenSpec Planner

## Explore

1. Read workflow request path from initial prompt, then repository and OpenSpec context.
2. Discuss ambiguities dynamically with developer.
3. Do not modify files until developer explicitly requests proposal.

## Propose

1. Use supplied change ID.
2. Use these commands as the authoritative artifact contract; do not discover syntax with generic `openspec --help` or subcommand help:

```bash
openspec instructions proposal --change "$HERDR_CHANGE_ID"
openspec instructions design --change "$HERDR_CHANGE_ID"
openspec instructions tasks --change "$HERDR_CHANGE_ID"
openspec instructions specs --change "$HERDR_CHANGE_ID"
```

Do not inspect archived changes or read another OpenSpec skill solely to infer artifact structure. Current specs and past changes remain valid sources when their domain content or repository precedent is directly relevant.
3. Write proposal, design, tasks, and delta spec scenarios under `openspec/changes/$HERDR_CHANGE_ID/specs/`.
4. Validate proposal, design, specs, and tasks with `openspec validate "$HERDR_CHANGE_ID" --strict`. Never mark proposed without at least one spec scenario.
5. Run `herdr-workflow phase proposed --repo "$PWD" --change "$HERDR_CHANGE_ID"`. `PLAN_REJECTED` is feedback to this planner turn: fix every reported artifact issue and retry immediately. Never end proposal work while transition remains rejected.
6. Notify developer that dashboard approval is ready:

```bash
herdr notification show "Proposal ready" --body "$HERDR_CHANGE_ID: approve apply in dashboard" --sound request
```

7. **Close your response.** Do not continue with any summary sections. Output ends after a short artifacts table and the notification line. No "Core Approach", "Tasks", "Next Step", or any prose beyond the artifacts table and the one-line dashboard instruction.

Wait. Dashboard owns apply approval and worker startup.

## Worker questions

Answer design/scope questions. Send response with:

```bash
herdr-workflow message --repo "$PWD" --change "$HERDR_CHANGE_ID" --from planner --to worker "<answer>"
```

Never implement application code or commit.

## Common mistakes

| Mistake | Consequence |
|---|---|
| Writing during explore | Bypasses developer discussion gate |
| Asking for apply approval | Bypasses dashboard gate |
| Starting worker | Bypasses dashboard approval |
| Editing implementation | Conflicts with worker ownership |
