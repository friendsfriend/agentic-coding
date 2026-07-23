# Herdr workflow agent launch

Launch every role with `herdr agent start`; never coordinate raw shell startup, text insertion, or Enter keys. Create topology first, then pass complete Pi arguments and initial prompt after `--` in same command: `herdr agent start <name> --kind pi --pane <pane-id> -- ... <initial prompt>`.

Planner, worker, recovery, and archive roles own separate tabs. Create labeled tab with role cwd and env, wait until returned root pane reports foreground shell, then start role in that pane. Retry `agent start` once only when Herdr reports target pane is not yet available shell.

Triage and all verifier roles share one `verification` tab. Start first role in new tab's returned root pane. For each additional role, split live sibling pane right with role cwd and env, wait for new shell pane, then start role there. If grouped agent state is unknown or missing, close only its pane; preserve sibling verification panes. Never reuse dashboard, git, worker, or other standalone tab as verification tab.

Send follow-up prompts with `herdr agent prompt <name-or-pane> <prompt>` only after `herdr agent get` confirms Pi process. If standalone agent state is unknown or missing, close its tab and start fresh role.
