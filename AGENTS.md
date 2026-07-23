# Herdr workflow agent launch

Launch every role with `herdr agent start`; never coordinate raw shell startup, text insertion, or Enter keys. Pass Pi executable and complete initial prompt after `--` in same command.

Planner, worker, recovery, and archive roles own separate tabs. Create labeled container tab, wait until bootstrap pane reports foreground shell, start role with `herdr agent start <name> --tab <tab-id> --split right ... -- pi ... <initial prompt>`, then close bootstrap shell pane so agent owns tab root. Retry `agent start` once only when Herdr reports target pane is not yet available shell.

Triage and all verifier roles share one `verification` tab. Create labeled container tab for first role, wait for bootstrap shell, start it with `herdr agent start --tab <verification-tab-id> --split right`, then close bootstrap shell pane. Start each additional role with same tab ID and `--split right`. If grouped agent state is unknown or missing, close only its pane; preserve sibling verification panes. Never reuse dashboard, git, worker, or other standalone tab as verification tab.

Send follow-up prompts with `herdr agent send <name-or-pane> <prompt>` only after `herdr agent get` confirms Pi process. If standalone agent state is unknown or missing, close its tab and start fresh role.
