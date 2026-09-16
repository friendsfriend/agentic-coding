# Validation evidence (tasks 4.1–4.3)

Interactive terminal checks are substituted by rendered-frame assertions (agreed
with the requester): `testRender` at real widths is the strongest automated
stand-in available in this environment. Nothing here was verified by hand in a
live terminal, and that is the one gap a human should confirm before release.

## 4.1 Rendered navigation checks

`test/app/renderedNavigation.test.tsx`

- Home → Environments → Applications → resource page (the resource root is named
  by the identity it renders: `Home › Environments › Applications › app-1`).
- Cross-domain Back: Applications page → trace (via the picker) → Back restores
  the application page, not the observability list.
- Modal/text-input isolation: with the picker open, `j`/`1`/`t` go to the search
  box (`/j1t`); Escape closes it without navigating.
- Inactive handler: the mounted-but-hidden environment body's destination report
  does not move the route while its page is not shown.

`test/app/observabilityRoutes.test.tsx` — traces list → span tree → Back, metric
list → metric detail → Back, and a cross-domain Back that unwinds to the earlier
trace tree.

`test/app/appShell.test.tsx` — Home lists its destinations; a category page
mounts the feature body; an open modal owns input across page keys; a hidden
body does not consume the visible page's keys.

## 4.2 Terminal sizes, mouse, footer and help

`test/app/tuiValidation.test.tsx`

- Breadcrumb stays exactly one row at 48 columns (collapsed, no overflow) and at
  200 columns (all ancestors visible, no `…`).
- A real mouse click on the `Environments` crumb navigates to that ancestor.
- Applications, Libraries and Scripts each open their own page through the
  location picker.
- The footer advertises the special keys (`Ctrl+P`, `Alt+Up`, `?`, `T`) and not
  the standard navigation keys; `?` lists the complete catalog, standard keys
  included.

`test/app/appShell.test.tsx` (narrow terminal), `test/app/pageNavigation.test.tsx`
(no numeric/`t` dispatch; Tab traverses page-local focus), `test/app/routeState.test.tsx`
(picker jump loads the resource the route names) cover the remaining items.

## 4.3 Tests, type-check, lint, OpenSpec

- `bun run lint` — Biome, zero diagnostics.
- `bun run type-check` — `tsc --noEmit`, zero errors.
- `bun run test:devenv` — 169 tests, 41 files, green.
- `bun run test` — 1610 tests across 168 files: every navigation file green.
  `test/workflow-effects.test.ts` and `test/workflow-execution.test.ts` fail
  only inside the full parallel run (`known permanent failures stop immediately
  instead of consuming the retry budget`, `runner cancels a lost effect and a
  successor can reclaim it`). Both drive real `git`/`sh` children against
  wall-clock deadlines, both pass in isolation and in a sorted partial run
  together with every navigation file, and the failing set varies between runs.
  They share no code with this change and are treated as pre-existing
  load-sensitive flakes rather than regressions.
- `openspec validate replace-nested-tabs-with-page-navigation --strict` — valid.

## Temporary workflow bridge (removal dependency)

`workflows` remains a Home destination and `workflows.detail` its resource page
until the roadmap's contextual-launch and centralized-Settings changes land.
They replace what the page offers today; when they do, delete the Workflows entry
from `homeDestinations()` (`src/tui/shared/navigation/destinations.ts`) and the
`workflows`/`workflows.detail` pages from `PAGES`, and the shell loses nothing
else — no other page points at them.

## Known gaps (for review)

- The interactive check in a real terminal at narrow/wide sizes is not performed
  here; rendered frames are used instead.
- `devenv`'s standalone entry (`startTUI`) is unreachable from the CLI today; the
  page shell always embeds `TUIApp`. Its non-embedded layout branch therefore
  keeps its own footer but no longer has an inner tab row.
