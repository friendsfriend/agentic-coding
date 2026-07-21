# Herdr workflow agent launch

Launch a role in its own tab: create tab with `herdr tab create`, wait until `herdr pane process-info --pane <id>` reports a foreground shell, allow one short shell settle window, then issue one `herdr pane run <id> "pi ... <initial prompt>"` command.

Do not use `herdr agent start`: it creates a split instead of owning tab root. Do not send text then manually press Enter, retry Enter, or retry `ctrl+c`; those race Pi and shell startup. Do not run `pane run` immediately after tab creation: root shell can exist before terminal input is ready, dropping or pre-filling Pi command. Follow-up prompts use `herdr pane run <id> "prompt"` only after Pi is detected. If Pi state is unknown or missing, close its tab and spawn a fresh role.
