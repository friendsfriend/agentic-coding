# Tasks

## 1. Rewrite engine

- [ ] 1.1 Decide YAML strategy (Bun built-in vs targeted rewrite) with a short note in `design.md`; implement node-position-preserving edits for `container_name`, `ports`, `image`, `include` → `x-devenv-requires`, external network; verify on copies of every current compose shape in `test/fixtures/environment/templates/`.
- [ ] 1.2 Verify idempotence: converting a converted fixture yields zero edits.
- [ ] 1.3 Verify unrecognized shapes are reported and left byte-identical.

## 2. Command

- [ ] 2.1 Add `agentic-coding env migrate-templates [--apply] [--restore TS]` with dry-run plan output, protected backup and the running-instance writer guard; verify.

## 3. Validator

- [ ] 3.1 Add `agentic-coding env validate` and a server-side `validateTarget` reused by `add-environment-instances`' untemplated check; report templated / untemplated / needs-semantic-pass with reasons; verify each class.

## 4. Apply

- [ ] 4.1 Run the dry run against `~/.config/agentic-coding`, attach the plan to the workflow for developer review, and only then apply. Record the validator report.

## 5. Checks

- [ ] 5.1 Run `bun run lint`, `bun run type-check` and focused tests with zero diagnostics.
