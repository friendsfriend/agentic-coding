Not for agents. This is only for humans.

Fixes: 

Big ones:
* Make otel work for apps that are launched via the environment as well (Introduce Agent skill for setup)
* Agent skills to create the environments for a fresh app.
* Rework existing AI features using the workflow engine (ai summary for logs etc.)
* Introduce Verfication only workflow
* Introduce Rebase workflow
* Introduce dependency upgrade and migration workflow

Small ones: 
* Improve agent steering based on recent runs (observability first)
* JEV:
  * Compaction hints
  * Use jev to block bash commands that should be blocked


Pi durable rebuild:
* Models are not selectable yet
* Enter doenst work for the thinking selection
* Improve animation for working state. Make the pulse less prominent
* Build Workflows sidebar that shows the active workflows and lets me jump to it. -> Git panel will be removed so that no multiplexing is needed in the future.
* Go back to tmux for spawning side apps like lazygit and nvim and so on.
* remove multiplexing fully so that the user keeps the choice.
* Fully migrate to pi-durable
* Remove opencode and pi legacy support
