# Biome linting and formatting

The `agentic-coding/` package uses Biome as its single linter, import organizer, and formatter (config: `agentic-coding/biome.json`). Do not introduce eslint or prettier; Biome covers both roles.

Run from `agentic-coding/`:

- `bun run lint` — check for lint, formatting, and import-order issues (must pass with zero diagnostics before finishing any change).
- `bun run format` — rewrite files in place to fix formatting only.
- `bunx biome check --write .` — apply safe fixes (formatting, imports); add `--unsafe` for fixable lint issues, then review the diff.

Rules of thumb:

- Formatting uses tabs. Run `bun run format` (or let editor-on-save) instead of hand-aligning code.
- Prefer fixing the underlying issue over suppressing; when a warning is intentional (untyped CLI JSON envelopes, shell `${VAR}` strings, generated or deliberately malformed data), add a `// biome-ignore lint/<rule>: <reason>` comment on the line directly above the diagnostic.
- `a11y` rules are off globally because this is an OpenTUI terminal app, not a web page.
- Non-null assertions (`value!`) are banned by `style/noNonNullAssertion`. Replace them with a real guard (`if (!x) throw ...` / early return), a fallback (`??`), or restructure so the compiler narrows the value. If a case is genuinely unavoidable, add `// biome-ignore lint/style/noNonNullAssertion: <reason>` on the line directly above.
- `src/workflow/embedded.generated.ts` is excluded via config override; never hand-edit it or reformat it — regenerate with `bun run build`.
- Type checking stays with `bun run type-check` (`tsc --noEmit`); Biome does not replace it.

## Workflow architecture

See [`agentic-coding/docs/workflow-architecture.md`](agentic-coding/docs/workflow-architecture.md) for the workflow layer map and step checklist. Role knowledge belongs in `agentic-coding/src/workflow/steps/`; the engine, CLI, and dashboard must read registered step behavior rather than duplicate role tables.

## Workflow Effect conventions

The workflow layer is migrating toward Effect. The single guide for writing/editing workflow code is [`agentic-coding/docs/workflow-effect.md`](agentic-coding/docs/workflow-effect.md) (locked Effect 3.22.2; one idiom per operation/error/schema/service/scope/test boundary). The module/caller inventory and migration-only bridge list live in [`agentic-coding/docs/workflow-effect-migration.md`](agentic-coding/docs/workflow-effect-migration.md).

Exceptions, stated explicitly:

- **Pure domain stays plain TypeScript.** Graph/step/projection/formatting functions are not wrapped in Effect; do not add an `effect()` wrapper or service factory.
- **Durable outbox vs Effect programs differ.** Outbox records and the engine's durable retries are not generic `Effect.retry`; only a genuine `infrastructure` failure is retryable through the outbox, never a defect.
- **Native/Promise I/O belongs in boundary adapters** (`src/workflow/effects.ts`, `adapters.ts`), not a second orchestration style.

## TUI keybind help

Every keybind is declared once in a per-surface catalog and rendered from a
single shared contract (`src/tui/shared/keybinds.ts`). Entries are plain data
(`{ key, action, standard?, context? }`) — renderers own colors and separators,
so a keybind can never smuggle in styling. The footer advertises only special
keys (`standard` keys are hidden); the `?` help modal lists the whole catalog.

- Contract + reactive store: `src/tui/shared/keybinds.ts` (`Keybind`,
  `KeybindSection`, `setActiveKeybindCatalog`).
- Dashboard catalogs: `src/tui/dash/keybinds.ts` (overview + detail; detail
  entries carry a panel `context` so the footer changes with the focused
  panel).
- Shell/tab catalog: `observabilityKeybindCatalog()` in
  `src/tui/otel/app/keybinds.ts`, rendered by
  `src/tui/otel/components/StatusBar.tsx` (wrapped to the terminal width).
- `?` help: `src/tui/shared/HelpModal.tsx` renders the active catalog for both
  the shell tabs and the dashboard overview/detail.
- Modal/dialog footer: `HelpText` / `formatHelpTextLines`
  (`src/tui/shared/HelpText.tsx`).

**When you add or change a keybind, update the owning catalog and then open the
TUI to check the keybind help.** Confirm both the footer (special keys for the
active surface/panel) and the `?` help modal (every keybind, standard included)
list what you added, and mark pure navigation keys `standard: true` so they stay
out of the footer. Never print keybinding cheat sheets or "press X to …"
instructions inside tab content, panel bodies, headers, or empty/error states.
