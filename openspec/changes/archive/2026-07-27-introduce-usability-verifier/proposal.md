# introduce-usability-verifier

Introduce a new managed Herdr verifier role that reviews changed code from a UI usability and design viewpoint. The triage agent selects the usability verifier only when changed files include frontend or asset files (CSS/SCSS, HTML/JSX, templates, images, icons, theme/config) or any file inside a `frontend/`, `ui/`, or `app/` directory.

## What changes

### New skill
- `agent-definitions/skills/herdr-openspec-usability-verifier/SKILL.md` – verifier instructions for full design review (visual, accessibility, layout, design system compliance, component states)

### Config & workflow
- `pi/herdr-workflow.toml` – add `usability_verifier` model mapping
- `pi/lib/herdr_workflow/tiering.py` – add `"usability-verifier"` to `VERIFIER_ROLES` and frontend/asset detection in `eligible_verifier_roles()`
- `pi/lib/herdr_workflow/prompts.py` – add `ROLE_TOOLS` entry and `role_prompt()` case for usability-verifier

### Dashboard
- `agent-dash/src/data.ts` – add to recovery-plan role validation, demo data, and default verification roles display

## Non-goals
- No changes to the triage agent logic beyond making the role available
- No changes to test verifier or archive workflow
- No new UI instrumentation or runtime checks – pure review role

## Risk
- Low. New role is optional (only triggered by triage when relevant files change). Does not modify existing verifier behavior.
