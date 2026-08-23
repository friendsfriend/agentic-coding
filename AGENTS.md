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
