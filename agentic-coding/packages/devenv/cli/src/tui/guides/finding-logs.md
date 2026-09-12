# Finding logs and action history

## Operational history

Build, run, stop, test, infrastructure, Kubernetes, Git, worktree, and task operations appear in action history. Press uppercase `L` to open action modal. History is retained in DevEnv SQLite state for 24 hours.

Action modal is canonical source for executed commands, stdout, stderr, exit failures, nested steps, and errors. Compact strip shows status glyph and action label only.

## Remaining logs

Runtime and diagnostic logs remain separate:

- Application/container logs: available with lowercase `l`
- Kubernetes workload logs: available from Kubernetes view
- Server diagnostics: process output or configured server log destination
- Per-application runtime logs under `$DEVENV_HOME/logs/` where configured

Legacy `status.log` and temporary operation-log files are no longer created or read. Existing legacy files are inert and may be removed manually; DevEnv does not delete them during migration.
