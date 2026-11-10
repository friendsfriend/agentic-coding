# Using logs and action history

DevEnv separates operational history from runtime logs.

## Action history

Press uppercase `L` from main table to open action history. Compact strip under table shows active, failed, and recent completed actions. Action modal contains commands, stdout, stderr, exit failures, nested steps, and retained history.

Use `j`/`k` to move, `J`/`K` to switch panels, and `Escape` or `L` to close.

## Runtime logs

Press lowercase `l` on selected application to inspect container/application runtime logs. Log viewer supports `/` search, scrolling, and visual selection. Kubernetes workload logs remain available from Kubernetes view.

Server diagnostic logging remains separate and does not create user-facing actions.
