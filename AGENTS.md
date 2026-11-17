# Biome linting and formatting

The `agentic-coding/` package uses Biome as its single linter, import organizer, and formatter (config: `agentic-coding/biome.json`). Do not introduce eslint or prettier; Biome covers both roles.

Run from `agentic-coding/`:

- `bun run lint` — check for lint, formatting, and import-order issues (must pass with zero diagnostics before finishing any change).
- `bun run type-check` — the whole-project type gate (`tsc --noEmit`), which Biome does not replace. It is part of finishing a change, not only of starting one: it must end with 0 errors, and a focused test run is not a substitute for it.
- `bun run format` — rewrite files in place to fix formatting only.
- `bunx biome check --write .` — apply safe fixes (formatting, imports); add `--unsafe` for fixable lint issues, then review the diff.

Rules of thumb:

- Formatting uses tabs. Run `bun run format` (or let editor-on-save) instead of hand-aligning code.
- Prefer fixing the underlying issue over suppressing; when a warning is intentional (untyped CLI JSON envelopes, shell `${VAR}` strings, generated or deliberately malformed data), add a `// biome-ignore lint/<rule>: <reason>` comment on the line directly above the diagnostic.
- `a11y` rules are off globally because this is an OpenTUI terminal app, not a web page.
- Non-null assertions (`value!`) are banned by `style/noNonNullAssertion`. Replace them with a real guard (`if (!x) throw ...` / early return), a fallback (`??`), or restructure so the compiler narrows the value. If a case is genuinely unavoidable, add `// biome-ignore lint/style/noNonNullAssertion: <reason>` on the line directly above.
- `src/workflow/embedded.generated.ts` is excluded via config override; never hand-edit it or reformat it — regenerate with `bun run build`.

## Testing scope

Keep tests small and functional. Test observable behavior and user-facing outcomes, not the implementation itself.

- Prefer a few representative scenarios through public boundaries: a feature works, a meaningful failure is handled, and critical safety or ownership guarantees hold.
- Do not add tests merely to mirror helpers, private state, compiled-plan layout, internal ordering, exact argv, or every validation branch. Assert such details only when they are themselves an externally required contract.
- Use lightweight disposable fixtures or fakes at external boundaries when needed. Do not build an elaborate simulation of the implementation just to test it.
- Avoid redundant cases, exhaustive permutations and coverage-padding tests. Extend an existing functional scenario when that is enough.
- Keep verification claims honest: passing fake-backed tests does not establish compatibility with a live runtime. Do not use real credentials, model calls, running apps or live infrastructure without explicit authorization.
- This scope does not replace the required lint and whole-project type-check gates above.

## Test suite cost strategy (agentic-coding-v2)

The default suite must stay fast: the whole run is the inner loop, so a test that
costs seconds is a design smell. The strategy is unit-first and it is expected to
continue in this direction.

- Unit-test the rule, not the wiring. Parsers, windowing/cursor math, argv
  construction, validation and refusal tables, redaction and formatting belong in
  direct tests of the pure function (`test/compose-values.test.ts`,
  `test/diagnostic-history.test.ts`, `test/presentation-rules.test.ts`).
- Keep at most one representative scenario per boundary. Never repeat a boundary
  for each input permutation, engine, provider or refusal variant, and never stand
  up a runtime, gateway, engine, database, cluster or receiver to re-prove what a
  pure function already decides.
- Assume simple plumbing is correct. Container/Compose/Kubernetes/HTTP mechanics
  that the underlying tool guarantees are not re-proven by tests.
- Never wait out a product deadline, expiry window or slow-response timer, and
  never add a shorter production deadline to make a test faster. Wait for a
  specific observable event; an arbitrary sleep or a prescribed number of polling
  iterations is not an assertion.
- Do not raise timeouts, add retries, exclude files or enable unsafe concurrency to
  make a slow suite look fast.
- When a suite is deleted rather than converted, record in the project docs which
  guarantee is no longer asserted automatically and is now reviewed by hand. Keep
  the trade explicit; do not claim coverage that no longer exists.
- Measure the complete suite after a batch of changes, not after every edit, and
  report runtime and failures together.

## Workflow architecture

See [`agentic-coding/docs/workflow-architecture.md`](agentic-coding/docs/workflow-architecture.md) for the workflow layer map and step checklist. Role knowledge belongs in `agentic-coding/src/workflow/steps/`; the engine, CLI, and dashboard must read registered step behavior rather than duplicate role tables.

## Workflow Effect conventions

The workflow layer is migrating toward Effect. The single guide for writing/editing workflow code is [`agentic-coding/docs/workflow-effect.md`](agentic-coding/docs/workflow-effect.md) (locked Effect 4.0.6; one idiom per operation/error/schema/service/scope/test boundary). The module/caller inventory and migration-only bridge list live in [`agentic-coding/docs/workflow-effect-migration.md`](agentic-coding/docs/workflow-effect-migration.md).

Exceptions, stated explicitly:

- **Pure domain stays plain TypeScript.** Graph/step/projection/formatting functions are not wrapped in Effect; do not add an `effect()` wrapper or service factory.
- **Durable outbox vs Effect programs differ.** Outbox records and the engine's durable retries are not generic `Effect.retry`; only a genuine `infrastructure` failure is retryable through the outbox, never a defect.
- **Native/Promise I/O belongs in boundary adapters** (`src/workflow/effects.ts`, `adapters.ts`), not a second orchestration style.

## TUI keybind help

Every keybind is declared once in a per-surface catalog and rendered from a
single shared contract (`src/tui/shared/keybinds.ts`). Entries are plain data
(`{ key, action, short?, standard?, context? }`) — renderers own colors and
separators, so a keybind can never smuggle in styling. The footer advertises
only special keys (`standard` keys are hidden); the `?` help modal lists the
whole catalog.

Label rules:

- `short` is the compact one-word footer label (e.g. `filter`); the footer
  shows `short ?? action`, while the `?` help modal and modals show the full
  `action`. Use `short` whenever `action` is a phrase, not a single word.
- A shifted letter is written as the uppercase letter, never as `Shift+<x>`:
  `T` (theme), `J/K/H/L` (panels), `O` (sort). True modifier combos keep the
  prefix (`Ctrl+Shift+C`, `Alt+Enter`).

- Contract + reactive store: `src/tui/shared/keybinds.ts` (`Keybind`,
  `keybindFooterLabel`, `KeybindSection`, `setActiveKeybindCatalog`).
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
