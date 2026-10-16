# Test isolation

A test run must be able to write anywhere without touching the developer's own
state, and it must fail loudly when it cannot. `bun test` pollutes nothing; this
is how that is arranged and what to do when it breaks.

## The contract

Every location a test process can write to is a throwaway directory that the
process removes when it ends. `test/support/isolate-config-root.ts` (the
`[test] preload` in `bunfig.toml`) installs that, unconditionally — an ambient
value never decides what a test sees:

| Location | Points at | Why it matters |
| --- | --- | --- |
| `AGENTIC_CODING_CONFIG_DIR` | the sandbox itself | The developer's own `.env` and classifier selection must not decide how a test resolves a provider. |
| `HERDR_WIKI_DIR` | `<sandbox>/wiki` | The wiki bundle *and* the workflow data root, which is the bundle's parent directory plus `.agentic-coding-workflow`. This is the location the workflow store and the workflow target registry live in — the registry the dashboard reads on every refresh. |
| `HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` | `<sandbox>/home` | `~/devenv/logs`, `~/.config/otel-tui`, `~/.local/share/*`, `~/.pi/agent`. |
| `TMPDIR` | `<sandbox>/tmp` | Every `mkdtempSync(os.tmpdir(), …)`, so a temporary repository a test forgets to remove is swept with the sandbox. |
| `HERDR_WORKFLOW_CONFIG`, `AGENTIC_WORKFLOW_URL`, `AGENTIC_WORKFLOW_TOKEN` | deleted | An explicit replacement configuration bypasses the isolated root, and the runner exports a *live* server handoff to the children it manages. |

One gap is stated rather than papered over. Bun captures `HOME` when the process
starts, so a later `process.env.HOME` is invisible to `os.homedir()`
(measured). A bare `bun test <file>` therefore still *reads* the developer's home
for the few paths derived from it. Two things cover it: `bun run test`
(`scripts/test.ts`) launches every job with its own `HOME`, and the preload
counts the developer's workflow target registry before and after the run and
fails the run if it grew (`test/support/real-config-guard.ts`). The check only
counts marker files and never writes, so it is safe to run against a real
configuration directory.

## Running tests

Use `bun run test` for the whole suite and `bun run test <file>` for a focused
run; both go through `scripts/test.ts`, which owns the per-job configuration
root, wiki root and home directory. When running `bun test` directly, set the
locations yourself:

```sh
HOME=$(mktemp -d) TMPDIR=$(mktemp -d) AGENTIC_CODING_CONFIG_DIR=$(mktemp -d) \
  HERDR_WIKI_DIR=$(mktemp -d) bun test test/workflow-wiki.test.ts
```

`AGENTIC_CODING_TEST_KEEP_TEMP=1` keeps the sandbox and prints its path, which
is how a leaked temporary directory is inspected: the sweep is what normally
makes it invisible.

## Adding a test that starts a workflow

A workflow's rows live in `<target>/.herdr-workflow/`, so a temporary repository
a test starts a workflow in is a real, growing artifact. Register its teardown
with the file's own scope — a module-scope `afterAll` in the test file, or the
tracker helpers in `test/support/git-fixture.ts` (`createTempRepoFixture` +
`autoRemoveRepoFixtures`) — never in a shared module, whose hook belongs to
whichever file imported it first.

## What a run is allowed to leave

Nothing, except the shared repository-template store
(`$TMPDIR/agentic-coding-repo-templates`, published atomically and deliberately
machine-wide so a fixture is built once instead of five Git children per file)
and the engine's own `.herdr-workflow/` directory in the checkout. Anything else
is a leak: report it with the path it was written to.

## Related

- `test/support/isolate-config-root.ts` — the preload that installs the contract.
- `test/support/real-config-guard.ts` — the before/after registry check.
- `test/config-isolation.test.ts` — the resolution half of the guard: every
  workflow location must resolve inside the isolated configuration root.
- `scripts/test.ts` — the per-job launcher (`HOME`, configuration root, wiki
  root, watchdog, failure capture).
