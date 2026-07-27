# Design: introduce-usability-verifier

## Overview

A new read-only verifier role `usability-verifier` follows the same pattern as existing verifiers (security-verifier, quality-verifier, etc.). It is launched when triage selects it; it reads a scoped review context, inspects changed frontend files, writes JSONL findings + a PASS/FAIL verdict, and submits via `herdr-workflow verification-result`.

## Verifier skill scope

The usability verifier checks changed code for:

1. **Visual consistency** – spacing, alignment, typography scale, color palette adherence
2. **Accessibility** – color contrast, missing alt text, focus states, ARIA attributes, semantic HTML
3. **Responsive layout** – breakpoint behavior, layout shifts, viewport meta
4. **Component library compliance** – correct component API usage, design tokens vs hardcoded values
5. **UI states** – loading, empty, error states presence
6. **Regressions** – introduced inline styles, hardcoded colors, structural issues

It does **not** inspect backend-only changes, run visual snapshot tests, or check animation performance thresholds — that is out of scope for a code-review verifier.

## Triage integration

`eligible_verifier_roles()` in `tiering.py` suggests `usability-verifier` when changed files match:

- Extensions: `.css`, `.scss`, `.less`, `.html`, `.htm`, `.jsx`, `.tsx`, `.vue`, `.svelte`, `.svg`, `.png`, `.gif`, `.ico`, `.woff`, `.woff2`, `.ttf`, `.eot`
- Directories: `frontend/`, `ui/`, `app/` (any depth)
- Config: files named `theme.*`, `colors.*`, `tokens.*`, `tailwind.config.*`

The triage agent decides whether to include it — it is never mandatory.

## File changes

| File | Change |
|---|---|
| `agent-definitions/skills/herdr-openspec-usability-verifier/SKILL.md` | New skill file |
| `pi/herdr-workflow.toml` | Add `usability_verifier` model key |
| `pi/lib/herdr_workflow/prompts.py` | `ROLE_TOOLS["usability-verifier"]`, `role_prompt()` case |
| `pi/lib/herdr_workflow/tiering.py` | Add to `VERIFIER_ROLES`, add to `eligible_verifier_roles()` |
| `agent-dash/src/data.ts` | Add to recovery-plan validation, demo data |

## Verifier lifecycle

1. Worker completes changes → `herdr-workflow verify`
2. Triage writes input, launches triage agent
3. Triage selects `usability-verifier` in its plan (if relevant files changed)
4. `cmd_dispatch_verifiers` launches usability-verifier alongside other selected verifiers
5. Verifier reads `round-N-usability-verifier-context.md`, reviews files, writes findings JSONL, submits result
6. If all selected verifiers PASS, test verifier runs; coordinator produces consolidated report
